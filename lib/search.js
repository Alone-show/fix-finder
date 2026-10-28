/**
 * 检索与判定：把 bug 描述变成工单号/hash/现象文本，在本地索引里打分，
 * 再结合「客户产品线是否包含这个提交」给出结论状态机。
 *
 * v2 变化：
 * - 排序改成自然语言相似度（lib/nl.js），不再用词典分类 + IDF 先验；
 * - 产品线选择以 (芯片, 机型, 系统, 客户) 为维度，芯片绝对隔离；
 * - 只索引 PROD，所以不再有「只进 TEST/DEV」这一态。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { nz, parseVersionString } from './parse.js';
import { nlScore, semanticText } from './nl.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const KEYWORDS_FILE = path.join(HERE, '..', 'keywords.json');

function readDefaultKeywords() {
  try {
    return JSON.parse(fs.readFileSync(KEYWORDS_FILE, 'utf8'));
  } catch {
    return {};
  }
}

/** 载入词典：内置 + 数据目录下的覆盖文件（整类覆盖）。v2 里词典只用于「命中提示 + 轻量加分」。 */
export function loadKeywords(dataDir) {
  const merged = { ...readDefaultKeywords() };
  if (dataDir) {
    const override = path.join(dataDir, 'keywords.json');
    try {
      if (fs.existsSync(override)) Object.assign(merged, JSON.parse(fs.readFileSync(override, 'utf8')));
    } catch {
      /* 覆盖文件坏了就忽略 */
    }
  }
  const out = {};
  for (const [category, words] of Object.entries(merged)) {
    if (!Array.isArray(words)) continue;
    const normalized = [...new Set(words.map((w) => nz(w)).filter((w) => w.length >= 2))];
    if (normalized.length) out[category] = normalized;
  }
  return out;
}

const CJK_RUN = /[\u4e00-\u9fa5]{2,8}/g;
const STOPWORDS = ['好的', '好啊', '嗯嗯', '嗯', '没有', '问题', '一下', '帮忙', '看看', '你好', '谢谢', '请问', '怎么', '为什么', '可以', '不行', '还是', '然后', '这个', '那个', '现在', '之前', '已经', '就是', '我们', '你们'];

/**
 * 把一次查询归一化成：
 *   tickets: ['DO-8486'] / hashes: ['92cf9c82'] / tokens: ['摄像头','cif',...] / text: 现象原文
 */
export function extractQuery(bug, { ticket, keywords, dictionary } = {}) {
  const raw = String(bug ?? '').normalize('NFKC');
  const text = nz(raw);
  const dict = dictionary || loadKeywords();

  const tickets = new Set();
  for (const m of raw.matchAll(/DO[-_ ]?(\d{2,6})/gi)) tickets.add(`DO-${m[1]}`);
  if (ticket) for (const m of String(ticket).matchAll(/(\d{2,6})/g)) tickets.add(`DO-${m[1]}`);

  const hashes = new Set();
  for (const m of raw.matchAll(/\b[0-9a-f]{8,40}\b/gi)) hashes.add(m[0].toLowerCase());

  const tokens = new Set();
  const cats = new Set();
  const primaryCats = new Set();
  const textLen = Math.max(1, text.length);
  for (const [category, words] of Object.entries(dict)) {
    for (const word of words) {
      if (word && text.includes(word)) {
        tokens.add(word);
        cats.add(category);
        if (text.indexOf(word) / textLen <= 0.45) primaryCats.add(category);
      }
    }
  }
  for (const kw of keywords || []) {
    const n = nz(kw);
    if (n) tokens.add(n);
  }
  if (!tokens.size && !tickets.size && !hashes.size) {
    for (const run of raw.match(CJK_RUN) || []) {
      const stripped = STOPWORDS.reduce((acc, word) => acc.split(word).join(''), run);
      const n = nz(stripped);
      if (n.length >= 2) tokens.add(n);
      if (tokens.size >= 8) break;
    }
  }

  return {
    raw,
    text,
    tickets: [...tickets],
    hashes: [...hashes],
    tokens: [...tokens],
    cats: [...cats],
    primaryCats: [...primaryCats],
  };
}

const TOKEN_BONUS = 40;
const TOKEN_BONUS_CAP = 200;

/**
 * 稀有词加权：越少见的词越能指认问题（「断层」比「摄像头」值钱得多）。
 * 语料只有几千条提交，每次查询现算 df 也就几万次 includes，不值得缓存。
 * 注意这跟「人工词典分类」无关：权重完全来自当前索引里的真实分布。
 */
