/**
 * @local/fix-finder —— 判断某个 bug 是否已被修复。
 *
 * 数据来源：https://alist.cpinnov.run 的 /PROD/<芯片>/<系统> 下每条产品线最新一版**正式构建**的
 * commit-logs.txt（累积全量 git log）。只索引 PROD：数据量小一半，且「是否已修复」只关心正式版。
 *
 * 使用顺序：fix_models 探测机型写法 -> fix_check 判定；需要看原文时用 fix_log。
 * 芯片（platform）是一等维度：不同芯片的同名机型绝不互相顶替。
 */
import { createAlistClient } from './lib/alist.js';
import { runSync } from './lib/sync.js';
import * as store from './lib/store.js';
import { loadKeywords, VERDICTS } from './lib/search.js';
import { buildMatrix } from './lib/matrix.js';
import { executeCheck } from './lib/check.js';
import { buildCatalog, probeModel, platformsOf } from './lib/models.js';
import { collectCommits } from './lib/log.js';

/* ------------------------------------------------------------------ *
 * 公共小工具
 * ------------------------------------------------------------------ */

function jsonSafe(value) {
  if (Array.isArray(value)) return value.map(jsonSafe);
  if (value && typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) if (v !== undefined) out[k] = jsonSafe(v);
    return out;
  }
  return value;
}

const VERDICT_LABEL = {
  fixed_released: '已修复，并且已进入客户产品线的正式版',
  fixed_other_line_only: '疑似修复只在其它产品线上出现，客户产品线未合入',
  found_unscoped: '找到疑似修复，但未指定机型，无法判断是否已进入客户产品线',
  needs_model: '机型没能唯一确定（拼写歧义/不存在），需要先确认机型写法',
  needs_baseline: '机型已确定，但该芯片+客户+系统没有对应的产品线',
  not_found: '未找到匹配的修复提交',
};

const NEEDS_SYNC_HINT = '还没有本地索引（或索引格式已升级）。先调用 fix_sync 重建（只抓 PROD 正式版，冷同步约 5–10 秒）。';

async function loadIndexOrNull(ctx, exec) {
  const dir = await store.resolveDataDir(ctx, exec);
  const index = await store.loadIndex(dir);
  return { dir, index };
}

/* ------------------------------------------------------------------ *
 * 工具：fix_check
 * ------------------------------------------------------------------ */

