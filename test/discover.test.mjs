import test from 'node:test';
import assert from 'node:assert/strict';

import { discoverLines, pickReleaseBuild, DEFAULT_ROOTS } from '../lib/discover.js';

const dir = (name, isDir = true) => ({ name, isDir, size: 0, modified: '' });

function fakeTree() {
  return {
    '/PROD/RK/DEBIAN': [dir('SP2-10PRO')],
    '/PROD/RK/DEBIAN/SP2-10PRO': [dir('CP'), dir('ZLGQ')],
    '/PROD/RK/DEBIAN/SP2-10PRO/CP': [dir('LCD10')],
    '/PROD/RK/DEBIAN/SP2-10PRO/CP/LCD10': [
      dir('CP_SP2-10PRO_D_V1.15_LCD10_B0_EU_20260724'),
      dir('CP_SP2-10PRO_D_V1.16_LCD10_B0_EU_20261010'),
      dir('README.md', false),
    ],
    '/PROD/RK/DEBIAN/SP2-10PRO/ZLGQ': [dir('LCD10')],
    '/PROD/RK/DEBIAN/SP2-10PRO/ZLGQ/LCD10': [dir('ZLGQ_SP2-10PRO_D_V1.03_LCD10_B0_CN_20260429')],
  };
}

test('只索引 PROD：默认根目录里没有 TEST', () => {
  assert.ok(DEFAULT_ROOTS.length > 0);
  assert.ok(DEFAULT_ROOTS.every((root) => root.startsWith('/PROD/')));
  assert.ok(!DEFAULT_ROOTS.some((root) => root.includes('/TEST/')));
});

test('discoverLines：识别产品线、选最新正式构建、芯片来自路径', async () => {
  const tree = fakeTree();
  const client = {
    async list(p) {
      if (!(p in tree)) throw new Error(`404 ${p}`);
      return tree[p];
    },
  };
  const { lines, failures } = await discoverLines({ client, roots: ['/PROD/RK/DEBIAN'] });
  assert.equal(lines.length, 2);
  assert.equal(failures.length, 0);
  const cp = lines.find((l) => l.customer === 'CP');
  assert.equal(cp.id, 'PROD/RK/DEBIAN/SP2-10PRO/CP/LCD10');
  assert.equal(cp.platform, 'RK');
  assert.equal(cp.build, 'CP_SP2-10PRO_D_V1.16_LCD10_B0_EU_20261010');
  assert.equal(cp.buildDate, '20261010');
  assert.equal(cp.product, 'SP2-10PRO');
  assert.equal(cp.lcd, 'LCD10');
  assert.equal(cp.buildKind, 'release');
});

test('discoverLines：DEV 构建更新时仍只取正式版', async () => {
  const tree = fakeTree();
  tree['/PROD/RK/DEBIAN/SP2-10PRO/CP/LCD10'] = [
    dir('CP_SP2-10PRO_D_V1.16_LCD10_B0_EU_20261010'),
    dir('CP_SP2-10PRO_D_DEV-D9D6CD3E_LCD10_B0_EU_20261026'),
  ];
  const client = { async list(p) { if (!(p in tree)) throw new Error('404'); return tree[p]; } };
  const { lines } = await discoverLines({ client, roots: ['/PROD/RK/DEBIAN'] });
  const cp = lines.find((l) => l.customer === 'CP');
  assert.equal(cp.build, 'CP_SP2-10PRO_D_V1.16_LCD10_B0_EU_20261010');
  assert.equal(cp.buildKind, 'release');
});

test('discoverLines：只有 DEV/tip 构建的线不索引，但记 failures', async () => {
  const tree = {
    '/PROD/RK/DEBIAN': [dir('SP2-10PRO')],
    '/PROD/RK/DEBIAN/SP2-10PRO': [dir('CP')],
    '/PROD/RK/DEBIAN/SP2-10PRO/CP': [dir('LCD10')],
    '/PROD/RK/DEBIAN/SP2-10PRO/CP/LCD10': [dir('CP_SP2-10PRO_D_DEV-D9D6CD3E_LCD10_B0_EU_20261026')],
  };
  const client = { async list(p) { if (!(p in tree)) throw new Error('404'); return tree[p]; } };
  const { lines, failures } = await discoverLines({ client, roots: ['/PROD/RK/DEBIAN'] });
  assert.equal(lines.length, 0);
  assert.ok(failures.some((f) => /DEV|正式版/.test(f.error)));
});

test('discoverLines：不同芯片根目录互不干扰', async () => {
  const tree = {
    '/PROD/RK/DEBIAN': [dir('SP2-10PRO')],
    '/PROD/RK/DEBIAN/SP2-10PRO': [dir('CP')],
    '/PROD/RK/DEBIAN/SP2-10PRO/CP': [dir('LCD10')],
    '/PROD/RK/DEBIAN/SP2-10PRO/CP/LCD10': [dir('CP_SP2-10PRO_D_V1.16_LCD10_B0_EU_20261010')],
    '/PROD/T3/ANDROID': [dir('SPRING2')],
    '/PROD/T3/ANDROID/SPRING2': [dir('CP')],
    '/PROD/T3/ANDROID/SPRING2/CP': [dir('LCD7')],
    '/PROD/T3/ANDROID/SPRING2/CP/LCD7': [dir('CP_SPRING2_A_V1.03_LCD7_B0_EU_20260930')],
  };
  const client = { async list(p) { if (!(p in tree)) throw new Error('404'); return tree[p]; } };
  const { lines } = await discoverLines({ client, roots: ['/PROD/RK/DEBIAN', '/PROD/T3/ANDROID'] });
  assert.equal(lines.length, 2);
  const rk = lines.find((l) => l.platform === 'RK');
  const t3 = lines.find((l) => l.platform === 'T3');
  assert.equal(rk.id, 'PROD/RK/DEBIAN/SP2-10PRO/CP/LCD10');
  assert.equal(t3.id, 'PROD/T3/ANDROID/SPRING2/CP/LCD7');
});

test('discoverLines：根目录整体不可用时不抛异常', async () => {
  const client = { async list() { throw new Error('boom'); } };
  const { lines, failures } = await discoverLines({ client, roots: ['/PROD/RK/DEBIAN'] });
  assert.equal(lines.length, 0);
  assert.equal(failures.length, 1);
  assert.match(failures[0].error, /boom/);
});

test('pickReleaseBuild：忽略 DEV/tip 与普通文件', () => {
  const picked = pickReleaseBuild([
    dir('CP_SP2-10PRO_D_DEV-D9D6CD3E_LCD10_B0_EU_20261026'),
    dir('CP_SP2-10PRO_D_V1.15_LCD10_B0_EU_20260724'),
    dir('CP_SP2-10PRO_D_V1.16_LCD10_B0_EU_20261010'),
    dir('README.md', false),
  ]);
  assert.equal(picked.best.name, 'CP_SP2-10PRO_D_V1.16_LCD10_B0_EU_20261010');
  assert.equal(picked.count, 2);
  assert.equal(pickReleaseBuild([dir('CP_SP2-10PRO_D_DEV-D9D6CD3E_LCD10_B0_EU_20261026')]), null);
});