export function computeTokenWeights(index, tokens) {
  const commits = Object.values(index.commits || {});
  const total = Math.max(1, commits.length);
  const weights = {};
  for (const token of tokens) {
    let df = 0;
    for (const commit of commits) if (nz(commit.subject).includes(token)) df += 1;
    weights[token] = df === 0 ? 0 : TOKEN_BONUS * (1 + Math.log10(total / df));
  }
  return weights;
}

export function scoreCommit(commit, query, options = {}) {
  const subject = commit.subject || '';
  let score = 0;
  const hits = [];

  if (query.tickets?.length && commit.ticket && query.tickets.includes(commit.ticket.toUpperCase())) {
    score += 1000;
    hits.push(commit.ticket);
  }
  if (query.hashes?.length && commit.hash && query.hashes.includes(commit.hash)) {
    score += 1000;
    hits.push(`#${commit.hash}`);
  }

  if (query.text) {
    score += nlScore(query.text, subject);
    const subjectNz = nz(subject);
    const matched = [];
    for (const token of query.tokens || []) {
      if (token && subjectNz.includes(token)) matched.push(token);
    }
    if (matched.length) {
      const weights = options.weights || {};
      let bonus = 0;
      for (const token of matched) bonus += weights[token] ?? TOKEN_BONUS;
      score += Math.min(TOKEN_BONUS_CAP, Math.round(bonus));
      hits.push(...matched);
    }
  }

  if (/修复|解决|fix/i.test(subject)) score += 10;

  if (options.model) {
    const scope = nz(commit.scope || '');
    const model = nz(options.model);
    if (scope && (scope.includes(model) || model.includes(scope))) score += 30;
  }

  return { score, hits: [...new Set(hits)] };
}

export function searchCommits(index, query, options = {}) {
  const threshold = options.threshold ?? 20;
  const limit = options.limit ?? 8;
  const weights = options.weights || computeTokenWeights(index, query.tokens || []);
  const rows = [];
  for (const commit of Object.values(index.commits || {})) {
    const { score, hits } = scoreCommit(commit, query, { ...options, weights });
    if (score <= 0 || score < threshold) continue;
    rows.push({ ...commit, score, hits });
  }
  rows.sort((a, b) => b.score - a.score || String(b.date).localeCompare(String(a.date)));
  return rows.slice(0, limit);
}

/* ------------------------------------------------------------------ *
 * 机型 / 产品线匹配（芯片绝对隔离）
 * ------------------------------------------------------------------ */

const ALIAS_PAIRS = [
  ['sp2', 'spring2'],
  ['apollo', 'apollo2'],
];

export function modelKeys(name) {
  const base = nz(name);
  const out = new Set([base]);
  for (const [a, b] of ALIAS_PAIRS) {
    if (base.includes(a)) out.add(base.replaceAll(a, b));
    if (base.includes(b)) out.add(base.replaceAll(b, a));
  }
  return [...out];
}

export function lineMatchesModel(line, model) {
  if (!model) return true;
  const keys = modelKeys(model);
  const product = nz(line.product);
  return keys.some((k) => product === k || product.includes(k) || k.includes(product));
}

/**
 * 选产品线：先芯片、再机型（精确匹配）、再系统、再客户，任一维度不匹配即排除。
 * @param {{platform?:string, os?:string, customer?:string, products?:string[]}} options
 */
export function selectLines(index, { platform, os, customer, products } = {}) {
  const wantedPlatform = platform ? String(platform).toUpperCase() : '';
  const wantedOS = os ? String(os).toUpperCase() : '';
  const productSet = products?.length ? new Set(products.map((p) => nz(p))) : null;
  return (index.lines || []).filter((line) => {
    if (wantedPlatform && String(line.platform || '').toUpperCase() !== wantedPlatform) return false;
    if (productSet && !productSet.has(nz(line.product))) return false;
    if (customer && nz(line.customer) !== nz(customer)) return false;
    if (wantedOS && String(line.os).toUpperCase() !== wantedOS) return false;
    return true;
  });
}

/** 兼容旧签名：先按机型别名展开出候选 product，再走 selectLines */
export function selectCustomerLines(index, { model, customer = 'CP', os, platform } = {}) {
  if (!model) return [];
  const products = [...new Set((index.lines || []).map((line) => line.product))].filter((product) =>
    modelKeys(model).some((key) => {
      const np = nz(product);
      return np === key || np.includes(key) || key.includes(np);
    }),
  );
  return selectLines(index, { platform, customer, os, products });
}

const byBuildDate = (a, b) => String(a.buildDate).localeCompare(String(b.buildDate));

/* ------------------------------------------------------------------ *
 * 判定
 * ------------------------------------------------------------------ */

export const VERDICTS = [
  'fixed_released',
  'fixed_other_line_only',
  'found_unscoped',
  'needs_model',
  'needs_baseline',
  'not_found',
];

export const KERNEL_RE = /内核|驱动|kernel|panic|oops|空指针|cif|mipi|dts|dtb|driver/i;

