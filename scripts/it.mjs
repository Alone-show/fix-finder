/**
 * 真实环境验收脚本（只读 alist）：
 *   node scripts/it.mjs              # 用现有索引跑验收
 *   node scripts/it.mjs --sync       # 先全量同步再验收
 *   node scripts/it.mjs --sync --only SP2-10PRO   # 只同步匹配的产品线
 *   node scripts/it.mjs --reset      # 清掉旧格式索引（v1）后重建
 */
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

import { createAlistClient } from '../lib/alist.js';
import { runSync } from '../lib/sync.js';
import { loadIndex, loadMeta, loadCommits, INDEX_VERSION } from '../lib/store.js';
import { loadKeywords, coverageOf } from '../lib/search.js';
import { executeCheck } from '../lib/check.js';
import { buildMatrix } from '../lib/matrix.js';
import { resolveModel, probeModel } from '../lib/models.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const WORKSPACE = path.resolve(ROOT, '..', '..');
const args = process.argv.slice(2);
const has = (flag) => args.includes(flag);
const valueOf = (flag) => {
  const i = args.indexOf(flag);
  return i >= 0 ? args[i + 1] : undefined;
};

const dataDir = process.env.DSH_FIXFINDER_DIR || path.join(WORKSPACE, '.fixfinder');
fs.mkdirSync(path.join(dataDir, 'raw'), { recursive: true });
fs.mkdirSync(path.join(dataDir, 'parsed'), { recursive: true });
process.env.DSH_FIXFINDER_DIR = dataDir;

