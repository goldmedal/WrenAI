import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { classify, evidenceBridge, COUNT_SQL, inventory, sha256, loadFixture } from '../adapter.mjs';
import { governed } from '../governed.mjs';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const python = process.env.FIXTURE_PYTHON || join(root, 'core/wren/.venv/bin/python');
const wren = process.env.FIXTURE_WREN || join(root, 'core/wren/.venv/bin/wren');
const rules = await readFile(new URL('../../v5-jaffle/knowledge/rules/business-rules.md', import.meta.url));
const sql = await readFile(new URL('../../v5-jaffle/knowledge/sql/total-revenue.md', import.meta.url));
const targetRules = await readFile(new URL('../weekly-target.md', import.meta.url));
const review = JSON.parse(await readFile(new URL('../reviewed.json', import.meta.url)));
const result = () => ({ columns: ['value'], rows: [{ value: 4 }], definition: { sql: COUNT_SQL, source_tables: ['orders'], filters: [] } });

test('reviewed projections separate structure, descriptions, expressions, rules and SQL', () => {
  const docs = classify(review.manifest, review, rules, sql, targetRules);
  assert.deepEqual(docs.map(d => d.kind), ['schema.structure', 'schema.descriptions', 'mdl.expressions', 'knowledge.rules', 'knowledge.sql', 'knowledge.rules']);
  assert.ok(!JSON.stringify(docs[0]).includes('raw_orders'));
  assert.ok(!JSON.stringify(docs[0]).includes('SELECT'));
  assert.ok(!JSON.stringify(docs[0]).includes('One row'));
  assert.ok(JSON.stringify(docs[2]).includes('raw_orders'));
});

test('unknown and mixed content does not gain a category from its filename', () => {
  for (const mutate of [m => m.secret = 'HIDDEN', m => m.models[0].properties.description += ' SELECT SECRET',
    m => m.models[0].columns[0].unknown = true]) {
    const m = structuredClone(review.manifest); mutate(m);
    assert.throws(() => classify(m, review, rules, sql, targetRules), /unreviewed/);
  }
  assert.throws(() => classify(review.manifest, review, Buffer.from('mixed SQL SELECT secret'), sql, targetRules), /unreviewed/);
  assert.throws(() => classify(review.manifest, review, rules, Buffer.from('changed SQL'), targetRules), /unreviewed/);
});

test('weekly target rule is separately reviewed, not inferred from schema or an unrelated rule', () => {
  const docs = classify(review.manifest, review, rules, sql, targetRules);
  assert.ok(docs.find(d => d.document === 'weekly-target').value.includes('at least 4'));
  assert.ok(!JSON.stringify(docs.filter(d => d.document !== 'weekly-target')).includes('at least 4'));
  assert.throws(() => classify(review.manifest, review, rules, sql), /unreviewed/);
  assert.throws(() => classify(review.manifest, review, rules, sql, Buffer.from('Changed target: at least 2')), /unreviewed/);
});

test('answers derive from host evidence, never model values, names, summaries or provenance', async () => {
  const bridge = evidenceBridge(async () => result()), signal = new AbortController().signal;
  assert.equal(bridge.tool.validate({ metric: 'order_count', sql: 'DROP TABLE orders' }), false);
  const token = await bridge.tool.execute({ metric: 'order_count' }, signal);
  const answer = bridge.projection.project(token);
  assert.equal(answer.value, 4); assert.equal(answer.evidence.verified, true);
  assert.ok(bridge.projection.validate(answer));
  assert.deepEqual(bridge.evidenceFor(answer.evidence.id), { value: 4, definition: result().definition });
  assert.ok(!JSON.stringify(answer).includes('orders'));
  assert.ok(!JSON.stringify(answer).includes(token.evidence));
  assert.throws(() => bridge.projection.project(token), /unavailable/);
  for (const extra of [{ value: 999 }, { sql: 'PRIVATE_SQL' }, { columns: ['SECRET'] }, { summary: 'SECRET' }, { provenance: 'SECRET' }]) {
    const t = await bridge.tool.execute({ metric: 'order_count' }, signal);
    assert.throws(() => bridge.projection.project({ ...t, ...extra }), /unavailable/);
  }
  const c = new AbortController(), t = await bridge.tool.execute({ metric: 'order_count' }, c.signal);
  c.abort(); assert.throws(() => bridge.projection.project(t), /unavailable/);
});

