import test from 'node:test';
import assert from 'node:assert/strict';

import { makeIndex } from './index-fixture.mjs';
import {
  extractQuery,
  searchCommits,
  evaluate,
  coverageOf,
  isKernelIssue,
  modelKeys,
  selectLines,
  selectCustomerLines,
  loadKeywords,
} from '../lib/search.js';

const dict = loadKeywords();
const index = makeIndex();
const get = (q, opts = {}) => {
  const query = extractQuery(q, { dictionary: dict, ...opts });
  return { query, candidates: searchCommits(index, query, { model: opts.model, limit: 8 }) };
};

test('自然语言检索：CIF 空指针命中对应提交', () => {
  const { candidates } = get('设备摄像头没有数据，重启才能恢复，怀疑内核空指针 CIF');
  assert.ok(candidates.length > 0, '应命中候选');
  assert.equal(candidates[0].hash, '92cf9c82');
});

test('自然语言检索：断层类描述能命中热插拔断层提交', () => {
  const { candidates } = get('热插拔之后画面出现断层');
  assert.equal(candidates[0].hash, '8b959775');
});

test('工单号精确命中 DO-8486', () => {
  const { query, candidates } = get('DO-8486 这个改动有没有进版本');
  assert.deepEqual(query.tickets, ['DO-8486']);
  assert.equal(candidates[0].hash, 'db5ad220');
});

test('hash 精确命中', () => {
  const { candidates } = get('帮我看下 92cf9c82 在哪些分支');
  assert.equal(candidates[0].hash, '92cf9c82');
});

test('判定：客户正式版已含 -> fixed_released', () => {
  const { query, candidates } = get('DO-7778', { model: 'SP2-10PRO' });
  const r = evaluate(index, {
    query,
    candidates,
    model: 'SP2-10PRO',
    platform: 'RK',
    products: ['SP2-10PRO'],
    customer: 'CP',
    currentVersion: 'CP_SP2-10PRO_D_DEV-DE9E2564_LCD10_B0_EU_20260825',
  });
  assert.equal(r.verdict, 'fixed_released');
  assert.equal(r.candidates[0].releasedIn.build, 'CP_SP2-10PRO_D_V1.16_LCD10_B0_EU_20261010');
});

test('判定：修复只在其它产品线 -> fixed_other_line_only', () => {
  const { query, candidates } = get('触摸屏偶发无报点', { model: 'SP2-10PRO' });
  const r = evaluate(index, { query, candidates, model: 'SP2-10PRO', platform: 'RK', products: ['SP2-10PRO'], customer: 'CP' });
  assert.equal(r.verdict, 'fixed_other_line_only');
  assert.match(r.notes.join('\n'), /APOLLO2/);
});

test('判定：机型已定但没有该客户线 -> needs_baseline', () => {
  const { query, candidates } = get('触摸屏偶发无报点', { model: 'SP2-10PRO' });
  const r = evaluate(index, { query, candidates, model: 'SP2-10PRO', platform: 'RK', products: ['SP2-10PRO'], customer: 'VR' });
  assert.equal(r.verdict, 'needs_baseline');
});

test('判定：未指定机型 -> found_unscoped', () => {
  const { query, candidates } = get('DO-8486');
  const r = evaluate(index, { query, candidates });
  assert.equal(r.verdict, 'found_unscoped');
});

test('判定：查不到 -> not_found', () => {
  const { query, candidates } = get('相亲对象不回复消息');
  const r = evaluate(index, { query, candidates, model: 'SP2-10PRO', products: ['SP2-10PRO'] });
  assert.equal(r.verdict, 'not_found');
});

test('覆盖统计：按 OS / 按芯片 / 按机型（机型键含芯片）', () => {
  const c = coverageOf(index, ['PROD/RK/DEBIAN/SP2-10PRO/CP/LCD10']);
  const os = Object.fromEntries(c.byOS.map((o) => [o.os, o]));
  assert.equal(os.DEBIAN.contained, 1);
  assert.equal(os.DEBIAN.total, 3);
  assert.equal(os.ANDROID.contained, 0);
  const plat = Object.fromEntries(c.byPlatform.map((p) => [p.platform, p]));
  assert.equal(plat.RK.contained, 1);
  assert.equal(plat.RK.total, 5);
  assert.equal(plat.T3.contained, 0);
  assert.ok(c.syncedModels.includes('SP2-10PRO(RK/DEBIAN)'));
  assert.ok(c.unsyncedModels.includes('SPRING2(T3/ANDROID)'));
});

test('内核问题识别：关键词/显式 scope', () => {
  const q1 = extractQuery('kernel panic 死机', { dictionary: dict });
  assert.equal(isKernelIssue(q1, []), true);
  const q2 = extractQuery('开机黑屏', { dictionary: dict });
  assert.equal(isKernelIssue(q2, [], 'kernel'), true);
  assert.equal(isKernelIssue(q2, [], 'local'), false);
});

test('选线：芯片维度绝对隔离，机型存在时只在目标芯片内匹配', () => {
  const rk = selectLines(index, { platform: 'RK' });
  assert.equal(rk.length, 5);
  assert.ok(rk.every((line) => line.platform === 'RK'));

  const t3 = selectLines(index, { platform: 'T3', products: ['SPRING2'] });
  assert.deepEqual(t3.map((line) => line.id), ['PROD/T3/ANDROID/SPRING2/CP/LCD7']);

  assert.deepEqual(selectLines(index, { platform: 'RK', products: ['SPRING2'] }), []);
});

test('机型别名：SP2 <-> SPRING2', () => {
  const keys = modelKeys('SP2-10PRO');
  assert.ok(keys.includes('spring210pro'));
  assert.ok(selectCustomerLines(index, { model: 'SPRING2-10PRO', customer: 'CP' }).some((l) => l.product === 'SP2-10PRO'));
});