function checkToolFor(ctx) {
  return {
    name: 'fix_check',
    description:
      '判断某个 bug/现象是否已被修复：先做机型探测（拼写/别名/省略尺寸段都能归一，探测不唯一时要求确认），再把现象描述在本地索引里按自然语言相似度检索，返回疑似修复提交、是否已进入客户产品线的正式版、以及其它机型/系统/芯片是否做了同样修改。数据来自 alist 各产品线最新正式构建的 commit-logs.txt（累积全量 git log，只索引 PROD）。传了 currentVersion 时会先剔除「现网包已经包含的老提交」。首次使用先调 fix_sync；想看原文提交清单用 fix_log。结论是「疑似」，需要研发复核代码；日志只有标题没有 diff。',
    parameters: {
      type: 'object',
      properties: {
        bug: { type: 'string', description: 'bug 现象描述，如「G3 摄像头没有数据，必须重启才恢复」「开机后触摸没反应」' },
        ticket: { type: 'string', description: '可选。内部工单号，如 DO-8486；也可直接写进 bug 文本里' },
        model: { type: 'string', description: '可选。机型，如 SP2-10PRO、MEGA1、APOLLO2-12PRO；写错/写简称会自动归一（SPRING2PRO → SP2-10PRO）' },
        platform: { type: 'string', description: '可选。芯片，如 RK、T3、SC60。不同芯片的同名机型互相隔离，不会顶替' },
        customer: { type: 'string', description: '可选。客户ID，默认 CP（从平基线）' },
        os: { type: 'string', description: '可选。限制操作系统：DEBIAN / ANDROID / LINUX' },
        currentVersion: {
          type: 'string',
          description: '可选。客户现网固件版本串，如 CP_SP2-10PRO_D_DEV-DE9E2564_LCD10_B0_EU_20260825，用于判断现网包是否已包含修复',
        },
        scope: {
          type: 'string',
          enum: ['auto', 'local', 'kernel'],
          description: 'auto=自动判断（默认），local=只看本系统，kernel=按内核/驱动类问题强制做跨 OS 对比',
        },
        keywords: {
          type: 'array',
          items: { type: 'string' },
          description: '可选。手工补充关键词（会与词典命中的词合并，用于加分与命中展示）',
        },
        limit: { type: 'integer', description: '返回候选数量上限，默认 8，最大 20' },
      },
      required: ['bug'],
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          status: { type: 'string', enum: ['ok', 'needs_sync', 'needs_keywords', 'needs_confirmation', 'error'] },
          verdict: { type: 'string', enum: VERDICTS },
          kernel: { type: 'boolean' },
          resolvedModel: { type: 'string' },
          platform: { type: 'string' },
          query: { type: 'object' },
          baseline: { type: 'object' },
          modelProbe: { type: 'object' },
          customerLines: { type: 'array', items: { type: 'object' } },
          candidates: { type: 'array', items: { type: 'object' } },
          alreadyIncluded: { type: 'array', items: { type: 'object' } },
          alreadyIncludedCount: { type: 'integer' },
          customerLineHits: { type: 'array', items: { type: 'object' } },
          coverage: { type: 'object' },
          notes: { type: 'array', items: { type: 'string' } },
          index: { type: 'object' },
          dataDir: { type: 'string' },
          message: { type: 'string' },
          hint: { type: 'string' },
        },
        required: ['status'],
        additionalProperties: true,
      },
      render: (_args, value) => [{ type: 'text', text: renderCheck(value) }],
    },
    async execute(args, exec) {
      try {
        const { dir, index } = await loadIndexOrNull(ctx, exec);
        if (!index) return { status: 'needs_sync', verdict: 'not_found', hint: NEEDS_SYNC_HINT, dataDir: dir };
        const dictionary = loadKeywords(dir);
        return jsonSafe(executeCheck({ index, dictionary, args, dataDir: dir }));
      } catch (err) {
        return { status: 'error', message: err?.message || String(err) };
      }
    },
  };
}

function renderProbe(v) {
  const probe = v.modelProbe;
  if (!probe) return [];
  const lines = [];
  if (probe.status === 'ok') {
    const alias = probe.input && probe.input !== probe.resolved ? `${probe.input} → ${probe.resolved}` : probe.resolved;
    lines.push(`机型：${alias}（芯片 ${probe.platform}，${probe.matchKind} ${probe.score} 分）`);
    return lines;
  }
  lines.push(`机型探测：${probe.input || '-'}（${probe.status === 'ambiguous' ? '存在多个候选' : '未命中'}）`);
  probe.candidates.forEach((c) => {
    const alias = c.osList?.join('/') || '-';
    const cust = c.customers?.join('/') || '-';
    const latest = c.latest ? `最新 ${c.latest.buildDate}` : '';
    lines.push(`  - ${c.platform} / ${c.product}  [${c.matchKind} ${c.score} 分]  ${c.lineCount} 条线  ${alias}  ${cust}  ${latest}`);
  });
  if (probe.availableCustomers?.length) {
    lines.push(`  现有客户：${probe.availableCustomers.join('/')}；现有系统：${probe.availableOS.join('/') || '-'}`);
  }
  return lines;
}

