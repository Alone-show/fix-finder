import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { parseCommitLine, parseCommitLog, parseBuildName, isBuildName, parseVersionString, nz } from '../lib/parse.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const fixture = fs.readFileSync(path.join(HERE, 'fixtures', 'sample-log.txt'), 'utf8');

test('parseCommitLine：标准行', () => {
  const c = parseCommitLine('2026-08-31-20:05:19|wenchao.sun|feat(common): 修复CIF驱动REQBUFS时cif_fmt_out空指针导致的kernel panic|92cf9c82');
  assert.equal(c.hash, '92cf9c82');
  assert.equal(c.date, '2026-08-31');
  assert.equal(c.scope, 'common');
  assert.equal(c.kind, 'feat');
  assert.equal(c.ticket, '');
});

test('parseCommitLine：带工单号 + revert', () => {
  const c = parseCommitLine('2026-09-22-19:56:25|xin peng|feat(cp-sp2-10pro): DO-8486 更新cpmedia到2.0.6|db5ad220');
  assert.equal(c.ticket, 'DO-8486');
  assert.equal(c.scope, 'cp-sp2-10pro');

  const r = parseCommitLine('2026-07-02-17:38:10|SunWenchao|feat(common): Revert "feat(common): DO-7171 启用cif monitor"|7bad9a61');
  assert.equal(r.revert, true);
  assert.equal(r.ticket, 'DO-7171');
});

test('parseCommitLine：缺 hash 的行也能解析', () => {
  const c = parseCommitLine('2026-01-21-11:07:00|阿东|请问这个gnss是每台设备都带吗');
  assert.equal(c.hash, '');
  assert.equal(c.author, '阿东');
  assert.match(c.subject, /gnss/);
});

test('parseCommitLine：非法行返回 null；非法尾段不当 hash', () => {
  assert.equal(parseCommitLine('not a commit log line at all'), null);
  const c = parseCommitLine('2026-01-21-11:09:00|阿东|请问这个gnss是每台设备都带吗|not-a-hash');
  assert.equal(c.hash, '');
  assert.match(c.subject, /not-a-hash/);
});

test('parseCommitLog：整份解析 + 同 hash 去重', () => {
  const commits = parseCommitLog(fixture);
  assert.equal(commits.length, 8, `期望去重后 8 条，实际 ${commits.length}`);
  const hashes = commits.map((c) => c.hash).filter(Boolean);
  assert.equal(new Set(hashes).size, hashes.length);
  assert.ok(commits.find((c) => c.hash === '92cf9c82'));
});

test('parseBuildName：正式版 / DEV / TIP / 老式命名', () => {
  const rel = parseBuildName('CP_SP2-10PRO_D_V1.16_LCD10_B0_EU_20261010');
  assert.equal(rel.kind, 'release');
  assert.equal(rel.version, 'V1.16');
  assert.equal(rel.date, '20261010');
  assert.equal(rel.lcd, 'LCD10');
  assert.equal(rel.system, 'D');

  const dev = parseBuildName('CP_SP2-10PRO_D_DEV-D9D6CD3E_LCD10_B0_EU_20261026');
  assert.equal(dev.kind, 'dev');
  assert.equal(dev.version, 'DEV-D9D6CD3E');
  assert.equal(dev.commit, 'd9d6cd3e');

  const tip = parseBuildName('CP_SP2-10PRO_D_1CB8E811_LCD10_B0_EU_20260928');
  assert.equal(tip.kind, 'tip');
  assert.equal(tip.commit, '1cb8e811');

  const old = parseBuildName('CP_SP2-10PRO_D_V1.07_LCD10_B0_4G_EN_20240403');
  assert.equal(old.kind, 'release');
  assert.equal(old.version, 'V1.07');
  assert.equal(old.date, '20240403');
});

test('isBuildName 只认构建目录', () => {
  assert.equal(isBuildName('CP_SP2-10PRO_D_V1.16_LCD10_B0_EU_20261010'), true);
  assert.equal(isBuildName('CP_SP2-10PRO_D_DEV-D9D6CD3E_LCD10_B0_EU_20261026'), true);
  assert.equal(isBuildName('README.md'), false);
  assert.equal(isBuildName('CP_SP2-10PRO_D_V1.16_LCD10_B0_EU'), false);
});

test('parseVersionString：从现网版本串解析基线', () => {
  const v = parseVersionString('CP_SP2-10PRO_D_DEV-DE9E2564_LCD10_B0_EU_20260825');
  assert.equal(v.date, '20260825');
  assert.equal(v.commit, 'de9e2564');
  assert.equal(v.kind, 'dev');
});

test('nz 归一化：全角/空格/标点', () => {
  assert.equal(nz('ＣＩＦ 驱动: 空指针！'), 'cif驱动空指针');
});
