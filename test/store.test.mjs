import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { rebuildIndex, loadIndex, loadCommits, INDEX_VERSION } from '../lib/store.js';

const LINE_A = 'PROD/RK/DEBIAN/SP2-10PRO/CP/LCD10';
const LINE_B = 'PROD/RK/ANDROID/SP2-10PRO/CP/LCD10';

function tmp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'fixfinder-store-'));
}

function seed(dir, { meta, parsed, commits }) {
  fs.mkdirSync(path.join(dir, 'raw'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'parsed'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'meta.json'), JSON.stringify(meta));
  for (const [lineId, hashes] of Object.entries(parsed)) {
    const file = path.join(dir, 'parsed', `${lineId.replace(/[^A-Za-z0-9._-]+/g, '__')}.json`);
    fs.writeFileSync(file, JSON.stringify(hashes));
  }
  if (commits) fs.writeFileSync(path.join(dir, 'commits.json'), JSON.stringify(commits));
}

const metaWith = (lines) => ({ version: INDEX_VERSION, syncedAt: '', lines: Object.fromEntries(lines.map((l) => [l.id, l])) });

const line = (id, extra = {}) => ({
  id, stage: 'PROD', platform: 'RK', os: id.includes('/DEBIAN/') ? 'DEBIAN' : 'ANDROID',
  product: 'SP2-10PRO', customer: 'CP', lcd: 'LCD10', build: 'CP_SP2-10PRO_D_V1.16_LCD10_B0_EU_20261010',
  buildDate: '20261010', buildKind: 'release', ...extra,
});

test('rebuildIndex：跨线重复提交只存一份，lineHashes 记录归属', async () => {
  const dir = tmp();
  const shared = { date: '2026-07-21', time: '15:42:02', author: 'wanghang', subject: 'feat(common): DO-7778 解决camera 热插拔出现图像断层问题', scope: 'common', ticket: 'DO-7778', kind: 'feat', revert: false };
  seed(dir, {
    meta: metaWith([line(LINE_A), line(LINE_B)]),
    parsed: { [LINE_A]: ['8b959775', 'aaaa1111'], [LINE_B]: ['8b959775'] },
    commits: { '8b959775': shared },
  });

  const index = await rebuildIndex(dir, metaWith([line(LINE_A), line(LINE_B)]), {
    merge: { aaaa1111: { ...shared, subject: 'fix(common): 只在一处', ticket: '' } },
  });
  assert.equal(index.version, INDEX_VERSION);
  assert.equal(index.commitCount, 2);
  assert.equal(index.commits, undefined, 'index.json 不内嵌 commits');

  const table = await loadCommits(dir);
  assert.deepEqual(Object.keys(table).sort(), ['8b959775', 'aaaa1111']);

  const loaded = await loadIndex(dir);
  assert.deepEqual(loaded.commits['8b959775'].lines.sort(), [LINE_A, LINE_B].sort());
  assert.deepEqual(loaded.commits['aaaa1111'].lines, [LINE_A]);
  assert.equal(loaded.lineHashes[LINE_B].length, 1);
});

test('rebuildIndex：裁掉不再被任何线引用的提交', async () => {
  const dir = tmp();
  const commit = (subject) => ({ date: '2026-01-01', time: '00:00:00', author: 'x', subject, scope: '', ticket: '', kind: 'feat', revert: false });
  seed(dir, {
    meta: metaWith([line(LINE_A)]),
    parsed: { [LINE_A]: ['11111111'] },
    commits: { '11111111': commit('引用中的'), '22222222': commit('已无人引用') },
  });
  await rebuildIndex(dir, metaWith([line(LINE_A)]));
  const table = await loadCommits(dir);
  assert.deepEqual(Object.keys(table), ['11111111']);
});

test('rebuildIndex：v1 的 parsed（完整对象数组）自动迁移成 hash 数组', async () => {
  const dir = tmp();
  seed(dir, {
    meta: metaWith([line(LINE_A)]),
    parsed: {
      [LINE_A]: [
        {
          hash: 'deadbeef', date: '2026-01-01', time: '00:00:00', author: 'old',
          subject: 'feat(common): 老提交', scope: 'common', ticket: '', kind: 'feat', revert: false,
        },
      ],
    },
  });
  const index = await rebuildIndex(dir, metaWith([line(LINE_A)]));
  assert.equal(index.commitCount, 1);
  const loaded = await loadIndex(dir);
  assert.equal(loaded.commits['deadbeef'].subject, 'feat(common): 老提交');
  const file = path.join(dir, 'parsed', `${LINE_A.replace(/[^A-Za-z0-9._-]+/g, '__')}.json`);
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), ['deadbeef']);
});

test('loadIndex：v1 索引（无 commits.json / version=1）被拒绝', async () => {
  const dir = tmp();
  fs.mkdirSync(path.join(dir, 'raw'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'parsed'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'index.json'), JSON.stringify({ version: 1, lines: [], commits: {} }));
  assert.equal(await loadIndex(dir), null);
});