function renderCheck(v) {
  if (v.status === 'needs_sync') return `还没有本地索引。${v.hint || ''}`;
  if (v.status === 'needs_keywords') return `无法检索。${v.hint || ''}`;
  if (v.status === 'error') return `fix_check 出错：${v.message}`;

  const lines = [];
  if (v.status === 'needs_confirmation') {
    lines.push(`结论：${v.verdict} —— ${VERDICT_LABEL[v.verdict] || v.verdict}`);
    lines.push(...renderProbe(v));
    lines.push('');
    for (const note of v.notes || []) lines.push(`· ${note}`);
    if (v.hint) lines.push('', v.hint);
    if (v.index) lines.push(`索引：${v.index.lineCount} 条线 / ${v.index.commitCount} 个提交，${v.index.ageHours} 小时前（${v.index.stale ? '已过期，建议 fix_sync' : '新鲜'}）`);
    return lines.join('\n');
  }

  lines.push(`结论：${v.verdict} —— ${VERDICT_LABEL[v.verdict] || v.verdict}`);
  if (v.kernel) lines.push('类型：内核/驱动类问题（已做跨 OS 对比）');
  lines.push(...renderProbe(v));

  const q = v.query || {};
  const parts = [];
  if (q.tickets?.length) parts.push(`工单 ${q.tickets.join(', ')}`);
  if (q.hashes?.length) parts.push(`hash ${q.hashes.join(', ')}`);
  if (q.tokens?.length) parts.push(`关键词 ${q.tokens.slice(0, 8).join('/')}`);
  lines.push(`检索：${parts.join(' | ') || '-'}`);
  if (v.baseline?.raw) lines.push(`现网基线：${v.baseline.raw}（构建日期 ${v.baseline.date || '未知'}）`);
  if (v.customerLines?.length) {
    lines.push(
      `客户线：${v.customerLines
        .map((l) => `${l.platform}/${l.os}/${l.product}/${l.customer} ${l.stage} ${l.buildDate}`)
        .join('；')}`,
    );
  }
  lines.push('');

  if (!v.candidates?.length) {
    lines.push('未命中任何提交。建议换更具体的现象词、补工单号/hash，或用 fix_log 直接看该机型全部提交标题。');
  } else {
    lines.push(`候选修复提交（${v.candidates.length}，按自然语言相似度）：`);
    v.candidates.slice(0, 6).forEach((c, i) => {
      lines.push(`[${i + 1}] ${c.hash || '(无hash)'}  ${c.date}  ${c.author}  [分数 ${c.score}]`);
      lines.push(`    ${c.subject}`);
      if (c.hits?.length) lines.push(`    命中：${c.hits.join(', ')}`);
      const placement = [...new Set((c.lines || []).map((l) => `${l.platform}/${l.os}/${l.product}(${l.customer})`))];
      if (placement.length) lines.push(`    落点：${placement.join('；')}${c.lineCount > placement.length ? ` …共 ${c.lineCount} 条线` : ''}`);
      if (c.releasedIn) lines.push(`    客户线正式版：${c.releasedIn.build}（${c.releasedIn.buildDate}）`);
      else lines.push('    客户线：未合入');
      lines.push('');
    });
  }

  if (v.customerLineHits?.length) {
    lines.push(`客户线已含该修复的候选（${v.customerLineHits.length}）：`);
    for (const hit of v.customerLineHits) {
      lines.push(`  ${hit.hash} ${hit.date} 【${hit.score} 分】 ${hit.subject}`);
      lines.push(`    → ${hit.releasedIn.build}（${hit.releasedIn.buildDate}）`);
    }
    lines.push('');
  }

  if (v.alreadyIncluded?.length) {
    const total = v.alreadyIncludedCount ?? v.alreadyIncluded.length;
    lines.push(`已排除（早于现网构建、现网包内已有）：${total} 条（列出前 ${Math.min(4, v.alreadyIncluded.length)} 条）`);
    for (const c of v.alreadyIncluded.slice(0, 4)) lines.push(`  ${c.hash} ${c.date} ${c.subject}`);
    lines.push('');
  }

  if (v.coverage?.byOS?.length) {
    const os = v.coverage.byOS.map((o) => `${o.os} ${o.contained}/${o.total} 条线`).join(' | ');
    lines.push(`跨 OS 覆盖：${os}`);
    const plat = (v.coverage.byPlatform || []).map((p) => `${p.platform} ${p.contained}/${p.total} 条线`).join(' | ');
    if (plat) lines.push(`按芯片：${plat}`);
    const synced = (v.coverage.byModel || [])
      .filter((m) => m.contained?.length)
      .map((m) => `${m.product}(${m.platform}/${m.os})`);
    if (synced.length) lines.push(`已同步机型：${synced.join('、')}`);
  }

  for (const note of v.notes || []) lines.push(`· ${note}`);
  if (v.index) lines.push(`索引：${v.index.lineCount} 条线 / ${v.index.commitCount} 个提交，${v.index.ageHours} 小时前（${v.index.stale ? '已过期，建议 fix_sync' : '新鲜'}）`);
  return lines.join('\n');
}

