import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { apply, name, inject } from '../index.js';
import { makeIndex } from './index-fixture.mjs';

const ALLOWED_KEYWORDS = new Set([
  'type', 'oneOf', 'properties', 'required', 'additionalProperties', 'items', 'enum', 'const', 'description', 'title',
]);

function walkSchema(node, pathLabel, violations) {
  if (!node || typeof node !== 'object') {
    violations.push(`${pathLabel} 不是 schema 对象`);
    return;
  }
  for (const [key, value] of Object.entries(node)) {
    if (!ALLOWED_KEYWORDS.has(key)) violations.push(`${pathLabel}.${key} 不是支持的 keyword`);
    if (key === 'properties') {
      for (const [prop, child] of Object.entries(value)) walkSchema(child, `${pathLabel}.properties.${prop}`, violations);
    } else if (key === 'items') {
      walkSchema(value, `${pathLabel}.items`, violations);
    } else if (key === 'oneOf') {
      value.forEach((child, i) => walkSchema(child, `${pathLabel}.oneOf[${i}]`, violations));
    }
  }
}

function registry() {
  const tools = [];
  const ctx = {
    get: () => undefined,
    effect: (fn) => {
      fn();
      return () => {};
    },
    tools: {
      register(definition) {
        tools.push(definition);
        return () => {};
      },
    },
  };
  apply(ctx);
  return tools;
}

function textOf(tool, value) {
  const blocks = tool.output.render({}, value);
  assert.ok(Array.isArray(blocks) && blocks.length > 0, 'render 必须返回内容块');
  assert.equal(blocks[0].type, 'text');
  assert.equal(typeof blocks[0].text, 'string');
  return blocks[0].text;
}

/** 写 v2 索引：index.json 不带 commits，提交正文进 commits.json */
function writeIndex(dataDir, index) {
  fs.mkdirSync(path.join(dataDir, 'raw'), { recursive: true });
  fs.mkdirSync(path.join(dataDir, 'parsed'), { recursive: true });
  const { commits, ...manifest } = index;
  const table = {};
  for (const [hash, commit] of Object.entries(commits)) {
    const { lines, ...meta } = commit;
    table[hash] = meta;
  }
  fs.writeFileSync(path.join(dataDir, 'index.json'), JSON.stringify(manifest), 'utf8');
  fs.writeFileSync(path.join(dataDir, 'commits.json'), JSON.stringify(table), 'utf8');
}

function withIndex(prefix, fn) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  process.env.DSH_FIXFINDER_DIR = dataDir;
  writeIndex(dataDir, makeIndex());
  return { dataDir, run: async () => fn(dataDir) };
}

const tool = (tools, toolName) => tools.find((t) => t.name === toolName);

test('插件元信息与 5 个工具注册', () => {
  assert.equal(name, 'fix-finder');
  assert.deepEqual(inject, ['tools']);
  const tools = registry();
  assert.deepEqual(tools.map((t) => t.name).sort(), ['fix_check', 'fix_log', 'fix_matrix', 'fix_models', 'fix_sync']);
  for (const definition of tools) {
    assert.equal(typeof definition.description, 'string');
    assert.ok(definition.description.length > 20);
    assert.equal(definition.parameters.type, 'object');
    assert.ok(definition.output?.schema, `${definition.name} 缺 output.schema`);
    assert.equal(typeof definition.output.render, 'function', `${definition.name} 缺 output.render`);
    const violations = [];
    walkSchema(definition.output.schema, `${definition.name}.output.schema`, violations);
    walkSchema(definition.parameters, `${definition.name}.parameters`, violations);
    assert.deepEqual(violations, [], `${definition.name} schema 用了不支持的 keyword：${violations.join('; ')}`);
  }
});

test('fix_check：SPRING2PRO 先探测再判定（不再 needs_baseline）', async () => {
  const { run } = withIndex('fixfinder-tool-', async () => {
    const check = tool(registry(), 'fix_check');
    const res = await check.execute({ bug: 'camera 热插拔出现图像断层', model: 'SPRING2PRO', os: 'DEBIAN', customer: 'CP' }, {});
    assert.equal(res.status, 'ok');
    assert.equal(res.resolvedModel, 'SP2-10PRO');
    assert.equal(res.modelProbe.matchKind, 'gap');
    assert.equal(res.verdict, 'fixed_released');
    assert.ok(res.candidates.some((c) => c.hash === '8b959775'));

    const text = textOf(check, res);
    assert.match(text, /机型：SPRING2PRO → SP2-10PRO/);
    assert.match(text, /fixed_released/);
    assert.match(text, /DO-7778/);
  });
  await run();
  delete process.env.DSH_FIXFINDER_DIR;
});

