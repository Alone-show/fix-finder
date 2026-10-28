/**
 * fix_check 的核心逻辑（与工具层解耦，方便脚本/测试直接调用）。
 *
 * 流程：机型探测 -> 检索打分（自然语言相似度）-> 现网基线过滤 -> 客户线判定。
 * 机型探测不通过时不返回任何提交候选，避免「机型没匹配上、候选却照旧打印」的误读。
 */
import { extractQuery, searchCommits, evaluate, coverageOf, isKernelIssue } from './search.js';
import { probeModel } from './models.js';
import { parseVersionString } from './parse.js';
import { indexAgeHours } from './store.js';

export const STALE_HOURS = 24;

export const buildRef = (line) => ({
  line: line.id,
  stage: line.stage,
  platform: line.platform || 'RK',
  os: line.os,
  product: line.product,
  customer: line.customer,
  lcd: line.lcd,
  build: line.build,
  buildDate: line.buildDate,
});

export function publicCommit(commit, limitLines = 6) {
  return {
    hash: commit.hash,
    date: commit.date,
    author: commit.author,
    subject: commit.subject,
    ticket: commit.ticket || '',
    scope: commit.scope || '',
    kind: commit.kind || '',
    revert: !!commit.revert,
    score: commit.score ?? 0,
    hits: commit.hits ?? [],
    releasedIn: commit.releasedIn ? buildRef(commit.releasedIn) : null,
    revertedBy: commit.revertedBy ?? [],
    inCustomerLine: commit.inCustomerLine ?? [],
    lineCount: (commit.lines || []).length,
    lines: (commit.placement?.lines || []).slice(0, limitLines).map(buildRef),
    earliestRelease: commit.placement?.earliestRelease ? buildRef(commit.placement.earliestRelease) : null,
  };
}

function publicProbe(probe) {
  return {
    status: probe.status,
    input: probe.input,
    resolved: probe.resolved ? probe.resolved.product : null,
    platform: probe.resolved?.platform || probe.requested?.platform || '',
    matchKind: probe.matchKind || '',
    score: probe.score ?? 0,
    fromVersion: probe.fromVersion || null,
    mismatches: probe.mismatches || [],
    availablePlatforms: probe.availablePlatforms || [],
    availableOS: probe.availableOS || [],
    availableCustomers: probe.availableCustomers || [],
    reason: probe.reason || '',
    candidates: (probe.candidates || []).slice(0, 6).map((c) => ({
      product: c.product,
      platform: c.platform,
      score: c.score,
      matchKind: c.matchKind,
      osList: c.osList,
      customers: c.customers,
      lineCount: c.lineCount,
      latest: c.latest,
    })),
  };
}

export function indexInfo(index) {
  const age = indexAgeHours(index);
  return {
    generatedAt: index.generatedAt,
    lineCount: index.lineCount,
    commitCount: index.commitCount,
    ageHours: Number(age.toFixed(1)),
    stale: age > STALE_HOURS,
  };
}

/** 探测失败时给一条可以直接照抄的重试建议 */
function retryHint(args, probe) {
  const first = probe.candidates?.[0];
  if (!first) {
    return '索引里没有该机型。先确认写法（fix_models 可列全部机型），或 fix_sync 后再试。';
  }
  const parts = [`bug: ${JSON.stringify(String(args.bug ?? '').slice(0, 40))}`, `model: '${first.product}'`, `platform: '${first.platform}'`];
  const os = args.os || first.osList?.[0];
  if (os) parts.push(`os: '${os}'`);
  if (first.customers?.includes(args.customer ?? 'CP')) parts.push(`customer: '${args.customer ?? 'CP'}'`);
  return `请用规范写法重试：fix_check({ ${parts.join(', ')} })`;
}

function probeNotes(probe, args) {
  const notes = [];
  if (probe.status === 'ok') {
    if (!args.model && probe.fromVersion?.product) {
      notes.push(`机型由现网版本串推断为 ${probe.resolved.product}（${probe.resolved.platform}）。`);
    } else if (probe.matchKind !== 'exact') {
      notes.push(`机型 ${probe.input} 已按「${probe.matchKind}」规则归一化为 ${probe.resolved.product}（${probe.resolved.platform}，${probe.score} 分）。`);
    }
    if (!args.platform) notes.push(`芯片按索引推断为 ${probe.resolved.platform}（索引内芯片：${probe.availablePlatforms.join('/') || '-'}）。`);
  }
  for (const mismatch of probe.mismatches || []) notes.push(`输入不一致：${mismatch}（以显式参数为准）。`);
  return notes;
}

/**
 * @param {object} options
 * @param {object} options.index    本地索引
 * @param {object} options.dictionary 归一化后的关键词词典
 * @param {object} options.args     fix_check 入参
 * @param {string} [options.dataDir]
 */
