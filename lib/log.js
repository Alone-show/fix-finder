/**
 * fix_log 的核心：把某个范围（芯片/系统/机型/客户）的 PROD 提交原样取出来，去重后交给调用方。
 *
 * 用途：语料已经很小（全量 PROD 约 4.1k 条，单机型+系统 < 600 条），
 * 与其让工具用先验去「猜」，不如把提交标题直接投递出来做自然语言判断。
 * query 存在时只附 nlScore 用于排序/参考，**不做过滤**。
 */
import { nz } from './parse.js';
import { nlScore } from './nl.js';

const compact = (date) => String(date ?? '').replace(/-/g, '');
const MAX_LIMIT = 1000;

function lineRef(line) {
  return {
    platform: line.platform || 'RK',
    os: line.os,
    stage: line.stage,
    product: line.product,
    customer: line.customer,
    lcd: line.lcd,
    build: line.build,
    buildDate: line.buildDate,
  };
}

export function collectCommits(index, { platform, os, product, customer, since, until, query, limit = 200, offset = 0 } = {}) {
  const wantedPlatform = platform ? String(platform).toUpperCase() : '';
  const wantedOS = os ? String(os).toUpperCase() : '';
  const wantedCustomer = customer ? nz(customer) : '';
  const wantedProduct = product ? nz(product) : '';

  const lines = (index?.lines || []).filter(
    (line) =>
      (!wantedPlatform || String(line.platform || 'RK').toUpperCase() === wantedPlatform) &&
      (!wantedOS || String(line.os).toUpperCase() === wantedOS) &&
      (!wantedCustomer || nz(line.customer) === wantedCustomer) &&
      (!wantedProduct || nz(line.product) === wantedProduct || nz(line.product).includes(wantedProduct)),
  );

  const lineById = new Map(lines.map((line) => [line.id, line]));
  const hashSet = new Set();
  for (const line of lines) for (const hash of index.lineHashes[line.id] || []) hashSet.add(hash);

  const sinceKey = compact(since);
  const untilKey = compact(until);
  let commits = [];
  for (const hash of hashSet) {
    const commit = index.commits[hash];
    if (!commit) continue;
    const day = compact(commit.date);
    if (sinceKey && day < sinceKey) continue;
    if (untilKey && day > untilKey) continue;
    commits.push(commit);
  }

  const scored = commits.map((commit) => {
    const landing = [...new Set((commit.lines || []).filter((id) => lineById.has(id)))].map((id) => lineRef(lineById.get(id)));
    return {
      hash: commit.hash,
      date: commit.date,
      author: commit.author,
      subject: commit.subject,
      ticket: commit.ticket || '',
      revert: !!commit.revert,
      nlScore: query ? nlScore(query, commit.subject) : 0,
      lines: landing,
    };
  });

  if (query) scored.sort((a, b) => b.nlScore - a.nlScore || String(b.date).localeCompare(String(a.date)));
  else scored.sort((a, b) => String(b.date).localeCompare(String(a.date)) || String(b.hash).localeCompare(String(a.hash)));

  const size = Math.max(1, Math.min(MAX_LIMIT, Number(limit) || 200));
  const start = Math.max(0, Number(offset) || 0);
  const page = scored.slice(start, start + size);

  return {
    scope: {
      platform: wantedPlatform,
      os: wantedOS,
      product: product || '',
      customer: customer || '',
      since: since || '',
      until: until || '',
      lines: lines.length,
    },
    total: scored.length,
    returned: page.length,
    offset: start,
    limit: size,
    commits: page,
  };
}
