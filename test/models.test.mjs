import test from 'node:test';
import assert from 'node:assert/strict';

import { makeIndex } from './index-fixture.mjs';
import { buildCatalog, resolveModel, probeVersion, probeModel, platformsOf, gapScore, canonCore } from '../lib/models.js';

const index = makeIndex();

test('catalog：按芯片 + 机型分组，列出产线信息', () => {
  const catalog = buildCatalog(index);
  const sp2 = catalog.find((g) => g.product === 'SP2-10PRO' && g.platform === 'RK');
  assert.ok(sp2);
  assert.equal(sp2.lineCount, 2, 'DEBIAN + LINUX 两条线');
  assert.deepEqual(sp2.osList, ['DEBIAN', 'LINUX']);
  assert.deepEqual(sp2.customers, ['CP']);
  assert.deepEqual(platformsOf(catalog), ['RK', 'T3']);
});

test('resolveModel：SPRING2PRO 按 gap 规则归一到 SP2-10PRO', () => {
  const res = resolveModel(index, { model: 'SPRING2PRO', platform: 'RK' });
  assert.equal(res.status, 'ok');
  assert.equal(res.resolved.product, 'SP2-10PRO');
  assert.equal(res.matchKind, 'gap');
  assert.equal(res.score, 85);
  assert.equal(gapScore('sp2pro', canonCore('SP2-10PRO')), 85);
});

test('resolveModel：精确/别名/大小写与连字符', () => {
  assert.equal(resolveModel(index, { model: 'SP2-10PRO' }).matchKind, 'exact');
  assert.equal(resolveModel(index, { model: 'sp2 10pro' }).resolved.product, 'SP2-10PRO');
  const alias = resolveModel(index, { model: 'SPRING2-10PRO' });
  assert.equal(alias.resolved.product, 'SP2-10PRO');
  assert.equal(alias.matchKind, 'alias');
});

test('resolveModel：省略尺寸段有歧义时要求确认', () => {
  const res = resolveModel(index, { model: 'SP2-10', platform: 'RK' });
  assert.equal(res.status, 'ambiguous');
  assert.deepEqual(res.candidates.map((c) => c.product).sort(), ['SP2-10PLUS', 'SP2-10PRO']);
});

test('resolveModel：芯片绝对隔离，同名机型不跨芯片合并', () => {
  const t3 = resolveModel(index, { model: 'SPRING2', platform: 'T3' });
  assert.equal(t3.status, 'ok');
  assert.equal(t3.resolved.platform, 'T3');
  assert.equal(t3.resolved.product, 'SPRING2');

  const rk = resolveModel(index, { model: 'SPRING2', platform: 'RK' });
  assert.equal(rk.status, 'ambiguous', 'RK 芯片下没有 SPRING2，只有 SP2-10PRO / SP2-10PLUS');
  assert.ok(rk.candidates.every((c) => c.platform === 'RK'));

  const sc60 = resolveModel(index, { model: 'SPRING2', platform: 'SC60' });
  assert.equal(sc60.status, 'not_found');
  assert.equal(sc60.reason, 'platform_missing');
  assert.deepEqual(sc60.availablePlatforms, ['RK', 'T3']);
});

test('resolveModel：不存在的机型 -> not_found + 近似写法', () => {
  const res = resolveModel(index, { model: 'SP2-10PROX' });
  assert.equal(res.status, 'not_found');
  assert.equal(res.reason, 'low_confidence');
  assert.ok(res.candidates.length >= 1);
});

test('probeVersion：从现网固件串反推客户/机型/系统', () => {
  assert.deepEqual(probeVersion('CP_SP2-10PRO_D_V1.16_LCD10_B0_EU_20261010'), {
    customer: 'CP', product: 'SP2-10PRO', os: 'DEBIAN', raw: 'CP_SP2-10PRO_D_V1.16_LCD10_B0_EU_20261010',
  });
  assert.equal(probeVersion('CP_SP2-10PRO_D_DEV-D9D6CD3E_LCD10_B0_EU_20261026').os, 'DEBIAN');
  assert.equal(probeVersion('随便写的版本'), null);
});

test('probeModel：只给版本串也能确定机型；系统冲突写进 mismatches', () => {
  const res = probeModel(index, { currentVersion: 'CP_SP2-10PRO_D_V1.16_LCD10_B0_EU_20261010' });
  assert.equal(res.status, 'ok');
  assert.equal(res.resolved.product, 'SP2-10PRO');
  assert.equal(res.resolved.platform, 'RK');

  const conflict = probeModel(index, {
    model: 'SP2-10PRO',
    os: 'ANDROID',
    currentVersion: 'CP_SP2-10PRO_D_V1.16_LCD10_B0_EU_20261010',
  });
  assert.equal(conflict.status, 'ok');
  assert.ok(conflict.mismatches.some((m) => /DEBIAN/.test(m)));
  assert.deepEqual(conflict.availableCustomers, ['CP']);
});