/* ------------------------------------------------------------------ *
 * 工具：fix_models
 * ------------------------------------------------------------------ */

function modelsToolFor(ctx) {
  return {
    name: 'fix_models',
    description:
      '机型探测：把用户写的机型名归一化到索引里的规范写法（处理拼写、别名 SP2/SPRING2、省略尺寸段 SPRING2PRO → SPRING2-10PRO），返回芯片、系统、客户、产线条数与最新正式版；不传 model 时列出索引内全部机型族。探测不唯一时会返回候选列表，必须先确认再调 fix_check。不同芯片的同名机型互相隔离。',
    parameters: {
      type: 'object',
      properties: {
        model: { type: 'string', description: '可选。机型，自由写法：SPRING2PRO、apollo 12 pro、SP2-10PRO、100pro' },
        platform: { type: 'string', description: '可选。芯片，如 RK、T3、SC60' },
        customer: { type: 'string', description: '可选。客户ID，默认 CP' },
        os: { type: 'string', description: '可选。DEBIAN / ANDROID / LINUX' },
        currentVersion: { type: 'string', description: '可选。现网固件版本串，用于反推客户/机型/系统并与参数互校' },
        limit: { type: 'integer', description: '候选数量上限，默认 20' },
      },
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          status: { type: 'string', enum: ['ok', 'needs_sync', 'needs_model', 'error'] },
          families: { type: 'array', items: { type: 'object' } },
          platforms: { type: 'array', items: { type: 'string' } },
          probe: { type: 'object' },
          index: { type: 'object' },
          hint: { type: 'string' },
          message: { type: 'string' },
          dataDir: { type: 'string' },
        },
        required: ['status'],
        additionalProperties: true,
      },
      render: (_args, value) => [{ type: 'text', text: renderModels(value) }],
    },
    async execute(args, exec) {
      try {
        const { dir, index } = await loadIndexOrNull(ctx, exec);
        if (!index) return { status: 'needs_sync', hint: NEEDS_SYNC_HINT, dataDir: dir };
        const catalog = buildCatalog(index);
        const platforms = platformsOf(catalog);
        const limit = Math.max(1, Math.min(60, Number(args.limit) || 20));

        if (!String(args.model ?? '').trim() && !String(args.currentVersion ?? '').trim()) {
          return jsonSafe({
            status: 'ok',
            platforms,
            families: catalog.slice(0, limit).map((group) => ({
              product: group.name,
              platform: group.platform,
              aliases: group.aliases,
              lineCount: group.lineCount,
              osList: group.osList,
              customers: group.customers,
              latest: group.latest,
            })),
            index: { lineCount: index.lineCount, commitCount: index.commitCount },
            dataDir: dir,
          });
        }

        const probe = probeModel(index, {
          model: args.model,
          platform: args.platform,
          customer: args.customer ?? 'CP',
          os: args.os,
          currentVersion: args.currentVersion,
        });
        return jsonSafe({
          status: probe.status === 'ok' ? 'ok' : 'needs_model',
          platforms,
          probe,
          lines: probe.lines || [],
          index: { lineCount: index.lineCount, commitCount: index.commitCount },
          dataDir: dir,
        });
      } catch (err) {
        return { status: 'error', message: err?.message || String(err) };
      }
    },
  };
}

