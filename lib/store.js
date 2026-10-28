/**
 * 本地索引存储：<数据目录>/.fixfinder/
 *   index.json         索引清单（v2）：lines + lineHashes，不再内嵌 commits
 *   commits.json       全局去重提交表：hash -> { date,time,author,subject,scope,ticket,kind,revert }
 *   meta.json          各产品线最后一次成功抓取的构建与 tip
 *   raw/<id>.txt       原始 commit-logs.txt（唯一可离线重解析源）
 *   parsed/<id>.json   该线的提交 hash 数组（v1 时为完整对象数组，读取时自动兼容并迁移）
 *
 * 设计要点：同一个提交最多会出现在 20 条产品线里，只有 PROD 线之后仍有约 3.6k/26.7k 的重复，
 * 所以「提交正文只存一份、每条线只存 hash」是主要体积优化。
 */
import fs from 'node:fs';
import path from 'node:path';

export const INDEX_VERSION = 2;

export function safeId(id) {
  return String(id).replace(/[^A-Za-z0-9._-]+/g, '__');
}

async function mkdirp(dir) {
  await fs.promises.mkdir(dir, { recursive: true });
}

/** 解析数据目录：环境变量 -> 会话工作区 -> 进程 cwd */
export async function resolveDataDir(ctx, exec) {
  const candidates = [];
  if (process.env.DSH_FIXFINDER_DIR) candidates.push(process.env.DSH_FIXFINDER_DIR);

  const wd = ctx?.get?.('workingDirectory');
  if (wd && exec?.agent) {
    try {
      const dir = await wd.ensure(exec.agent, exec.signal);
      if (dir) candidates.push(path.join(dir, '.fixfinder'));
    } catch {
      /* 继续试下一个 */
    }
  }
  if (wd?.defaultDirectory) candidates.push(path.join(wd.defaultDirectory, '.fixfinder'));
  candidates.push(path.join(process.cwd(), '.fixfinder'));

  let lastErr;
  for (const dir of [...new Set(candidates)]) {
    try {
      await mkdirp(path.join(dir, 'raw'));
      await mkdirp(path.join(dir, 'parsed'));
      return dir;
    } catch (err) {
      lastErr = err;
    }
  }
  throw new Error(`无法创建数据目录，候选：${candidates.join(' | ')}（${lastErr?.message || ''}）`);
}

export const paths = {
  index: (dir) => path.join(dir, 'index.json'),
  commits: (dir) => path.join(dir, 'commits.json'),
  meta: (dir) => path.join(dir, 'meta.json'),
  raw: (dir, id) => path.join(dir, 'raw', `${safeId(id)}.txt`),
  parsed: (dir, id) => path.join(dir, 'parsed', `${safeId(id)}.json`),
};

async function readJson(file, fallback = null) {
  try {
    return JSON.parse(await fs.promises.readFile(file, 'utf8'));
  } catch {
    return fallback;
  }
}

async function writeJsonAtomic(file, value) {
  const tmp = `${file}.${process.pid}.tmp`;
  await fs.promises.writeFile(tmp, JSON.stringify(value), 'utf8');
  await fs.promises.rename(tmp, file);
}

export async function writeText(file, text) {
  const tmp = `${file}.${process.pid}.tmp`;
  await fs.promises.writeFile(tmp, text, 'utf8');
  await fs.promises.rename(tmp, file);
}

export const loadMeta = async (dir) => (await readJson(paths.meta(dir))) || { version: INDEX_VERSION, syncedAt: '', lines: {} };
export const saveMeta = async (dir, meta) => writeJsonAtomic(paths.meta(dir), meta);
export const saveIndex = async (dir, index) => writeJsonAtomic(paths.index(dir), index);
export const loadCommits = async (dir) => (await readJson(paths.commits(dir))) || {};
export const saveCommits = async (dir, commits) => writeJsonAtomic(paths.commits(dir), commits);

export const readParsed = async (dir, id) => readJson(paths.parsed(dir, id), []);
export const writeParsed = async (dir, id, hashes) => writeJsonAtomic(paths.parsed(dir, id), hashes);

