/**
 * 自然语言匹配：语料已经很小（PROD 侧约 4.1k 个去重提交，单机型+系统 < 600 条），
 * 不再需要「关键词词典 + 分类加权 + IDF」那套先验，直接用标题与现象描述的字面相似度排序：
 *
 *   1) 先剥掉标题里的提交前缀（`feat(scope):`）和工单号（`DO-7778`），只留语义主体；
 *   2) 归一化后取字符 bigram 集合做 Jaccard（中文无空格分词，bigram 对改写/同义短语更稳）；
 *   3) 最长公共子串长度加成（「空指针」「cif」这类实词命中比零散字面更有信息量）；
 *   4) 数字/英文片段（cif、nvp6158、1080p、4g）做 token 交集加成；
 *   5) 查询整体是标题子串时给一次性加成。
 *
 * 阈值不在这里定，由 search.js 按 score 截断；这里只负责打分。
 */
import { nz } from './parse.js';

const PREFIX_RE = /^(feat|fix|chore|style|refactor|perf|test|docs|build|ci|revert)(\([^)]*\))?\s*[:：]?\s*/i;
const TICKET_RE = /DO[-_ ]?\d{2,6}/gi;

/** 标题/描述归一化：去提交前缀与工单号，再 nz() */
export function semanticText(text) {
  const base = String(text ?? '')
    .normalize('NFKC')
    .replace(PREFIX_RE, '')
    .replace(TICKET_RE, ' ');
  return nz(base);
}

export function bigrams(text) {
  const out = [];
  for (let i = 0; i < text.length - 1; i++) out.push(text.slice(i, i + 2));
  return out;
}

/** 字符 bigram Jaccard，0..1；入参需已归一化 */
export function bigramSimilarity(x, y) {
  if (!x || !y) return 0;
  if (x === y) return 1;
  if (x.length < 2 || y.length < 2) return 0;
  const A = new Set(bigrams(x));
  const B = new Set(bigrams(y));
  if (!A.size || !B.size) return 0;
  let inter = 0;
  for (const gram of A) if (B.has(gram)) inter += 1;
  return (2 * inter) / (A.size + B.size);
}

/** 原始文本相似度（0..1），内部会做语义归一 */
export function similarity(a, b) {
  return bigramSimilarity(semanticText(a), semanticText(b));
}

/** 英文单词/型号片段与数字片段（1080p → 1080p，nvp6158 → nvp6158） */
export function tokens(text) {
  const raw = String(text ?? '').normalize('NFKC').toLowerCase();
  return raw.match(/[a-z]+\d*[a-z]*|\d+[a-z]*/g) || [];
}

/** 最长公共子串长度（已归一化字符串，O(n·m)，标题都在 200 字内） */
export function longestCommonRun(x, y) {
  if (!x || !y) return 0;
  let best = 0;
  let prev = new Array(y.length + 1).fill(0);
  for (let i = 1; i <= x.length; i++) {
    const cur = new Array(y.length + 1).fill(0);
    for (let j = 1; j <= y.length; j++) {
      if (x[i - 1] === y[j - 1]) {
        cur[j] = prev[j - 1] + 1;
        if (cur[j] > best) best = cur[j];
      }
    }
    prev = cur;
  }
  return best;
}

export const MAX_NL_SCORE = 600;

/**
 * @param {string} query   现象描述
 * @param {string} subject 提交标题
 * @returns {number} 0..600
 */
export function nlScore(query, subject) {
  const q = semanticText(query);
  const s = semanticText(subject);
  if (!q || !s) return 0;
  if (q === s) return MAX_NL_SCORE;

  const shortQuery = q.length < 4;
  const sim = shortQuery ? 0 : bigramSimilarity(q, s);
  const run = shortQuery ? 0 : longestCommonRun(q, s);

  let tokenHits = 0;
  {
    const set = new Set(tokens(subject));
    for (const token of new Set(tokens(query))) if (token.length >= 2 && set.has(token)) tokenHits += 1;
  }

  let score = Math.round(sim * 300) + tokenHits * 40;
  if (run >= 6) score += 120;
  else if (run >= 4) score += 90;
  else if (run >= 3) score += 50;
  if (!shortQuery && q.length >= 3 && s.includes(q)) score += 150;
  return Math.min(MAX_NL_SCORE, score);
}