function renderModels(v) {
  if (v.status === 'needs_sync') return `还没有本地索引，先调用 fix_sync 建索引（只抓 PROD 正式版）。${v.hint || ''}`;
  if (v.status === 'error') return `fix_models 出错：${v.message}`;

  const lines = [];
  if (!v.probe) {
    lines.push(`索引内芯片：${(v.platforms || []).join('/') || '-'}；机型族 ${v.families.length} 个（只含 PROD 正式版线）`);
    for (const f of v.families) {
      const alias = f.aliases?.length ? `  同族写法: ${f.aliases.join(' / ')}` : '';
      const latest = f.latest ? `最新 ${f.latest.buildDate}` : '';
      lines.push(`- ${f.platform} / ${f.product}  ${f.lineCount} 条线  ${f.osList.join('/')}  ${f.customers.join('/')}  ${latest}${alias}`);
    }
    return lines.join('\n');
  }

  const probe = v.probe;
  if (probe.status === 'ok') {
    const alias = probe.input !== probe.resolved?.product ? `${probe.input} → ${probe.resolved.product}` : probe.resolved.product;
    lines.push(`探测：${alias}（${probe.matchKind} 匹配 ${probe.score} 分，芯片 ${probe.resolved.platform}）`);
    if (probe.resolved.aliases?.length) lines.push(`同族写法：${[probe.resolved.product, ...probe.resolved.aliases].join(' / ')}`);
    const byOs = new Map();
    for (const line of v.lines || []) {
      const key = `${line.platform}/${line.os}/${line.product}`;
      if (!byOs.has(key)) byOs.set(key, []);
      byOs.get(key).push(`${line.customer}(${line.lcd || '-'}, ${line.buildDate})`);
    }
    for (const [key, list] of byOs) lines.push(`产线：${key}  ${list.join('、')}`);
    for (const mismatch of probe.mismatches || []) lines.push(`· 输入不一致：${mismatch}`);
    lines.push(`· 索引内芯片：${(v.platforms || []).join('/') || '-'}`);
    return lines.join('\n');
  }

  lines.push(`探测：${probe.input || '-'} 未唯一确定（${probe.status === 'ambiguous' ? '多个候选' : '未命中'}）`);
  for (const c of probe.candidates || []) {
    const latest = c.latest ? `最新 ${c.latest.buildDate}` : '';
    lines.push(`  - ${c.platform} / ${c.product}  [${c.matchKind} ${c.score} 分]  ${c.lineCount} 条线  ${c.osList.join('/')}  ${c.customers.join('/')}  ${latest}`);
  }
  if (probe.availableCustomers?.length) lines.push(`· 现有客户：${probe.availableCustomers.join('/')}；现有系统：${probe.availableOS.join('/') || '-'}`);
  if (probe.availablePlatforms?.length) lines.push(`· 索引内芯片：${probe.availablePlatforms.join('/')}`);
  lines.push('写法确认后再调 fix_check。');
  return lines.join('\n');
}

/* ------------------------------------------------------------------ *
 * 工具：fix_log
 * ------------------------------------------------------------------ */

function logToolFor(ctx) {
  return {
    name: 'fix_log',
    description:
      '把某个范围（芯片/系统/机型/客户 + 可选时间窗）的 PROD 提交标题原样取出来，按 hash 去重并标注落点，分页返回。用于「拿出来直接做自然语言匹配」：语料很小（单机型+系统 < 600 条），可以直接读标题判断。传 query 只附加相似度分数，不做过滤。',
    parameters: {
      type: 'object',
      properties: {
        platform: { type: 'string', description: '可选。芯片，如 RK。不给则不限制（不同芯片不会并成一条）' },
        os: { type: 'string', description: '可选。DEBIAN / ANDROID / LINUX' },
        product: { type: 'string', description: '可选。机型，如 SP2-10PRO（支持部分匹配）' },
        customer: { type: 'string', description: '可选。客户ID' },
        query: { type: 'string', description: '可选。现象描述，仅用于给每条提交附相似度分数并排序' },
        since: { type: 'string', description: '可选。起始日期 YYYY-MM-DD 或 YYYYMMDD（含）' },
        until: { type: 'string', description: '可选。结束日期 YYYY-MM-DD 或 YYYYMMDD（含）' },
        limit: { type: 'integer', description: '返回条数，默认 200，最大 1000' },
        offset: { type: 'integer', description: '分页偏移，默认 0' },
      },
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          status: { type: 'string', enum: ['ok', 'needs_sync', 'error'] },
          scope: { type: 'object' },
          total: { type: 'integer' },
          returned: { type: 'integer' },
          offset: { type: 'integer' },
          limit: { type: 'integer' },
          commits: { type: 'array', items: { type: 'object' } },
          hint: { type: 'string' },
          message: { type: 'string' },
          dataDir: { type: 'string' },
        },
        required: ['status'],
        additionalProperties: true,
      },
      render: (_args, value) => [{ type: 'text', text: renderLog(value) }],
    },
    async execute(args, exec) {
      try {
        const { dir, index } = await loadIndexOrNull(ctx, exec);
        if (!index) return { status: 'needs_sync', hint: NEEDS_SYNC_HINT, dataDir: dir };
        const result = collectCommits(index, {
          platform: args.platform,
          os: args.os,
          product: args.product,
          customer: args.customer,
          query: args.query,
          since: args.since,
          until: args.until,
          limit: args.limit,
          offset: args.offset,
        });
        return jsonSafe({ status: 'ok', ...result, dataDir: dir });
      } catch (err) {
        return { status: 'error', message: err?.message || String(err) };
      }
    },
  };
}