const COMMIT_FIELDS = ['date', 'time', 'author', 'subject', 'scope', 'ticket', 'kind', 'revert'];

function slimCommit(commit) {
  const out = {};
  for (const key of COMMIT_FIELDS) out[key] = commit[key] ?? (key === 'revert' ? false : '');
  return out;
}

/**
 * 重建全局索引：
 * - parsed 里可能是 v2 的 hash 数组，也可能是 v1 的完整对象数组（自动迁移）
 * - 提交正文写进 commits.json（去重、只保留被引用的条目）
 * - index.json 只存 lines + lineHashes
 * @param {string} dir
 * @param {object} meta
 * @param {object} [extra]  { merge: { hash -> commit } } 本次同步新解析出的提交
 */
export async function rebuildIndex(dir, meta, extra = {}) {
  const table = await loadCommits(dir);
  const merged = extra.merge || {};

  const lines = [];
  const lineHashes = {};
  const referenced = new Set();

  for (const raw of Object.values(meta.lines || {})) {
    const parsed = (await readParsed(dir, raw.id)) || [];
    const hashes = [];

    for (const entry of parsed) {
      if (!entry) continue;
      if (typeof entry === 'string') {
        hashes.push(entry);
        continue;
      }
      // v1 兼容：对象里带完整提交信息，顺手迁移进去重表
      const hash = entry.hash || '';
      if (!hash) continue;
      if (!table[hash] && !merged[hash]) merged[hash] = slimCommit(entry);
      hashes.push(hash);
    }

    const uniq = [...new Set(hashes)].filter((hash) => hash && (table[hash] || merged[hash]));
    for (const hash of uniq) referenced.add(hash);
    lineHashes[raw.id] = uniq;

    const legacy = parsed.some((entry) => entry && typeof entry === 'object');
    if (legacy) await writeParsed(dir, raw.id, uniq);

    lines.push({
      id: raw.id,
      stage: raw.stage,
      platform: raw.platform,
      os: raw.os,
      product: raw.product,
      customer: raw.customer,
      lcd: raw.lcd,
      rel: raw.rel,
      dir: raw.dir,
      build: raw.build,
      buildDate: raw.buildDate,
      buildKind: raw.buildKind,
      buildVersion: raw.buildVersion,
      buildCommit: raw.buildCommit,
      tip: raw.tip || '',
      commitCount: uniq.length,
      fetchedAt: raw.fetchedAt,
    });
  }

  const commits = { ...table };
  for (const [hash, commit] of Object.entries(merged)) {
    if (!commits[hash]) commits[hash] = slimCommit(commit);
  }
  const kept = {};
  for (const [hash, commit] of Object.entries(commits)) if (referenced.has(hash)) kept[hash] = commit;

  await saveCommits(dir, kept);
  lines.sort((a, b) => a.id.localeCompare(b.id));

  const index = {
    version: INDEX_VERSION,
    generatedAt: new Date().toISOString(),
    syncedAt: meta.syncedAt || '',
    lineCount: lines.length,
    commitCount: referenced.size,
    lines,
    lineHashes,
    failures: meta.failures || [],
  };
  await saveIndex(dir, index);
  return index;
}

/**
 * 载入索引：index.json + commits.json 在内存里合成 index.commits（每个提交带 lines 反查）。
 * 版本不符或缺少提交表时返回 null，由调用方提示需要重新 fix_sync。
 */
export async function loadIndex(dir) {
  const raw = await readJson(paths.index(dir));
  if (!raw || raw.version !== INDEX_VERSION || !Array.isArray(raw.lines) || !raw.lineHashes) return null;

  const table = await loadCommits(dir);
  const commits = {};
  for (const [hash, meta] of Object.entries(table)) commits[hash] = { hash, ...meta, lines: [] };
  for (const [lineId, hashes] of Object.entries(raw.lineHashes)) {
    for (const hash of hashes) {
      const commit = commits[hash];
      if (commit) commit.lines.push(lineId);
    }
  }

  return { ...raw, commits };
}

export function indexAgeHours(index) {
  const ts = Date.parse(index?.generatedAt || '');
  if (!Number.isFinite(ts)) return Infinity;
  return (Date.now() - ts) / 3_600_000;
}
