/**
 * 产品线发现：只遍历 PROD 下各芯片/系统，每条产品线只取最新一版**正式**构建。
 *
 * - 只索引 PROD：TEST/DEV 不进索引（数据量小一半，且「是否已修复」只关心正式版）。
 * - 芯片（platform）是路径里的一等维度：/PROD/<platform>/<os>/...，
 *   不同芯片的同名机型是不同产品线，绝不合并。
 * - 只认 `_V<数字>_` 正式构建；DEV / tip 构建跳过（若整条线只有 DEV，则回退到最新 release，
 *   一个 release 都没有时记 failures）。
 */
import { isBuildName, parseBuildName, compactDate } from './parse.js';

export const OSES = ['DEBIAN', 'ANDROID', 'LINUX'];

/** 需要索引的芯片，默认只有 RK（alist 当前只有 RK 目录）；可用逗号分隔扩展 */
export const PLATFORMS = String(process.env.DSH_FIXFINDER_PLATFORMS || 'RK')
  .split(',')
  .map((s) => s.trim().toUpperCase())
  .filter(Boolean);

export const ROOT_STAGE = 'PROD';
export const DEFAULT_ROOTS = PLATFORMS.flatMap((platform) => OSES.map((os) => `/${ROOT_STAGE}/${platform}/${os}`));

const MAX_LINE_DEPTH = 4;
const errorText = (err) => err?.message || String(err);

export async function mapPool(items, limit, worker, onError) {
  const results = new Array(items.length);
  let cursor = 0;
  const runners = new Array(Math.max(1, Math.min(limit, items.length))).fill(0).map(async () => {
    for (;;) {
      const idx = cursor++;
      if (idx >= items.length) return;
      try {
        results[idx] = await worker(items[idx], idx);
      } catch (err) {
        results[idx] = undefined;
        onError?.(items[idx], err);
      }
    }
  });
  await Promise.all(runners);
  return results;
}

function buildRank(entry) {
  const meta = parseBuildName(entry.name, entry.modified);
  return Number(meta.date || compactDate(entry.modified) || 0);
}

/** 只保留正式版构建（_V1.16_ 这类），按构建日期/修改时间倒序 */
export function pickReleaseBuild(entries) {
  const releases = entries.filter((entry) => isBuildName(entry.name) && parseBuildName(entry.name, entry.modified).kind === 'release');
  if (!releases.length) return null;
  releases.sort((a, b) => buildRank(b) - buildRank(a) || String(b.modified).localeCompare(String(a.modified)));
  return { best: releases[0], count: releases.length };
}

async function walkLine(client, dirPath, segs, ctx, out, onProgress, failures) {
  let children;
  try {
    children = (await client.list(dirPath)).filter((e) => e.isDir);
  } catch (err) {
    failures.push({ dir: dirPath, error: errorText(err) });
    return;
  }
  if (!children.length) return;

  const picked = pickReleaseBuild(children);
  if (picked) {
    const best = picked.best;
    const meta = parseBuildName(best.name, best.modified);
    const [product, customer = '', lcd = ''] = segs;
    out.push({
      id: `${ctx.stage}/${ctx.platform}/${ctx.os}/${segs.join('/')}`,
      stage: ctx.stage,
      platform: ctx.platform,
      os: ctx.os,
      product,
      customer: customer || 'CP',
      lcd,
      rel: segs.join('/'),
      dir: dirPath,
      build: best.name,
      buildDate: meta.date,
      buildKind: meta.kind,
      buildVersion: meta.version,
      buildCommit: meta.commit,
      modified: best.modified,
      buildCount: picked.count,
    });
    onProgress?.(out.length);
    return;
  }

  const hasBuilds = children.some((e) => isBuildName(e.name));
  if (hasBuilds) {
    // 目录里只有 DEV/tip 构建：不索引，但要留下可诊断的失败记录
    failures.push({ dir: dirPath, error: '只有 DEV/tip 构建，没有正式版（_V…_）' });
    return;
  }

  if (segs.length >= MAX_LINE_DEPTH) return;
  for (const child of children) {
    await walkLine(client, `${dirPath}/${child.name}`, [...segs, child.name], ctx, out, onProgress, failures);
  }
}

/**
 * 遍历所有根目录（默认 /PROD/<PLATFORM>/<OS>），返回产品线列表（每条线一个最新正式构建）。
 * 单条产品线失败不影响整体，错误写进 failures。
 */
export async function discoverLines({ client, roots = DEFAULT_ROOTS, concurrency = 6, onProgress } = {}) {
  const lines = [];
  const failures = [];

  for (const root of roots) {
    const parts = root.split('/').filter(Boolean);
    const ctx = {
      stage: (parts[0] || ROOT_STAGE).toUpperCase(),
      platform: (parts[1] || 'RK').toUpperCase(),
      os: (parts[2] || 'DEBIAN').toUpperCase(),
    };

    let products;
    try {
      products = (await client.list(root)).filter((e) => e.isDir);
    } catch (err) {
      failures.push({ root, error: errorText(err) });
      continue;
    }

    const local = [];
    await mapPool(
      products,
      concurrency,
      async (product) => {
        await walkLine(client, `${root}/${product.name}`, [product.name], ctx, local, onProgress, failures);
      },
      (product, err) => failures.push({ root: `${root}/${product.name}`, error: errorText(err) }),
    );
    lines.push(...local);
  }

  lines.sort((a, b) => a.id.localeCompare(b.id));
  return { lines, failures };
}