function renderLog(v) {
  if (v.status === 'needs_sync') return `还没有本地索引。${v.hint || ''}`;
  if (v.status === 'error') return `fix_log 出错：${v.message}`;
  const s = v.scope || {};
  const scope = `${[s.platform, s.os, s.product].filter(Boolean).join('/') || '全部'}${s.customer ? `(${s.customer})` : ''}`;
  const window = [s.since && `从 ${s.since}`, s.until && `到 ${s.until}`].filter(Boolean).join(' ');
  const lines = [`范围：${scope}  ${window}  去重 ${v.total} 条（返回 ${v.returned} 条，offset ${v.offset}）`, ''];
  if (!v.commits.length) {
    lines.push('该范围内没有提交。检查机型/系统/客户写法，或放宽 since/until。');
    return lines.join('\n');
  }
  for (const c of v.commits) {
    const score = c.nlScore ? `[${c.nlScore}] ` : '';
    const revert = c.revert ? '[revert] ' : '';
    lines.push(`${c.hash} ${c.date} ${score}${revert}${c.subject}`);
    const landing = [...new Set((c.lines || []).map((l) => `${l.platform}/${l.os}/${l.product}(${l.customer})`))];
    if (landing.length) lines.push(`    落点：${landing.join('；')}`);
  }
  if (v.total > v.offset + v.returned) {
    lines.push('', `还有 ${v.total - v.offset - v.returned} 条，用 offset=${v.offset + v.returned} 继续翻页。`);
  }
  return lines.join('\n');
}

/* ------------------------------------------------------------------ *
 * 工具：fix_matrix
 * ------------------------------------------------------------------ */

function matrixToolFor(ctx) {
  return {
    name: 'fix_matrix',
    description:
      '给定 commit hash、工单号（DO-xxxx）或标题片段，输出「产品线 × 是否包含」的覆盖矩阵：哪些机型/客户/系统/芯片已经合入，哪些没有。用于回答「其它机型是否做了同样的更改」「Android/Linux 是否也同步了」。cherry-pick 换 hash 的情况会用同工单号与标题相似度兜底。索引来自 fix_sync（只含 PROD）。',
    parameters: {
      type: 'object',
      properties: {
        hash: { type: 'string', description: 'commit 短 hash，如 92cf9c82（8/9/10/40 位都接受）' },
        ticket: { type: 'string', description: '工单号，如 DO-8486' },
        subject: { type: 'string', description: '提交标题片段（相似度匹配，阈值 0.55）' },
        platform: { type: 'string', description: '可选。只输出某个芯片：RK / T3 / SC60' },
        os: { type: 'string', description: '可选。只输出某个系统：DEBIAN / ANDROID / LINUX' },
        includeSimilar: { type: 'boolean', description: '是否用标题相似度兜底，默认 true' },
        limit: { type: 'integer', description: 'matches 条数上限，默认 20' },
      },
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          status: { type: 'string', enum: ['ok', 'needs_key', 'needs_sync', 'error'] },
          key: { type: 'object' },
          matches: { type: 'array', items: { type: 'object' } },
          rows: { type: 'array', items: { type: 'object' } },
          counts: { type: 'object' },
          summary: { type: 'object' },
          notes: { type: 'array', items: { type: 'string' } },
          message: { type: 'string' },
          hint: { type: 'string' },
        },
        required: ['status'],
        additionalProperties: true,
      },
      render: (_args, value) => [{ type: 'text', text: renderMatrix(value) }],
    },
    async execute(args, exec) {
      try {
        const { index } = await loadIndexOrNull(ctx, exec);
        if (!index) return { status: 'needs_sync', hint: NEEDS_SYNC_HINT };
        if (!args.hash && !args.ticket && !args.subject) {
          return { status: 'needs_key', hint: '至少给 hash / ticket / subject 之一。' };
        }

        const matrix = buildMatrix(index, {
          hash: args.hash,
          ticket: args.ticket,
          subject: args.subject,
          platform: args.platform,
          os: args.os,
          includeSimilar: args.includeSimilar !== false,
        });
        const limit = Math.max(1, Math.min(50, Number(args.limit) || 20));
        const rows = matrix.rows.slice(0, 160);
        const contained = rows.filter((r) => r.contained);
        const missing = rows.filter((r) => !r.contained);

        return jsonSafe({
          status: 'ok',
          key: { hash: args.hash || '', ticket: args.ticket || '', subject: args.subject || '', platform: args.platform || '', os: args.os || '' },
          matches: matrix.matches.slice(0, limit),
          rows,
          counts: { lines: rows.length, contained: contained.length, missing: missing.length },
          summary: matrix.summary,
          notes: [
            `矩阵覆盖 ${rows.length} 条产品线（仅 PROD），${contained.length} 条已含该修改。`,
            ...(matrix.matches.some((m) => m.matchKind === 'similar') ? ['包含按标题相似度兜底的匹配，需人工复核。'] : []),
            ...(matrix.matches.length > limit ? [`matches 截断到 ${limit} 条，可用 subject 精确一点。`] : []),
          ],
        });
      } catch (err) {
        return { status: 'error', message: err?.message || String(err) };
      }
    },
  };
}

