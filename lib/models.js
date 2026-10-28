/**
 * 机型探测：在真正检索之前，先把用户写的机型名归一化到索引里的规范 product。
 *
 * 为什么不复用 lib/search.js#lineMatchesModel：那里只有 sp2↔spring2 / apollo↔apollo2 两对替换，
 * 且要求双向 includes，`SPRING2PRO` 这种**省略尺寸段**的写法会一条线都选不中（→ needs_baseline）。
 *
 * 评分规则沿用 firmware-finder 的实现（gapScore 等，见 plugins/firmware-finder/index.js），
 * 这里只按「芯片 + product」重新分组，保证不同芯片的同名机型绝不合并。
 */
import { nz } from './parse.js';
import { similarity } from './nl.js';

const SYSTEM_OS = { A: 'ANDROID', D: 'DEBIAN', L: 'LINUX' };

/** 语义核心：去掉厂商前缀差异与「二代」（alist product 里通常没有厂商段） */
export function canonCore(name) {
  return nz(name).replace(/二代/g, 'gen2').replace(/apollo2/g, 'apollo');
}

/** 查询侧缩写展开：SP2 <-> SPRING2、APOLLO2 <-> APOLLO */
export function queryCores(core) {
  const cores = new Set([core]);
  for (const [a, b] of [
    ['sp2', 'spring2'],
    ['spring2', 'sp2'],
    ['apollo2', 'apollo'],
    ['apollo', 'apollo2'],
  ]) {
    if (core.includes(a)) cores.add(core.replaceAll(a, b));
  }
  return [...cores];
}

/**
 * 查询省略了型号里的尺寸数字段时仍应命中：spring2pro -> spring210pro。
 * 约束：查询以字母结尾（pro/plus/mix）、字母骨架相同、候选数字更多（避免 apollo10 被误判）。
 */
export function gapScore(qc, core) {
  if (!/[a-z]$/.test(qc)) return 0;
  const qLetters = qc.replace(/\d/g, '');
  const cLetters = core.replace(/\d/g, '');
  if (!qLetters || qLetters !== cLetters) return 0;
  const qDigits = (qc.match(/\d/g) ?? []).length;
  const cDigits = (core.match(/\d/g) ?? []).length;
  return cDigits > qDigits ? 85 : 0;
}

export function scoreCore(qc, core) {
  if (core === qc) return 100;
  if (core.startsWith(qc)) return 70;
  if (core.includes(qc)) return 50;
  if (qc.includes(core)) {
    // spring2 不该匹配 spring：只有当多出来的部分是字母（如 5g）时才算同一族
    if (/[a-z]/.test(qc.split(core).join(''))) return 40;
  }
  const gap = gapScore(qc, core);
  if (gap) return gap;
  const qt = new Set(qc.match(/[a-z]+|\d+/g) ?? []);
  const gt = new Set(core.match(/[a-z]+|\d+/g) ?? []);
  const inter = [...qt].filter((x) => gt.has(x));
  return inter.length >= 2 ? 20 + 5 * inter.length : 0;
}

function kindOfScore(score, viaAlias) {
  if (score >= 100) return viaAlias ? 'alias' : 'exact';
  if (score >= 85) return 'gap';
  if (score >= 70) return 'prefix';
  if (score >= 50) return 'contains';
  return 'fuzzy';
}

/** 从索引的 lines 建机型目录：每个 (platform, product) 一组 */
export function buildCatalog(index) {
  const map = new Map();
  for (const line of index?.lines || []) {
    const platform = line.platform || 'RK';
    const core = canonCore(line.product);
    const key = `${platform}\u0000${core}`;
    const group = map.get(key) || {
      platform,
      name: line.product,
      core,
      aliases: new Set(),
      lineCount: 0,
      osList: new Set(),
      customers: new Set(),
      latest: null,
      names: new Map(),
    };
    group.lineCount += 1;
    group.osList.add(line.os);
    group.customers.add(line.customer);
    group.names.set(line.product, (group.names.get(line.product) ?? 0) + 1);
    if (!group.latest || String(line.buildDate) > String(group.latest.buildDate)) group.latest = line;
    map.set(key, group);
  }
  const out = [];
  for (const group of map.values()) {
    group.name = [...group.names.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0][0];
    group.aliases = [...group.names.keys()].filter((name) => name !== group.name);
    out.push({
      platform: group.platform,
      name: group.name,
      product: group.name,
      core: group.core,
      aliases: group.aliases,
      lineCount: group.lineCount,
      osList: [...group.osList].sort(),
      customers: [...group.customers].sort(),
      latest: group.latest
        ? { os: group.latest.os, build: group.latest.build, buildDate: group.latest.buildDate, customer: group.latest.customer }
        : null,
    });
  }
  out.sort((a, b) => a.platform.localeCompare(b.platform) || a.name.localeCompare(b.name));
  return out;
}

