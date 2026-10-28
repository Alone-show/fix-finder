/**
 * commit log / 构建名解析。
 *
 * commit-logs.txt 每行一条提交：
 *   2026-09-22-19:56:25|xin peng|feat(cp-sp2-10pro): DO-8486 更新cpmedia到2.0.6|db5ad220
 * 少数行缺失 hash，或 body 已被压平成单行，所以解析要有兜底。
 */

const LOG_STRICT = /^(\d{4}-\d{2}-\d{2})[-T ](\d{2}:\d{2}:\d{2})\|([^|]*)\|(.*)\|([0-9a-fA-F]{6,40})\s*$/;
const LOG_LOOSE = /^(\d{4}-\d{2}-\d{2})[-T ](\d{2}:\d{2}:\d{2})\|(.*)$/;
const HEX = /^[0-9a-f]{6,40}$/i;

const PUNCT = /[\s\u3000，。、；：！？,.;:!?（）()【】[\]{}“”"'’‘《》<>·~`@#$%^&*+=|\\/_—–-]+/g;

/** 匹配用归一化：全角转半角、小写、去空白与标点 */
export function nz(input) {
  return String(input ?? '')
    .normalize('NFKC')
    .toLowerCase()
    .replace(PUNCT, '');
}

/** 展示用归一化：全角转半角、压空格、去首尾空白 */
export function displaySubject(input) {
  return String(input ?? '')
    .normalize('NFKC')
    .replace(/\s+/g, ' ')
    .trim();
}

export function scopeOf(subject) {
  const m = /^[A-Za-z_]+\(([^)]+)\)\s*:/.exec(subject);
  return m ? m[1].trim().toLowerCase() : '';
}

export function ticketOf(subject) {
  const m = /(?:^|[^A-Za-z0-9])DO[-_ ]?(\d{2,6})\b/i.exec(subject);
  return m ? `DO-${m[1]}` : '';
}

export function kindOf(subject) {
  const m = /^([A-Za-z_]+)\s*(?:\([^)]*\))?\s*:/.exec(subject);
  return m ? m[1].toLowerCase() : '';
}

function buildCommit(date, time, author, subject, hash) {
  const clean = displaySubject(subject);
  const fullHash = (hash || '').toLowerCase();
  return {
    hash: fullHash.slice(0, 8),
    hashFull: fullHash,
    date,
    time,
    author: String(author || '').normalize('NFKC').trim(),
    subject: clean,
    ts: Date.parse(`${date}T${time}+08:00`) || 0,
    scope: scopeOf(clean),
    ticket: ticketOf(clean),
    kind: kindOf(clean),
    revert: /^revert\b/i.test(clean) || /:\s*revert\b/i.test(clean),
  };
}

/** 解析单行；解析不出来返回 null */
export function parseCommitLine(line) {
  const raw = String(line ?? '').replace(/\r$/, '').trim();
  if (!raw) return null;

  const strict = LOG_STRICT.exec(raw);
  if (strict) return buildCommit(strict[1], strict[2], strict[3], strict[4], strict[5]);

  const loose = LOG_LOOSE.exec(raw);
  if (!loose) return null;
  const rest = loose[3];
  const parts = rest.split('|');
  let hash = '';
  const tail = (parts[parts.length - 1] || '').trim();
  if (HEX.test(tail)) {
    hash = tail;
    parts.pop();
  }
  const author = parts.shift() ?? '';
  const subject = parts.join('|');
  if (!displaySubject(subject)) return null;
  return buildCommit(loose[1], loose[2], author, subject, hash);
}

/**
 * 解析整份 commit log。
 * 同一个 hash 出现多次（merge / revert 后重放）时保留最后一次出现的记录；
 * 没有 hash 的行用 `date|subject` 作去重键。
 */
export function parseCommitLog(text) {
  const map = new Map();
  for (const line of String(text ?? '').split('\n')) {
    const commit = parseCommitLine(line);
    if (!commit) continue;
    const key = commit.hash || `~${commit.date}|${commit.subject}`;
    const prev = map.get(key);
    if (prev) {
      commit.revert = commit.revert || prev.revert;
      commit.ts = Math.max(commit.ts || 0, prev.ts || 0);
    }
    map.set(key, commit);
  }
  return [...map.values()];
}

/* ------------------------------------------------------------------ *
 * 构建目录名
 * ------------------------------------------------------------------ */

const BUILD_DATE = /_(\d{8})$/;
const BUILD_LCD = /_(LCD[0-9A-Za-z][0-9A-Za-z-]*)_/;
const BUILD_DEV = /_DEV-([0-9A-Fa-f]{6,40})_/;
const BUILD_RELEASE = /_(V\d+(?:\.\d+)*)_/;
const BUILD_TIP = /_([0-9A-Fa-f]{8})_/;
const BUILD_SYSTEM = /_([DA])_/;

export function compactDate(iso) {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(iso ?? ''));
  return m ? `${m[1]}${m[2]}${m[3]}` : '';
}

/**
 * 解析构建目录名，例如：
 *   CP_SP2-10PRO_D_V1.16_LCD10_B0_EU_20261010      -> release V1.16 / 20261010
 *   CP_SP2-10PRO_D_DEV-D9D6CD3E_LCD10_B0_EU_20261026 -> dev  d9d6cd3e
 *   CP_SP2-10PRO_D_1CB8E811_LCD10_B0_EU_20260928    -> tip  1cb8e811
 *   CP_SP2-10PRO_D_V1.07_LCD10_B0_4G_EN_20240403    -> release V1.07
 */
export function parseBuildName(name, modified) {
  const raw = String(name ?? '');
  const date = (BUILD_DATE.exec(raw) || [])[1] || compactDate(modified);
  const lcd = (BUILD_LCD.exec(`${raw}_`) || [])[1] || '';
  const dev = (BUILD_DEV.exec(`${raw}_`) || [])[1] || '';
  const release = (BUILD_RELEASE.exec(`${raw}_`) || [])[1] || '';
  const tip = (BUILD_TIP.exec(`${raw}_`) || [])[1] || '';
  const system = (BUILD_SYSTEM.exec(`${raw}_`) || [])[1] || '';

  let kind = 'other';
  let version = '';
  let commit = '';
  if (dev) {
    kind = 'dev';
    version = `DEV-${dev.toUpperCase()}`;
    commit = dev.toLowerCase();
  } else if (release) {
    kind = 'release';
    version = release;
  } else if (tip) {
    kind = 'tip';
    version = tip.toUpperCase();
    commit = tip.toLowerCase();
  }

  return { name: raw, date, lcd, system, kind, version, commit };
}

/** 构建目录是否像一版固件包 */
export function isBuildName(name) {
  const raw = String(name ?? '');
  if (!BUILD_DATE.test(raw)) return false;
  return /_DEV-[0-9A-Fa-f]{6,40}_/.test(raw) || /_V\d+(?:\.\d+)*_/.test(raw) || /_[0-9A-Fa-f]{8}_/.test(raw);
}

/** 版本串（如客户现网固件名）里解析日期与 commit */
export function parseVersionString(version) {
  const raw = String(version ?? '').trim();
  if (!raw) return { raw: '', date: '', commit: '', build: null };
  const build = parseBuildName(raw);
  return {
    raw,
    date: build.date,
    commit: build.commit,
    version: build.version,
    kind: build.kind,
    build,
  };
}
