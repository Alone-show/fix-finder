/**
 * 索引同步：遍历 PROD 下所有产品线，只下载每条线「最新正式构建」的 commit-logs.txt。
 * 因为 commit log 是该分支的累积全量历史，所以只取最新一版即可覆盖全部提交。
 *
 * 存储：每条线只写 hash 数组（parsed/），提交正文攒成一张去重表（commits.json），
 * 由 store.rebuildIndex 统一写入并裁掉没人引用的条目。
 */
import fs from 'node:fs';
import { joinPath } from './alist.js';
import { discoverLines, mapPool } from './discover.js';
import { parseCommitLog } from './parse.js';
import * as store from './store.js';

const DEFAULT_CONCURRENCY = 4;
const COMMIT_FIELDS = ['date', 'time', 'author', 'subject', 'scope', 'ticket', 'kind', 'revert'];

function summarize(index) {
  return {
    generatedAt: index.generatedAt,
    lineCount: index.lineCount,
    commitCount: index.commitCount,
    platformBreakdown: (index.lines || []).reduce((acc, line) => {
      acc[line.platform] = (acc[line.platform] || 0) + 1;
      return acc;
    }, {}),
    osBreakdown: (index.lines || []).reduce((acc, line) => {
      acc[line.os] = (acc[line.os] || 0) + 1;
      return acc;
    }, {}),
  };
}

function slim(commit) {
  const out = {};
  for (const key of COMMIT_FIELDS) out[key] = commit[key] ?? (key === 'revert' ? false : '');
  return out;
}

export async function runSync({ ctx, exec, client, force = false, only = null, concurrency = DEFAULT_CONCURRENCY, onProgress } = {}) {
  const dir = await store.resolveDataDir(ctx, exec);
  const meta = await store.loadMeta(dir);

  const discovered = await discoverLines({ client, concurrency: 6 });
  const matcher = only ? new RegExp(String(only), 'i') : null;
  const targets = discovered.lines.filter((line) => (matcher ? matcher.test(line.id) : true));

  const stats = { discovered: discovered.lines.length, targeted: targets.length, updated: 0, skipped: 0, failed: 0 };
  const updatedLines = [];
  const failureDetails = [...discovered.failures];
  const merge = {};

  await mapPool(
    targets,
    concurrency,
    async (line) => {
      const previous = meta.lines[line.id];
      if (!force && previous && previous.build === line.build) {
        stats.skipped += 1;
        return;
      }
      try {
        const logPath = joinPath(line.dir, line.build, 'commit-logs.txt');
        const text = await client.readText(logPath);
        const commits = parseCommitLog(text);
        if (!commits.length) throw new Error('commit-logs.txt 解析出 0 条提交');
        let tip = line.buildCommit || '';
        try {
          const tipText = await client.readOptionalText(joinPath(line.dir, line.build, 'latest-commit-id.txt'));
          if (tipText && tipText.trim()) tip = tipText.trim();
        } catch {
          /* tip 可选 */
        }

        const hashes = [];
        for (const commit of commits) {
          if (!commit.hash) continue;
          hashes.push(commit.hash);
          if (!merge[commit.hash]) merge[commit.hash] = slim(commit);
        }

        await store.writeText(store.paths.raw(dir, line.id), text);
        await store.writeParsed(dir, line.id, [...new Set(hashes)]);
        meta.lines[line.id] = {
          ...line,
          tip,
          commitCount: hashes.length,
          fetchedAt: new Date().toISOString(),
          error: '',
        };
        stats.updated += 1;
        updatedLines.push({ line: line.id, build: line.build, platform: line.platform, commits: hashes.length });
        onProgress?.({ line: line.id, commits: hashes.length, updated: stats.updated, total: targets.length });
      } catch (err) {
        stats.failed += 1;
        const message = err?.message || String(err);
        failureDetails.push({ line: line.id, build: line.build, error: message });
        if (previous) meta.lines[line.id] = { ...previous, error: message };
      }
    },
    (line, err) => {
      stats.failed += 1;
      failureDetails.push({ line: line.id, error: err?.message || String(err) });
    },
  );

  // 已经不在发现列表里的线（例如从 120 条线的 TEST+PROD 迁移到 67 条 PROD 线）要清掉，
  // 连 raw/parsed 落盘文件一起删，否则磁盘上会残留已废弃的 TEST 日志。
  const alive = new Set(discovered.lines.map((line) => line.id));
  for (const id of Object.keys(meta.lines)) {
    if (alive.has(id)) continue;
    delete meta.lines[id];
    for (const file of [store.paths.raw(dir, id), store.paths.parsed(dir, id)]) {
      await fs.promises.rm(file, { force: true }).catch(() => {});
    }
  }

  meta.syncedAt = new Date().toISOString();
  meta.failures = [...new Map(failureDetails.map((f) => [`${f.line || ''}|${f.dir || ''}|${f.error}`, f])).values()].slice(0, 50);
  await store.saveMeta(dir, meta);

  const index = await store.rebuildIndex(dir, meta, { merge });

  return {
    dir,
    stats,
    updatedLines: updatedLines.slice(0, 20),
    failures: failureDetails.slice(0, 20),
    index: summarize(index),
  };
}