/** 芯片维度统计，用于「索引里没有该芯片」时给出可用值 */
export function platformsOf(catalog) {
  return [...new Set(catalog.map((group) => group.platform))].sort();
}

/**
 * 机型名 -> 目录组
 * @returns {{status:'ok'|'ambiguous'|'not_found', resolved?:object, score?:number, matchKind?:string,
 *            candidates:object[], availablePlatforms:string[], reason?:string}}
 */
export function resolveModel(index, { model, platform } = {}) {
  const catalog = buildCatalog(index);
  const availablePlatforms = platformsOf(catalog);
  const query = canonCore(model);

  if (!query) {
    return { status: 'not_found', candidates: [], availablePlatforms, reason: 'no_model' };
  }

  const wantedPlatform = platform ? String(platform).toUpperCase() : '';
  if (wantedPlatform && !availablePlatforms.includes(wantedPlatform)) {
    return { status: 'not_found', candidates: [], availablePlatforms, reason: 'platform_missing', query };
  }

  const cores = queryCores(query);
  const scored = [];
  for (const group of catalog) {
    if (wantedPlatform && group.platform !== wantedPlatform) continue;
    let best = { score: 0, viaAlias: false };
    for (const core of cores) {
      const score = scoreCore(core, group.core);
      if (score > best.score) best = { score, viaAlias: core !== query };
    }
    if (best.score >= 40) scored.push({ group, score: best.score, viaAlias: best.viaAlias });
  }
  scored.sort((a, b) => b.score - a.score || a.group.name.localeCompare(b.group.name));

  const toCandidate = ({ group, score, viaAlias }) => ({
    product: group.name,
    platform: group.platform,
    score,
    matchKind: kindOfScore(score, viaAlias),
    osList: group.osList,
    customers: group.customers,
    lineCount: group.lineCount,
    latest: group.latest,
  });

  if (!scored.length) {
    // 兜底建议：按字面相似度找最接近的 3 个写法
    const near = catalog
      .map((group) => ({ group, sim: similarity(query, group.core) }))
      .filter((x) => x.sim > 0.25)
      .sort((a, b) => b.sim - a.sim)
      .slice(0, 3)
      .map(({ group, sim }) => ({
        product: group.name,
        platform: group.platform,
        score: Math.round(sim * 100),
        matchKind: 'similar',
        osList: group.osList,
        customers: group.customers,
        lineCount: group.lineCount,
        latest: group.latest,
      }));
    return { status: 'not_found', candidates: near, availablePlatforms, reason: 'no_match', query };
  }

  const [top, ...rest] = scored;
  const rivals = rest.filter((entry) => entry.score >= 85);
  const candidates = scored.slice(0, 6).map(toCandidate);

  // 只有「精确/省略尺寸段」级别（>=85）且无同等强度竞争者才敢直接采用；
  // 单个弱候选（如反向包含 40 分）更像是拼错，交给调用方确认写法。
  if (top.score >= 85 && rivals.length === 0) {
    return {
      status: 'ok',
      resolved: { ...top.group },
      score: top.score,
      matchKind: kindOfScore(top.score, top.viaAlias),
      candidates,
      availablePlatforms,
      query,
    };
  }
  if (top.score < 70) {
    // 全是「反向包含/词交集」这种弱命中，基本是拼错：不作为候选机型，只给写法提示
    return { status: 'not_found', candidates, availablePlatforms, query, reason: 'low_confidence', score: top.score };
  }
  return { status: 'ambiguous', candidates, availablePlatforms, query, score: top.score };
}

