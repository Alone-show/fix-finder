/**
 * 覆盖矩阵：给定 hash / 工单号 / 标题，回答「哪些产品线包含它」。
 * 因为 cherry-pick 常常换 hash，这里额外提供工单号与标题相似度两条兜底通道。
 * 芯片（platform）是矩阵的一等维度：同名机型不同芯片是不同行。
 */
import { similarity, semanticText } from './nl.js';

export { similarity };

/** 去掉 feat/fix 前缀、工单号与标点，只留语义主体，便于跨分支比较 */
export function semanticKey(subject) {
  return semanticText(subject);
}

function matchesHash(commit, hash) {
  const h = String(hash).toLowerCase();
  if (!h) return false;
  if (commit.hash === h) return true;
  const short = h.slice(0, 8);
  return commit.hash === short || (commit.hashFull || '').startsWith(h) || h.startsWith(commit.hash);
}

function findMatches(index, { hash, ticket, subject, includeSimilar, threshold }) {
  const matches = [];
  const key = semanticKey(subject || '');
  for (const commit of Object.values(index.commits || {})) {
    let kind = '';
    if (hash && commit.hash && matchesHash(commit, hash)) kind = 'exact';
    else if (ticket && commit.ticket && commit.ticket.toUpperCase() === String(ticket).toUpperCase().replace(/^DO[-_ ]?/i, 'DO-')) kind = 'ticket';
    else if (includeSimilar && key && similarity(key, commit.subject) >= threshold) kind = 'similar';
    if (kind) matches.push({ ...commit, matchKind: kind });
  }
  const order = { exact: 0, ticket: 1, similar: 2 };
  matches.sort((a, b) => order[a.matchKind] - order[b.matchKind] || String(b.date).localeCompare(String(a.date)));
  return matches;
}

export function buildMatrix(index, { hash, ticket, subject, platform, os, includeSimilar = true, threshold = 0.55 } = {}) {
  const matches = findMatches(index, { hash, ticket, subject, includeSimilar, threshold });
  if (!matches.length) return { matches: [], rows: [], summary: { byModel: [], byOS: [], byPlatform: [] } };

  // 每个产品线归属到「第一个命中」的提交
  const hitByLine = new Map();
  for (const commit of matches) {
    for (const lineId of commit.lines || []) {
      if (!hitByLine.has(lineId)) hitByLine.set(lineId, commit);
    }
  }

  const wantedPlatform = platform ? String(platform).toUpperCase() : '';
  const wantedOS = os ? String(os).toUpperCase() : '';
  const lines = (index.lines || []).filter(
    (line) =>
      (!wantedPlatform || String(line.platform || '').toUpperCase() === wantedPlatform) &&
      (!wantedOS || String(line.os).toUpperCase() === wantedOS),
  );

  const rows = lines.map((line) => {
    const hit = hitByLine.get(line.id);
    return {
      line: line.id,
      stage: line.stage,
      platform: line.platform || 'RK',
      os: line.os,
      product: line.product,
      customer: line.customer,
      lcd: line.lcd,
      build: line.build,
      buildDate: line.buildDate,
      tip: line.tip,
      contained: !!hit,
      matchKind: hit?.matchKind || '',
      matchedHash: hit?.hash || '',
      matchedSubject: hit?.subject || '',
    };
  });

  const byModelMap = new Map();
  const byOSMap = new Map();
  const byPlatformMap = new Map();
  for (const row of rows) {
    const mk = `${row.platform}:${row.os}:${row.product}`;
    const m = byModelMap.get(mk) || { platform: row.platform, os: row.os, product: row.product, total: 0, contained: [], matchKinds: new Set() };
    m.total += 1;
    if (row.contained) {
      m.contained.push({ stage: row.stage, customer: row.customer, lcd: row.lcd, build: row.build, buildDate: row.buildDate, matchKind: row.matchKind });
      m.matchKinds.add(row.matchKind);
    }
    byModelMap.set(mk, m);

    const o = byOSMap.get(row.os) || { os: row.os, total: 0, contained: 0 };
    o.total += 1;
    if (row.contained) o.contained += 1;
    byOSMap.set(row.os, o);

    const p = byPlatformMap.get(row.platform) || { platform: row.platform, total: 0, contained: 0 };
    p.total += 1;
    if (row.contained) p.contained += 1;
    byPlatformMap.set(row.platform, p);
  }

  const byModel = [...byModelMap.values()]
    .map((m) => ({
      ...m,
      matchKinds: [...m.matchKinds],
      contained: m.contained.sort((a, b) => String(a.buildDate).localeCompare(String(b.buildDate))),
    }))
    .sort((a, b) => a.platform.localeCompare(b.platform) || a.os.localeCompare(b.os) || a.product.localeCompare(b.product));

  return {
    matches: matches.map((m) => ({
      hash: m.hash,
      date: m.date,
      author: m.author,
      subject: m.subject,
      ticket: m.ticket,
      matchKind: m.matchKind,
      lineCount: (m.lines || []).length,
    })),
    rows,
    summary: {
      byModel,
      byOS: [...byOSMap.values()].sort((a, b) => a.os.localeCompare(b.os)),
      byPlatform: [...byPlatformMap.values()].sort((a, b) => a.platform.localeCompare(b.platform)),
    },
  };
}