test('forged query evidence, small groups, changed SQL and unprojectable shapes refuse', async () => {
  for (const mutate of [r => r.columns = ['SECRET'], r => r.rows[0].value = 2, r => r.rows[0].value = '4',
    r => r.rows[0].raw = 'SECRET', r => r.definition.sql = 'SELECT secret', r => r.summary = 'SECRET', r => r.rows = []]) {
    const r = result(); mutate(r);
    const bridge = evidenceBridge(async () => r);
    await assert.rejects(bridge.tool.execute({ metric: 'order_count' }, new AbortController().signal), /unavailable/);
    assert.throws(() => bridge.projection.project({ evidence: 'forged' }), /unavailable/);
  }
});

test('real Wren CLI reads only the isolated synthetic fixture; changes and SQL side effects refuse', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'wren-pi-test-'));
  try {
    const fixture = join(dir, 'fixture');
    execFileSync(python, [fileURLToPath(new URL('../setup_fixture.py', import.meta.url)), fixture]);
    const binding = { ...JSON.parse(await readFile(join(fixture, 'fixture.json'))), executable: resolve(wren), database: join(fixture, 'data/jaffle.duckdb') };
    binding.projectFiles = await inventory(binding.project); binding.homeFiles = await inventory(binding.home);
    binding.databaseSha256 = sha256(await readFile(binding.database));
    const loaded = await loadFixture(binding, 'jaffle'), child = loaded.children.data_worker;
    await assert.rejects(loadFixture(binding, 'another-project'), /unknown_project/);
    const token = await child.tools[0].execute({ metric: 'order_count' }, new AbortController().signal);
    assert.equal(child.projection.project(token).value, 12);
    await assert.rejects(governed(binding, { operation: 'query', sql: 'DROP TABLE orders', limit: 1 }), /^Error: query_unavailable$/);
    await assert.rejects(governed(binding, { operation: 'query', sql: 'SELECT PRIVATE_ERROR_CANARY FROM orders', limit: 1 }), /^Error: query_unavailable$/);
    assert.equal(sha256(await readFile(binding.database)), binding.databaseSha256);
    await writeFile(join(binding.project, 'knowledge/rules/unreviewed.md'), 'SECRET RULE');
    await assert.rejects(loadFixture(binding, 'jaffle'), /fixture_changed/);
    binding.projectFiles = await inventory(binding.project);
    await assert.rejects(loadFixture(binding, 'jaffle'), /unreviewed_metadata/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('governed client sanitizes initialization failure, rejects malformed frames and cancels processes', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'wren-protocol-'));
  try {
    const executable = join(dir, 'fixture');
    const binding = { executable, project: dir, home: dir };
    for (const body of ['echo PRIVATE_ERROR_CANARY >&2; exit 0', 'echo "{}"; echo "{}"', 'sleep 20']) {
      await writeFile(executable, '#!/bin/sh\n' + body + '\n', { mode: 0o700 });
      const c = new AbortController(), timer = setTimeout(() => c.abort(), 100);
      try { await assert.rejects(governed(binding, { operation: 'inspect' }, c.signal), /^Error: query_unavailable$/); }
      finally { clearTimeout(timer); }
    }
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('deployment bindings reject literal credentials and non-approved endpoint forms', async () => {
  const { validateDeployment } = await import('../prepare.mjs');
  const publicModel = { zone: 'public', deployment: 'cloud', api: 'openai-completions', model: 'fixture', baseUrl: 'http://127.0.0.1:1234', credentialEnv: 'PUBLIC_KEY' };
  const valid = { models: { planner: publicModel }, privateModel: { ...publicModel, zone: 'private', deployment: 'private', credentialEnv: 'PRIVATE_KEY' } };
  assert.doesNotThrow(() => validateDeployment(valid));
  for (const mutate of [d => d.models.planner.apiKey = 'SECRET', d => d.privateModel.baseUrl = 'http://unapproved.invalid',
    d => d.privateModel.baseUrl = 'https://user:password@example.invalid', d => d.privateModel.api = 'anthropic-messages',
    d => d.models = {}, d => d.privateModel.credentialEnv = 'actual-secret']) {
    const d = structuredClone(valid); mutate(d); assert.throws(() => validateDeployment(d));
  }
});
