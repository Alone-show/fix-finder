import test from 'node:test';
import assert from 'node:assert/strict';

import { nlScore, similarity, semanticText, tokens, longestCommonRun } from '../lib/nl.js';

const CIF = 'feat(common): 修复CIF驱动REQBUFS时cif_fmt_out空指针导致的kernel panic';
const TEARING = 'feat(common): DO-7778 解决camera 热插拔出现图像断层问题';
const TOUCH = 'fix(cp-sp2-10pro): 修复触摸屏偶发无报点的问题';

test('semanticText：剥掉提交前缀与工单号', () => {
  assert.equal(semanticText('feat(common): DO-7778 解决摄像头断层'), '解决摄像头断层');
  assert.equal(semanticText('fix(cp-sp2-10pro): 修复触摸屏'), '修复触摸屏');
});

test('nlScore：同现象（改写）高于无关提交', () => {
  const bug = 'G3 摄像头没有数据，必须重启才能恢复，怀疑内核空指针 CIF';
  const cif = nlScore(bug, CIF);
  assert.ok(cif > 100, `CIF 命中分数应较高，实际 ${cif}`);
  assert.ok(cif > nlScore(bug, TOUCH));
  assert.equal(nlScore(bug, TOUCH), 0);
});

test('nlScore：断层类描述能对上热插拔断层提交', () => {
  const score = nlScore('热插拔后画面断层', TEARING);
  assert.ok(score >= 60, `应命中断层提交，实际 ${score}`);
  assert.ok(score > nlScore('开机黑屏', TEARING));
});

test('nlScore：短查询不会被 bigram 噪声带偏', () => {
  assert.equal(nlScore('黑屏', TEARING) < 60, true);
});

test('tokens：型号与数字片段', () => {
  assert.deepEqual(tokens('cif REQBUFS 1080p nvp6158'), ['cif', 'reqbufs', '1080p', 'nvp6158']);
});

test('longestCommonRun 与 similarity 的基础性质', () => {
  assert.equal(longestCommonRun('空指针', '修复空指针导致的问题'), 3);
  assert.equal(longestCommonRun('abc', 'xyz'), 0);
  assert.equal(similarity('修复CIF驱动空指针', '修复CIF驱动空指针'), 1);
  assert.ok(similarity('修复CIF驱动空指针', '更新cpmedia到2.0.6') < 0.3);
});