const checks = [];
const check = (label, ok, detail = '') => {
  checks.push({ label, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `  ${detail}` : ''}`);
};

function finish() {
  const failed = checks.filter((c) => !c.ok);
  console.log(`\n${checks.length - failed.length}/${checks.length} 通过`);
  if (failed.length) process.exitCode = 1;
}

function dirSize(dir) {
  let total = 0;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const target = path.join(dir, entry.name);
    total += entry.isDirectory() ? dirSize(target) : fs.statSync(target).size;
  }
  return total;
}

async function main() {
  if (has('--reset')) {
    for (const name of ['index.json', 'commits.json']) {
      const file = path.join(dataDir, name);
      if (fs.existsSync(file)) fs.rmSync(file);
    }
    const parsed = path.join(dataDir, 'parsed');
    for (const file of fs.readdirSync(parsed)) fs.rmSync(path.join(parsed, file));
    console.log(`已清理旧索引：${dataDir}`);
  }

  if (has('--sync')) {
    console.log(`同步中（only=${valueOf('--only') || '全部 PROD 正式版'}）…`);
    const client = createAlistClient();
    const started = Date.now();
    const res = await runSync({
      ctx: { get: () => undefined },
      exec: {},
      client,
      force: has('--force'),
      only: valueOf('--only') || null,
      concurrency: 4,
      onProgress: (p) => {
        if (p.updated % 20 === 0) process.stderr.write(`  已更新 ${p.updated}/${p.total}\n`);
      },
    });
    console.log(`同步完成：${res.stats.updated} 更新 / ${res.stats.skipped} 跳过 / ${res.stats.failed} 失败，耗时 ${((Date.now() - started) / 1000).toFixed(1)}s`);
    console.log(`索引：${res.index.lineCount} 条线 / ${res.index.commitCount} 个去重提交，芯片=${JSON.stringify(res.index.platformBreakdown)} OS=${JSON.stringify(res.index.osBreakdown)}`);
    if (res.failures?.length) {
      console.log(`失败样例：${JSON.stringify(res.failures.slice(0, 5))}`);
    }
  }

  const index = await loadIndex(dataDir);
  check('索引存在且为 v2', !!index && index.version === INDEX_VERSION, dataDir);
  if (!index) return finish();

  check('只含 PROD 线', index.lines.every((line) => line.stage === 'PROD'));
  check('只含正式版构建', index.lines.every((line) => line.buildKind === 'release'));
  check('产品线数量 >= 40（PROD-only）', index.lineCount >= 40, `lineCount=${index.lineCount}`);
  check('提交去重后 >= 3000', index.commitCount >= 3000, `commitCount=${index.commitCount}`);
  check('存在 commits.json（提交正文只存一份）', fs.existsSync(path.join(dataDir, 'commits.json')));
  const table = await loadCommits(dataDir);
  check('commits.json 条目数 = index.commitCount', Object.keys(table).length === index.commitCount, `${Object.keys(table).length}`);
  const sizeMB = dirSize(dataDir) / 1e6;
  check('数据目录 < 8MB（去重后）', sizeMB < 8, `${sizeMB.toFixed(2)}MB`);

  // 1) 机型探测：拼写/别名/歧义/芯片隔离
  const p1 = resolveModel(index, { model: 'SPRING2PRO', platform: 'RK' });
  check('SPRING2PRO -> SP2-10PRO（gap）', p1.status === 'ok' && p1.resolved.product === 'SP2-10PRO', `${p1.status}/${p1.resolved?.product}/${p1.matchKind}/${p1.score}`);
  const p2 = resolveModel(index, { model: 'SPRING2-10PRO' });
  check('SPRING2-10PRO -> SP2-10PRO（别名）', p2.status === 'ok' && p2.resolved.product === 'SP2-10PRO', `${p2.status}/${p2.resolved?.product}`);
  const p3 = resolveModel(index, { model: 'SP2-10', platform: 'RK' });
  check('SP2-10 有歧义 -> ambiguous', p3.status === 'ambiguous', p3.candidates?.map((c) => c.product).join(','));
  const p4 = resolveModel(index, { model: 'SPRING2', platform: 'T3' });
  check('T3 芯片不顶替 RK 结果', p4.status === 'not_found', `${p4.status}/${p4.reason}`);

  // 2) fix_check：CIF 空指针（跨机型）
  const dict = loadKeywords(dataDir);
  const bug = 'G3 摄像头没有可用的数据，一直有问题，必须重启才能恢复，怀疑是内核空指针';
  const evaluated = executeCheck({
    index,
    dictionary: dict,
    dataDir,
    args: {
      bug,
      model: 'SP2-10PRO',
      customer: 'CP',
      currentVersion: 'CP_SP2-10PRO_D_DEV-DE9E2564_LCD10_B0_EU_20260825',
    },
  });
  const top = evaluated.candidates[0];
  console.log(`\n[CIF 用例] verdict=${evaluated.verdict} resolved=${evaluated.resolvedModel}/${evaluated.platform}`);
  for (const c of evaluated.candidates.slice(0, 5)) {
    console.log(`  - ${c.hash} ${c.date} [${c.score}] ${c.subject}`);
  }
  check('CIF 用例命中候选', evaluated.candidates.length > 0);
  check('CIF 用例候选包含 92cf9c82', evaluated.candidates.some((c) => c.hash === '92cf9c82'));
  check('CIF 用例机型已归一', evaluated.resolvedModel === 'SP2-10PRO');

  // 3) fix_check：摄像头断层（应判定已进客户正式版）
  const tearing = executeCheck({
    index,
    dictionary: dict,
    dataDir,
    args: { bug: 'camera 热插拔出现图像断层', model: 'SPRING2PRO', os: 'DEBIAN', customer: 'CP' },
  });
  console.log(`\n[断层用例] verdict=${tearing.verdict} resolved=${tearing.resolvedModel}/${tearing.platform}`);
  for (const c of tearing.candidates.slice(0, 5)) {
    console.log(`  - ${c.hash} ${c.date} [${c.score}] ${c.subject}  正式版=${c.releasedIn?.build || '-'}`);
  }
  check('断层用例机型归一为 SP2-10PRO', tearing.resolvedModel === 'SP2-10PRO');
  check('断层用例判定 fixed_released', tearing.verdict === 'fixed_released', tearing.verdict);
  check('断层用例命中 DO-7778/8b959775 且已进正式版', tearing.candidates.some((c) => c.hash === '8b959775' && c.releasedIn));
  check('客户线已含修复清单非空', (tearing.customerLineHits || []).length > 0);

  // 4) 覆盖矩阵（只含 PROD）
  const matrix = buildMatrix(index, { ticket: 'DO-7778', platform: 'RK' });
  check('矩阵能定位到 SP2-10PRO 行', matrix.rows.some((r) => r.contained && r.product === 'SP2-10PRO'));
  check('矩阵行全部为 PROD', matrix.rows.every((r) => r.stage === 'PROD'));

  const cov = coverageOf(index, index.commits['8b959775']?.lines || []);
  console.log(`\n[覆盖] 按芯片：${cov.byPlatform.map((p) => `${p.platform} ${p.contained}/${p.total}`).join(' | ')}`);
  console.log(`[覆盖] 按 OS：${cov.byOS.map((o) => `${o.os} ${o.contained}/${o.total}`).join(' | ')}`);
  check('8b959775 覆盖到 RK/DEBIAN', cov.byOS.some((o) => o.os === 'DEBIAN' && o.contained > 0));

  // 5) 索引元信息
  const meta = await loadMeta(dataDir);
  check('meta 已写入', !!meta.syncedAt, meta.syncedAt || '');
  check('meta 只有 PROD 线', Object.values(meta.lines).every((line) => line.stage === 'PROD'));

  finish();
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