function renderMatrix(v) {
  if (v.status === 'needs_sync') return `还没有本地索引，先调用 fix_sync 建索引。${v.hint || ''}`;
  if (v.status === 'needs_key') return `缺少查询条件：至少给 hash / ticket / subject 之一。${v.hint || ''}`;
  if (v.status === 'error') return `fix_matrix 出错：${v.message}`;

  const lines = [];
  const key = v.key || {};
  lines.push(
    `查询：${[
      key.hash && `hash=${key.hash}`,
      key.ticket && `ticket=${key.ticket}`,
      key.subject && `subject=${key.subject}`,
      key.platform && `platform=${key.platform}`,
      key.os && `os=${key.os}`,
    ]
      .filter(Boolean)
      .join(' | ')}`,
  );
  lines.push(`覆盖：${v.counts.contained}/${v.counts.lines} 条产品线包含该修改`);
  lines.push('');

  if (v.matches?.length) {
    lines.push('匹配提交：');
    for (const m of v.matches.slice(0, 8)) lines.push(`  ${m.hash} ${m.date} [${m.matchKind}] ${m.subject}`);
    lines.push('');
  }

  const byOS = (v.summary?.byOS || []).map((o) => `${o.os} ${o.contained}/${o.total}`).join(' | ');
  if (byOS) lines.push(`按系统：${byOS}`);
  const byPlatform = (v.summary?.byPlatform || []).map((p) => `${p.platform} ${p.contained}/${p.total}`).join(' | ');
  if (byPlatform) lines.push(`按芯片：${byPlatform}`);

  const contained = (v.rows || []).filter((r) => r.contained);
  if (contained.length) {
    lines.push('', `已包含（最近 ${Math.min(20, contained.length)} 条）：`);
    for (const r of contained.slice(-20)) {
      lines.push(`  ${r.platform}/${r.os}/${r.product}/${r.customer} ${r.stage} ${r.buildDate} ${r.matchKind || ''} → ${r.line}`);
    }
  }
  const byModel = (v.summary?.byModel || []).filter((m) => m.contained?.length);
  if (byModel.length) {
    lines.push('', `已同步机型（${byModel.length}）：`);
    for (const m of byModel.slice(0, 30)) lines.push(`  ${m.platform}/${m.os} ${m.product}: ${m.contained.length}/${m.total} 条线`);
  }
  for (const note of v.notes || []) lines.push(`· ${note}`);
  return lines.join('\n');
}

/* ------------------------------------------------------------------ *
 * 工具：fix_sync
 * ------------------------------------------------------------------ */