test('fix_check：机型有歧义 -> needs_confirmation 且不返回提交', async () => {
  const { run } = withIndex('fixfinder-tool2-', async () => {
    const check = tool(registry(), 'fix_check');
    const res = await check.execute({ bug: 'camera 热插拔出现图像断层', model: 'SP2-10', os: 'DEBIAN' }, {});
    assert.equal(res.status, 'needs_confirmation');
    assert.equal(res.verdict, 'needs_model');
    assert.deepEqual(res.candidates, []);
    assert.ok(res.modelProbe.candidates.length >= 2);
    const text = textOf(check, res);
    assert.match(text, /需要先确认机型写法/);
    assert.match(text, /SP2-10PRO/);
    assert.match(text, /fix_check\(\{/);
  });
  await run();
  delete process.env.DSH_FIXFINDER_DIR;
});

test('fix_check：芯片不在索引里 -> 明确拒绝，不跨芯片顶替', async () => {
  const { run } = withIndex('fixfinder-tool3-', async () => {
    const check = tool(registry(), 'fix_check');
    const res = await check.execute({ bug: '摄像头黑屏', model: 'SPRING2', platform: 'SC60' }, {});
    assert.equal(res.status, 'needs_confirmation');
    assert.match((res.notes || []).join('\n'), /SC60/);
    assert.match((res.notes || []).join('\n'), /RK/);
  });
  await run();
  delete process.env.DSH_FIXFINDER_DIR;
});

test('fix_check：工单号查正式版 -> fixed_released', async () => {
  const { run } = withIndex('fixfinder-tool4-', async () => {
    const check = tool(registry(), 'fix_check');
    const res = await check.execute({ bug: 'DO-8486 这批依赖什么时候进版本', model: 'SP2-10PRO', customer: 'CP' }, {});
    assert.equal(res.verdict, 'fixed_released');
    assert.match(textOf(check, res), /V1\.16/);
  });
  await run();
  delete process.env.DSH_FIXFINDER_DIR;
});

test('fix_check：没有索引时返回 needs_sync；参数太虚时返回 needs_keywords', async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fixfinder-empty-'));
  process.env.DSH_FIXFINDER_DIR = dataDir;
  try {
    const check = tool(registry(), 'fix_check');
    const res = await check.execute({ bug: '摄像头黑屏' }, {});
    assert.equal(res.status, 'needs_sync');
    assert.match(textOf(check, res), /fix_sync/);
  } finally {
    delete process.env.DSH_FIXFINDER_DIR;
  }

  const { run } = withIndex('fixfinder-kw-', async () => {
    const check = tool(registry(), 'fix_check');
    const res = await check.execute({ bug: '嗯嗯好的' }, {});
    assert.equal(res.status, 'needs_keywords');
  });
  await run();
  delete process.env.DSH_FIXFINDER_DIR;
});

test('fix_models：无参列机型族；带参做探测', async () => {
  const { run } = withIndex('fixfinder-models-', async () => {
    const models = tool(registry(), 'fix_models');
    const all = await models.execute({}, {});
    assert.equal(all.status, 'ok');
    assert.deepEqual(all.platforms, ['RK', 'T3']);
    assert.ok(all.families.some((f) => f.product === 'SPRING2' && f.platform === 'T3'));

    const probe = await models.execute({ model: 'SPRING2PRO' }, {});
    assert.equal(probe.status, 'ok');
    assert.equal(probe.probe.resolved.product, 'SP2-10PRO');
    assert.ok(probe.lines.length >= 2);
    const text = textOf(models, probe);
    assert.match(text, /探测：SPRING2PRO → SP2-10PRO/);
    assert.match(text, /产线：RK\/DEBIAN\/SP2-10PRO/);
  });
  await run();
  delete process.env.DSH_FIXFINDER_DIR;
});

test('fix_log：原子投递去重后的提交标题', async () => {
  const { run } = withIndex('fixfinder-log-', async () => {
    const log = tool(registry(), 'fix_log');
    const res = await log.execute({ product: 'SP2-10PRO', os: 'DEBIAN' }, {});
    assert.equal(res.status, 'ok');
    assert.equal(res.total, 2);
    assert.ok(res.commits.every((c) => c.lines.every((l) => l.platform === 'RK')));
    const text = textOf(log, res);
    assert.match(text, /8b959775/);
    assert.match(text, /落点：RK\/DEBIAN\/SP2-10PRO\(CP\)/);

    const filtered = await log.execute({ product: 'SP2-10PRO', os: 'DEBIAN', since: '2026-08-01' }, {});
    assert.equal(filtered.total, 1, 'since 过滤只留 8/1 之后');
  });
  await run();
  delete process.env.DSH_FIXFINDER_DIR;
});

test('fix_matrix：工单号覆盖矩阵 + 按芯片/系统汇总', async () => {
  const { run } = withIndex('fixfinder-matrix-', async () => {
    const matrix = tool(registry(), 'fix_matrix');
    const res = await matrix.execute({ ticket: 'DO-7778' }, {});
    assert.equal(res.status, 'ok');
    assert.ok(res.counts.contained >= 1);
    assert.ok(res.rows.some((r) => r.product === 'SP2-10PRO' && r.platform === 'RK' && r.contained));
    const text = textOf(matrix, res);
    assert.match(text, /按芯片：RK/);
    assert.match(text, /SP2-10PRO/);
  });
  await run();
  delete process.env.DSH_FIXFINDER_DIR;
});

test('fix_matrix：缺少查询条件', async () => {
  const { run } = withIndex('fixfinder-matrix2-', async () => {
    const matrix = tool(registry(), 'fix_matrix');
    const res = await matrix.execute({}, {});
    assert.equal(res.status, 'needs_key');
  });
  await run();
  delete process.env.DSH_FIXFINDER_DIR;
});

test('render 对错误/空态不抛异常', () => {
  const tools = registry();
  assert.match(textOf(tool(tools, 'fix_check'), { status: 'error', message: 'boom' }), /boom/);
  assert.match(textOf(tool(tools, 'fix_matrix'), { status: 'needs_sync' }), /fix_sync/);
  assert.match(textOf(tool(tools, 'fix_models'), { status: 'needs_sync' }), /fix_sync/);
  assert.match(textOf(tool(tools, 'fix_log'), { status: 'error', message: 'boom' }), /boom/);
  assert.match(
    textOf(tool(tools, 'fix_sync'), { status: 'ok', stats: { updated: 0, skipped: 0, failed: 0, discovered: 1 } }),
    /同步完成/,
  );
});