/** 从现网固件版本串里提客户 / 机型 / 系统：CP_SP2-10PRO_D_V1.16_... */
export function probeVersion(version) {
  const raw = String(version ?? '').trim();
  if (!raw) return null;
  const segs = raw.split('_').filter(Boolean);
  if (segs.length < 3) return null;
  const system = String(segs[2]).toUpperCase();
  if (!/^[ADL]$/.test(system)) return null;
  return { customer: segs[0].toUpperCase(), product: segs[1], os: SYSTEM_OS[system], raw };
}

function linesOf(index, group) {
  return (index?.lines || []).filter((line) => (line.platform || 'RK') === group.platform && line.product === group.name);
}

/** 某目录组在当前索引里的产线详情（客户 × 系统） */
export function describeGroup(index, group) {
  const lines = linesOf(index, group);
  const osList = [...new Set(lines.map((line) => line.os))].sort();
  const customers = [...new Set(lines.map((line) => line.customer))].sort();
  return {
    product: group.name,
    platform: group.platform,
    aliases: group.aliases || [],
    osList,
    customers,
    lineCount: lines.length,
    lines: lines.map((line) => ({
      platform: line.platform,
      os: line.os,
      product: line.product,
      stage: line.stage,
      customer: line.customer,
      lcd: line.lcd,
      build: line.build,
      buildDate: line.buildDate,
    })),
  };
}

/**
 * fix_check / fix_models 的统一入口：机型 + 版本串 + 客户/系统互校。
 */
export function probeModel(index, { model, platform, customer, os, currentVersion } = {}) {
  const fromVersion = probeVersion(currentVersion);
  const input = String(model ?? '').trim() || fromVersion?.product || '';
  const effectiveOs = String(os ?? '').toUpperCase() || '';
  const wantedPlatform = platform ? String(platform).toUpperCase() : '';

  const resolved = resolveModel(index, { model: input, platform: wantedPlatform });
  const base = {
    input,
    fromVersion,
    requested: { platform: wantedPlatform || '', customer: String(customer ?? '').toUpperCase(), os: effectiveOs },
    availablePlatforms: resolved.availablePlatforms,
    candidates: resolved.candidates,
    mismatches: [],
    status: resolved.status,
  };

  if (resolved.status !== 'ok') {
    const availableOS = [...new Set(resolved.candidates.flatMap((c) => c.osList))].sort();
    const availableCustomers = [...new Set(resolved.candidates.flatMap((c) => c.customers))].sort();
    return { ...base, availableOS, availableCustomers, reason: resolved.reason };
  }

  const detail = describeGroup(index, resolved.resolved);
  const mismatches = [];
  if (fromVersion?.product && nz(fromVersion.product) !== nz(detail.product)) {
    mismatches.push(`现网版本串里的机型是 ${fromVersion.product}，与传入的 ${input} 不一致`);
  }
  if (fromVersion?.os && effectiveOs && fromVersion.os !== effectiveOs) {
    mismatches.push(`现网版本串是 ${fromVersion.os}（_${fromVersion.raw.split('_')[2]}_），与 os=${effectiveOs} 不一致`);
  }
  if (fromVersion?.customer && customer && fromVersion.customer !== String(customer).toUpperCase()) {
    mismatches.push(`现网版本串里的客户是 ${fromVersion.customer}，与 customer=${String(customer).toUpperCase()} 不一致`);
  }
  if (!detail.customers.length) {
    return { ...base, status: 'not_found', reason: 'no_lines', availableOS: detail.osList, availableCustomers: detail.customers };
  }

  return {
    ...base,
    status: 'ok',
    resolved: { product: detail.product, platform: detail.platform, aliases: detail.aliases },
    matchKind: resolved.matchKind,
    score: resolved.score,
    availableOS: detail.osList,
    availableCustomers: detail.customers,
    lines: detail.lines,
    mismatches,
  };
}