function syncToolFor(ctx) {
  return {
    name: 'fix_sync',
    description:
      '从 https://alist.cpinnov.run 同步 commit log 索引：只遍历 /PROD/<芯片>/<系统> 下每条产品线，且每条线只取最新一版**正式构建**（_V…_，DEV/tip 跳过）的 commit-logs.txt（累积全量 git log）。构建未变化的线会被跳过。提交正文按 hash 去重只存一份，每条线只存 hash 列表。冷同步约 5–10 秒。只读，不修改 alist 上任何内容。',
    parameters: {
      type: 'object',
      properties: {
        force: { type: 'boolean', description: 'true 时强制重新下载所有产品线的最新日志' },
        only: { type: 'string', description: '正则/片段过滤产品线 id，如 SP2-10PRO 或 MEGA1，只同步匹配的线' },
      },
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          status: { type: 'string', enum: ['ok', 'error'] },
          dataDir: { type: 'string' },
          stats: { type: 'object' },
          updatedLines: { type: 'array', items: { type: 'object' } },
          failures: { type: 'array', items: { type: 'object' } },
          index: { type: 'object' },
          notes: { type: 'array', items: { type: 'string' } },
          message: { type: 'string' },
        },
        required: ['status'],
        additionalProperties: true,
      },
      render: (_args, value) => [{ type: 'text', text: renderSync(value) }],
    },
    async execute(args, exec) {
      try {
        const client = createAlistClient();
        const result = await runSync({
          ctx,
          exec,
          client,
          force: args.force === true,
          only: args.only || null,
          onProgress: (p) => {
            if (p.updated % 20 === 0) process.stderr.write(`[fix-finder] 已更新 ${p.updated}/${p.total} 条线\n`);
          },
        });
        return jsonSafe({
          status: 'ok',
          dataDir: result.dir,
          stats: result.stats,
          updatedLines: result.updatedLines,
          failures: result.failures,
          index: result.index,
          notes: [
            `发现 ${result.stats.discovered} 条 PROD 产品线，本次目标 ${result.stats.targeted} 条。`,
            `更新 ${result.stats.updated} 条、跳过（构建未变）${result.stats.skipped} 条、失败 ${result.stats.failed} 条。`,
          ],
        });
      } catch (err) {
        return { status: 'error', message: err?.message || String(err) };
      }
    },
  };
}

function renderSync(v) {
  if (v.status === 'error') return `fix_sync 出错：${v.message}`;
  const lines = [];
  lines.push(`同步完成：更新 ${v.stats?.updated ?? 0} 条，跳过 ${v.stats?.skipped ?? 0} 条，失败 ${v.stats?.failed ?? 0} 条（共发现 ${v.stats?.discovered ?? 0} 条 PROD 产品线）`);
  if (v.index) {
    const plat = Object.entries(v.index.platformBreakdown || {}).map(([k, n]) => `${k}:${n}`).join(' ');
    const os = Object.entries(v.index.osBreakdown || {}).map(([k, n]) => `${k}:${n}`).join(' ');
    lines.push(`索引：${v.index.lineCount} 条线 / ${v.index.commitCount} 个去重提交  ${plat}  ${os}`);
  }
  if (v.updatedLines?.length) {
    lines.push('', '本次更新（部分）：');
    for (const u of v.updatedLines) lines.push(`  ${u.line} → ${u.build}（${u.commits} 条提交）`);
  }
  if (v.failures?.length) {
    lines.push('', '失败：');
    for (const f of v.failures.slice(0, 10)) lines.push(`  ${f.line || f.root || f.dir}: ${f.error}`);
  }
  for (const note of v.notes || []) lines.push(`· ${note}`);
  if (v.dataDir) lines.push(`数据目录：${v.dataDir}`);
  return lines.join('\n');
}

/* ------------------------------------------------------------------ *
 * 插件入口
 * ------------------------------------------------------------------ */

export const name = 'fix-finder';
export const inject = ['tools'];

export function apply(ctx) {
  ctx.effect(() => ctx.tools.register(syncToolFor(ctx)));
  ctx.effect(() => ctx.tools.register(checkToolFor(ctx)));
  ctx.effect(() => ctx.tools.register(modelsToolFor(ctx)));
  ctx.effect(() => ctx.tools.register(logToolFor(ctx)));
  ctx.effect(() => ctx.tools.register(matrixToolFor(ctx)));
}