export function executeCheck({ index, dictionary, args = {}, dataDir }) {
  const customer = String(args.customer ?? 'CP').toUpperCase();
  const probe = probeModel(index, {
    model: args.model,
    platform: args.platform,
    customer,
    os: args.os,
    currentVersion: args.currentVersion,
  });

  const hasModelInput = Boolean(String(args.model ?? '').trim()) || Boolean(probe.fromVersion?.product);

  if (hasModelInput && probe.status !== 'ok') {
    return {
      status: 'needs_confirmation',
      verdict: 'needs_model',
      kernel: false,
      query: { tickets: [], hashes: [], tokens: [], categories: [], primaryCategories: [] },
      baseline: { raw: '', date: '', commit: '', kind: '' },
      modelProbe: publicProbe(probe),
      resolvedModel: null,
      customerLines: [],
      candidates: [],
      alreadyIncludedCount: 0,
      alreadyIncluded: [],
      customerLineHits: [],
      coverage: { byOS: [], byPlatform: [], byModel: [] },
      notes: [
        probe.status === 'ambiguous'
          ? `机型 ${probe.input} 在索引里对应多个产品线，无法确定是哪一个。`
          : probe.reason === 'platform_missing'
            ? `索引里没有芯片 ${probe.requested?.platform} 的产品线（索引内芯片：${probe.availablePlatforms.join('/') || '-'}）。跨芯片绝不互相顶替。`
            : `索引里找不到机型 ${probe.input} 对应的产品线。`,
        ...(probe.availableCustomers?.length ? [`该机型现有客户：${probe.availableCustomers.join('/')}；现有系统：${probe.availableOS.join('/')}。`] : []),
      ],
      hint: retryHint(args, probe),
      index: indexInfo(index),
      dataDir,
    };
  }

  const model = probe.status === 'ok' ? probe.resolved.product : args.model;
  const platform = probe.status === 'ok' ? probe.resolved.platform : args.platform;
  const products = probe.status === 'ok' ? [probe.resolved.product] : undefined;

  const query = extractQuery(args.bug, {
    ticket: args.ticket,
    keywords: args.keywords,
    dictionary,
  });
  if (!query.tokens.length && !query.tickets.length && !query.hashes.length) {
    return {
      status: 'needs_keywords',
      verdict: 'not_found',
      hint: '没能从描述里提取到关键词/工单号/hash，请补充更具体的现象词，或直接给 ticket/hash。',
      dataDir,
    };
  }

  const limit = Math.max(1, Math.min(20, Number(args.limit) || 8));
  const retrieved = searchCommits(index, query, {
    limit: Math.min(40, limit * 4),
    model,
    dictionary,
  });

  // 现网包已经包含的老提交解释不了「新出现的问题」：按构建日期先切开
  const baselineDate = parseVersionString(args.currentVersion).date;
  let candidates = retrieved;
  let alreadyIncluded = [];
  let alreadyIncludedCount = 0;
  if (baselineDate) {
    const cutoff = Number(baselineDate);
    const day = (c) => Number(String(c.date).replaceAll('-', ''));
    const newer = retrieved.filter((c) => day(c) > cutoff);
    const older = retrieved.filter((c) => day(c) <= cutoff);
    if (newer.length) {
      candidates = newer;
      alreadyIncluded = older;
      alreadyIncludedCount = older.length;
    }
  }
  candidates = candidates.slice(0, limit);

  const evaluated = evaluate(index, {
    query,
    candidates,
    model,
    platform,
    products,
    customer,
    os: args.os,
    currentVersion: args.currentVersion,
    scope: args.scope,
    dictionary,
  });

  const kernel = isKernelIssue(query, evaluated.candidates, args.scope);
  const top = evaluated.top || evaluated.candidates[0];
  const coverage = top ? coverageOf(index, top.placement?.lineIds || []) : { byModel: [], byOS: [], byPlatform: [] };

  const notes = [...probeNotes(probe, args), ...evaluated.notes];
  if (alreadyIncludedCount) {
    notes.push(
      `现网构建（${baselineDate}）之前的 ${alreadyIncludedCount} 条相似提交已包含在现网包里，不能解释新问题，已降级排除。`,
    );
  }
  if (kernel) {
    notes.push('按内核/驱动类问题处理：下面同时给出 DEBIAN / ANDROID / LINUX 三套系统的覆盖情况。');
  }
  if (evaluated.verdict === 'fixed_released' && top?.releasedIn) {
    notes.push(`升级到 ${top.releasedIn.build}（${top.releasedIn.buildDate}）即可带上该修复。`);
  }
  if (evaluated.verdict === 'needs_baseline') {
    notes.push(
      `该机型现有客户：${probe.availableCustomers?.join('/') || '-'}；现有系统：${probe.availableOS?.join('/') || '-'}。客户之间固件不能混刷，不做回退。`,
    );
  }
  if (indexInfo(index).stale) {
    notes.push('索引已超过 24 小时，建议先跑 fix_sync 再下结论。');
  }

  // verdict 只看 top1；把「客户线已含修复」的其它候选单独列出来，避免被 top1 误导
  const customerLineHits = evaluated.candidates
    .filter((commit) => commit.releasedIn)
    .slice(0, 5)
    .map((commit) => ({
      hash: commit.hash,
      date: commit.date,
      score: commit.score,
      subject: commit.subject,
      releasedIn: buildRef(commit.releasedIn),
    }));

  return {
    status: 'ok',
    verdict: evaluated.verdict,
    kernel,
    resolvedModel: model || '',
    platform: platform || (probe.status === 'ok' ? probe.resolved.platform : ''),
    query: {
      tickets: query.tickets,
      hashes: query.hashes,
      tokens: query.tokens,
      categories: query.cats,
      primaryCategories: query.primaryCats,
    },
    baseline: {
      raw: evaluated.baseline.raw,
      date: evaluated.baseline.date,
      commit: evaluated.baseline.commit,
      kind: evaluated.baseline.kind,
    },
    modelProbe: probe.status === 'ok' ? publicProbe(probe) : null,
    customerLines: evaluated.customerLines.map(buildRef),
    candidates: evaluated.candidates.map((c) => publicCommit(c)),
    alreadyIncludedCount,
    alreadyIncluded: alreadyIncluded.slice(0, 6).map((c) => ({
      hash: c.hash,
      date: c.date,
      subject: c.subject,
      score: c.score,
    })),
    customerLineHits,
    coverage: {
      byOS: coverage.byOS,
      byPlatform: coverage.byPlatform,
      byModel: kernel ? coverage.byModel : coverage.byModel.slice(0, 30),
    },
    notes,
    index: indexInfo(index),
    dataDir,
  };
}