export function isKernelIssue(query, candidates, scope) {
  if (scope === 'kernel') return true;
  if (scope === 'local') return false;
  if ((query.cats || []).includes('kernel')) return true;
  return (candidates || []).some((c) => KERNEL_RE.test(c.subject || ''));
}

const REVERT_QUOTED = /revert\s*["“](.+?)["”]/i;

/**
 * 「修了又 revert」的识别：标题形如 `Revert "feat(common): DO-7610 ..."`。
 * 键用语义主体（去掉前缀/工单号），值为被回退提交对应的 revert 提交列表。
 */
export function buildRevertIndex(index) {
  const map = new Map();
  for (const commit of Object.values(index.commits || {})) {
    const match = REVERT_QUOTED.exec(commit.subject || '');
    if (!match) continue;
    const key = semanticText(match[1]);
    if (!key) continue;
    const list = map.get(key) || [];
    list.push(commit);
    map.set(key, list);
  }
  return map;
}

/** 某个提交在各条线上的落点 */
export function describePlacement(index, commit) {
  const lines = (commit.lines || []).map((id) => (index.lines || []).find((l) => l.id === id)).filter(Boolean);
  const sorted = [...lines].sort((a, b) => String(a.buildDate).localeCompare(String(b.buildDate)));
  const released = sorted.filter((l) => l.stage === 'PROD');
  return {
    lineIds: lines.map((l) => l.id),
    lines: sorted,
    earliestRelease: released[0] || null,
    latestRelease: released[released.length - 1] || null,
  };
}

const SYSTEM_OS = { D: 'DEBIAN', A: 'ANDROID', L: 'LINUX' };

export function evaluate(index, { query, candidates, model, platform, products, customer = 'CP', os, currentVersion, scope, dictionary } = {}) {
  const baseline = parseVersionString(currentVersion);
  // 现网版本串里带系统标识（_D_ / _A_ / _L_），没显式给 os 时用它锁定客户线
  const inferredOs = baseline.build?.system ? SYSTEM_OS[baseline.build.system] : '';
  const wantedOS = os || inferredOs;
  const customerLines = products?.length
    ? selectLines(index, { platform, os: wantedOS, customer, products })
    : selectCustomerLines(index, { model, platform, customer, os: wantedOS });
  const customerLineIds = new Set(customerLines.map((line) => line.id));

  // 「现象主语所属分类」闸门：避免一个恰好命中「空指针/内核」这类补充词、
  // 但跟摄像头毫无关系的提交（比如 incfs）把结论顶成「已修复」。
  const primaryWords = (query?.primaryCats || []).flatMap((category) => dictionary?.[category] || []);
  const inPrimaryCategory = (commit) => !primaryWords.length || primaryWords.some((word) => nz(commit.subject || '').includes(word));

  const revertIndex = buildRevertIndex(index);
  const enriched = (candidates || []).map((commit) => {
    const placement = describePlacement(index, commit);
    const inCustomer = placement.lines.filter((line) => customerLineIds.has(line.id));
    const inCustomerReleased = inCustomer.filter((line) => line.stage === 'PROD').sort(byBuildDate);
    // 同一客户线里如果存在针对它的 revert，这条「修复」不能算数
    const reverts = (revertIndex.get(semanticText(commit.subject || '')) || []).filter((revert) =>
      (revert.lines || []).some((id) => customerLineIds.has(id)),
    );
    return {
      ...commit,
      placement,
      inCustomerLine: inCustomer.map((line) => line.id),
      releasedIn: inCustomerReleased[0] || null,
      revertedBy: reverts.map((revert) => revert.hash),
      revertedInCustomer: reverts.length > 0,
    };
  });

  const notes = [];
  if (baseline.raw) notes.push(`现网基线：${baseline.raw}（构建日期 ${baseline.date || '未知'}）`);
  if (!index.lines?.length) {
    return { verdict: 'not_found', candidates: [], notes: ['索引为空，先跑 fix_sync'], baseline, customerLines: [] };
  }

  if (!enriched.length) {
    return {
      verdict: 'not_found',
      candidates: [],
      baseline,
      customerLines,
      notes: [...notes, '未找到匹配提交。建议：换更具体的现象词、补工单号/hash，或用 fix_log 直接看该机型全部提交标题。'],
    };
  }

  const top = enriched[0];
  // 结论取的是「客户线已含修复」的候选，而不是机械地只看 top1：
  // 现象描述常常同时命中多条提交（例如「摄像头」+「断层」分别命中不同提交），
  // 只要有一条足够可信的候选已经进了客户正式版，就应该回答「已修复」。
  const plausibility = Math.max(60, Math.round((top.score || 0) * 0.5));
  const inCustomerHit = enriched.find(
    (commit) =>
      commit.releasedIn && !commit.revertedInCustomer && (commit.score || 0) >= plausibility && inPrimaryCategory(commit),
  );
  const revertedInCustomer = enriched.filter((commit) => commit.releasedIn && commit.revertedInCustomer);
  const verdictTop = inCustomerHit || top;

  let verdict;
  if (!model && !products?.length) {
    verdict = 'found_unscoped';
    notes.push('未指定机型，无法判断是否已进入客户产品线；可传 model=SP2-10PRO 再查一次（可先 fix_models 探测写法）。');
  } else if (!customerLines.length) {
    verdict = 'needs_baseline';
    notes.push(`索引里没有「芯片 ${platform || '*'} + 客户 ${customer} + 系统 ${wantedOS || '*'}」的产品线。`);
  } else if (inCustomerHit) {
    verdict = 'fixed_released';
    for (const reverted of revertedInCustomer.slice(0, 3)) {
      notes.push(
        `候选 ${reverted.hash}（${reverted.score} 分）在客户线里已被 ${reverted.revertedBy.join('/')} revert，不计入「已修复」。`,
      );
    }
    if (inCustomerHit !== top) {
      notes.push(
        `结论依据 ${inCustomerHit.hash}（${inCustomerHit.score} 分，已进 ${inCustomerHit.releasedIn.build}）；` +
          `相似度最高的 ${top.hash}（${top.score} 分）不在该客户线。`,
      );
    }
  } else {
    verdict = 'fixed_other_line_only';
    const others = [...new Set(top.placement.lines.map((line) => `${line.platform}/${line.os}/${line.product}(${line.customer})`))];
    notes.push(`该修复只出现在其它产品线：${others.join('、')}；客户线（${customer}）未合入。`);
    if (baseline.date && String(top.date).replaceAll('-', '') <= baseline.date) {
      notes.push('注意：提交日期早于现网构建日期，需确认现网包是否来自未公开分支。');
    }
  }

  const topPlacementDate = String(verdictTop.date).replaceAll('-', '');
  if (verdict === 'fixed_released' && baseline.date && topPlacementDate > baseline.date) {
    notes.push(`修复在 ${verdictTop.releasedIn.build} 才进正式版，现网包（${baseline.date}）更旧，需要升级。`);
  }

  return { verdict, candidates: enriched, baseline, customerLines, notes, top: verdictTop, similarityTop: top };
}

