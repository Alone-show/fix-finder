import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { runSync } from '../lib/sync.js';
import { loadIndex, loadMeta, INDEX_VERSION } from '../lib/store.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const LOG = fs.readFileSync(path.join(HERE, 'fixtures', 'sample-log.txt'), 'utf8');
const dir = (name) => ({ name, isDir: true, size: 0, modified: '' });

function makeFakeClient({ log = LOG } = {}) {
  const tree = {
    '/PROD/RK/DEBIAN': [dir('SP2-10PRO')],
    '/PROD/RK/DEBIAN/SP2-10PRO': [dir('CP')],
    '/PROD/RK/DEBIAN/SP2-10PRO/CP': [dir('LCD10')],
    '/PROD/RK/DEBIAN/SP2-10PRO/CP/LCD10': [dir('CP_SP2-10PRO_D_V1.16_LCD10_B0_EU_20261010')],
  };
  const stats = { logFetches: 0 };
  return {
    stats,
    async list(p) {
      if (p in tree) return tree[p];
      if (/^\/PROD\/RK\/[A-Z]+$/.test(p)) return [];
      throw new Error(`404 ${p}`);
    },
    async readText(p) {
      if (p.endsWith('commit-logs.txt')) {
        stats.logFetches += 1;
        return log;
      }
      throw new Error(`404 ${p}`);
    },
    async readOptionalText(p) {
      if (p.endsWith('latest-commit-id.txt')) return '1cb8e811\n';
      return null;
    },
  };
}

function tmpDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

test('runSync：建 v2 索引（提交去重 + 每条线只存 hash）', async () => {
  const dataDir = tmpDir('fixfinder-sync-');
  process.env.DSH_FIXFINDER_DIR = dataDir;
  try {
    const client = makeFakeClient();
    const first = await runSync({ ctx: { get: () => undefined }, exec: {}, client });
    assert.equal(first.stats.updated, 1);
    assert.equal(first.stats.skipped, 0);
    assert.equal(client.stats.logFetches, 1);
    assert.equal(first.index.lineCount, 1);
    assert.ok(first.index.commitCount >= 6);

    const rawIndex = JSON.parse(fs.readFileSync(path.join(dataDir, 'index.json'), 'utf8'));
    assert.equal(rawIndex.version, INDEX_VERSION);
    assert.equal(rawIndex.commits, undefined, 'index.json 不应再内嵌 commits');
    assert.ok(fs.existsSync(path.join(dataDir, 'commits.json')));

    // parsed/<line>.json 是 hash 数组，不是完整对象
    const parsed = JSON.parse(
      fs.readFileSync(path.join(dataDir, 'parsed', 'PROD__RK__DEBIAN__SP2-10PRO__CP__LCD10.json'), 'utf8'),
    );
    assert.ok(parsed.every((entry) => typeof entry === 'string'));
    assert.ok(parsed.includes('92cf9c82'));

    const index = await loadIndex(dataDir);
    assert.equal(index.version, INDEX_VERSION);
    assert.equal(index.lines[0].platform, 'RK');
    assert.equal(index.lines[0].tip, '1cb8e811');
    assert.ok(index.commits['92cf9c82']);
    assert.ok(index.commits['92cf9c82'].lines.includes('PROD/RK/DEBIAN/SP2-10PRO/CP/LCD10'));
    assert.ok(fs.existsSync(path.join(dataDir, 'raw')));

    const second = await runSync({ ctx: { get: () => undefined }, exec: {}, client });
    assert.equal(second.stats.updated, 0);
    assert.equal(second.stats.skipped, 1);
    assert.equal(client.stats.logFetches, 1, '构建未变化时不应重复下载 commit log');

    const meta = await loadMeta(dataDir);
    assert.equal(Object.keys(meta.lines).length, 1);
    assert.ok(meta.syncedAt);
  } finally {
    delete process.env.DSH_FIXFINDER_DIR;
  }
});

test('runSync：only 过滤产品线', async () => {
  const dataDir = tmpDir('fixfinder-only-');
  process.env.DSH_FIXFINDER_DIR = dataDir;
  try {
    const client = makeFakeClient();
    const res = await runSync({ ctx: { get: () => undefined }, exec: {}, client, only: 'MEGA1' });
    assert.equal(res.stats.targeted, 0);
    assert.equal(res.stats.updated, 0);
  } finally {
    delete process.env.DSH_FIXFINDER_DIR;
  }
});

test('runSync：日志为空时报失败但保留索引结构', async () => {
  const dataDir = tmpDir('fixfinder-empty-');
  process.env.DSH_FIXFINDER_DIR = dataDir;
  try {
    const client = makeFakeClient({ log: '' });
    const res = await runSync({ ctx: { get: () => undefined }, exec: {}, client });
    assert.equal(res.stats.failed, 1);
    const index = await loadIndex(dataDir);
    assert.equal(index.lineCount, 0);
    assert.equal(index.commitCount, 0);
  } finally {
    delete process.env.DSH_FIXFINDER_DIR;
  }
});

test('runSync：旧 v1 索引（parsed 存完整对象）可自动迁移', async () => {
  const dataDir = tmpDir('fixfinder-migrate-');
  process.env.DSH_FIXFINDER_DIR = dataDir;
  fs.mkdirSync(path.join(dataDir, 'raw'), { recursive: true });
  fs.mkdirSync(path.join(dataDir, 'parsed'), { recursive: true });
  const lineId = 'PROD/RK/DEBIAN/SP2-10PRO/CP/LCD10';
  const legacy = [
    {
      hash: 'deadbeef', date: '2026-01-01', author: 'old', subject: 'feat(common): 老提交',
      scope: 'common', ticket: '', kind: 'feat', revert: false,
    },
  ];
  fs.writeFileSync(path.join(dataDir, 'parsed', 'PROD__RK__DEBIAN__SP2-10PRO__CP__LCD10.json'), JSON.stringify(legacy));
  fs.writeFileSync(
    path.join(dataDir, 'meta.json'),
    JSON.stringify({
      version: 1,
      syncedAt: '',
      lines: {
        [lineId]: {
          id: lineId, stage: 'PROD', platform: 'RK', os: 'DEBIAN', product: 'SP2-10PRO', customer: 'CP', lcd: 'LCD10',
          build: 'CP_SP2-10PRO_D_V1.00_LCD10_B0_EU_20260101', buildDate: '20260101', buildKind: 'release',
        },
      },
    }),
  );
  fs.writeFileSync(path.join(dataDir, 'index.json'), JSON.stringify({ version: 1, lines: [] }));

  try {
    const client = makeFakeClient();
    const res = await runSync({ ctx: { get: () => undefined }, exec: {}, client });
    assert.equal(res.stats.failed, 0);
    const index = await loadIndex(dataDir);
    assert.equal(index.version, INDEX_VERSION);
    // 老提交仍被下载覆盖 -> deadbeef 不在新日志里，应被裁掉；新日志的提交应进表
    assert.ok(index.commits['92cf9c82']);
    assert.equal(index.commits['deadbeef'], undefined);
    const parsed = JSON.parse(
      fs.readFileSync(path.join(dataDir, 'parsed', 'PROD__RK__DEBIAN__SP2-10PRO__CP__LCD10.json'), 'utf8'),
    );
    assert.ok(parsed.every((entry) => typeof entry === 'string'));
  } finally {
    delete process.env.DSH_FIXFINDER_DIR;
  }
});