/* ------------------------------------------------------------------ *
 * 覆盖面：其它机型 / 其它系统 / 其它芯片
 * ------------------------------------------------------------------ */

export function coverageOf(index, commitLines) {
  const contained = new Set(commitLines || []);
  const byModel = new Map();
  const byOS = new Map();
  const byPlatform = new Map();

  for (const line of index.lines || []) {
    const platform = line.platform || 'RK';
    const modelKey = `${platform}:${line.os}:${line.product}`;
    const m = byModel.get(modelKey) || { platform, os: line.os, product: line.product, total: 0, contained: [] };
    m.total += 1;
    if (contained.has(line.id)) {
      m.contained.push({
        stage: line.stage,
        customer: line.customer,
        lcd: line.lcd,
        build: line.build,
        buildDate: line.buildDate,
      });
    }
    byModel.set(modelKey, m);

    const o = byOS.get(line.os) || { os: line.os, total: 0, contained: 0, products: new Set() };
    o.total += 1;
    if (contained.has(line.id)) {
      o.contained += 1;
      o.products.add(line.product);
    }
    byOS.set(line.os, o);

    const p = byPlatform.get(platform) || { platform, total: 0, contained: 0 };
    p.total += 1;
    if (contained.has(line.id)) p.contained += 1;
    byPlatform.set(platform, p);
  }

  const models = [...byModel.values()]
    .map((m) => ({
      ...m,
      contained: m.contained.sort((a, b) => String(a.buildDate).localeCompare(String(b.buildDate))),
      missing: m.total - m.contained.length,
    }))
    .sort((a, b) => a.platform.localeCompare(b.platform) || a.os.localeCompare(b.os) || a.product.localeCompare(b.product));

  const oses = [...byOS.values()]
    .map((o) => ({ ...o, products: [...o.products].sort() }))
    .sort((a, b) => a.os.localeCompare(b.os));

  const platforms = [...byPlatform.values()].sort((a, b) => a.platform.localeCompare(b.platform));

  return {
    byModel: models,
    byOS: oses,
    byPlatform: platforms,
    syncedModels: models.filter((m) => m.contained.length).map((m) => `${m.product}(${m.platform}/${m.os})`),
    unsyncedModels: models.filter((m) => !m.contained.length).map((m) => `${m.product}(${m.platform}/${m.os})`),
  };
}
