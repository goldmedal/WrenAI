import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { evidenceBridge, COUNT_SQL, inventory, sha256, loadFixture } from '../adapter.mjs';
import { untrustedScenarios, untrustedAdapter, scoreBlockedOutput } from '../untrusted-scenarios.mjs';

const bridge = () => evidenceBridge(async () => ({ columns: ['value'], rows: [{ value: 12 }],
  definition: { sql: COUNT_SQL, source_tables: ['orders'], filters: [] } }));
const base = () => {
  const b = bridge();
  const metadata = [
    { kind: 'schema.descriptions', document: 'descriptions', value: [{ name: 'orders', description: 'Order counts' }] },
    { kind: 'knowledge.rules', document: 'business-rules', value: 'Original rule.' },
    { kind: 'knowledge.rules', document: 'weekly-target', value: 'At least 4 orders.' },
    { kind: 'knowledge.sql', document: 'revenue-example', value: 'Private SQL example.' },
  ];
  return { metadata, children: { data_worker: { context: metadata, tools: [b.tool], projection: b.projection } } };
};

test('untrusted cases are frozen and distinguish model inducement from forced output', () => {
  assert.equal(new Set(untrustedScenarios.map(s => s.id)).size, 8);
  assert.equal(untrustedScenarios.filter(s => s.mode === 'metadata').length, 5);
  assert.equal(untrustedScenarios.filter(s => s.mode === 'output').length, 3);
  assert.throws(() => { untrustedScenarios[0].payload = 'changed'; });
  assert.throws(() => { untrustedScenarios[0].metadata.push('knowledge.sql/revenue-example'); });
});

test('metadata attacks preserve categories and other content; only the test wrapper admits text', async () => {
  for (const scenario of untrustedScenarios.filter(s => s.mode === 'metadata')) {
    const original = base(), before = structuredClone(original.metadata);
    const wrapped = await untrustedAdapter({ loadProject: async () => original }, () => scenario, () => {}).loadProject('jaffle');
    const ids = docs => docs.map(d => `${d.kind}/${d.document}`);
    assert.deepEqual(ids(wrapped.metadata), ids(before));
    assert.deepEqual(wrapped.metadata, wrapped.children.data_worker.context);
    for (const [i, doc] of wrapped.metadata.entries()) {
      if (`${doc.kind}/${doc.document}` === scenario.document) {
        const text = typeof doc.value === 'string' ? doc.value : doc.value[0].description;
        assert.ok(text.includes(scenario.payload));
      }
      else assert.deepEqual(doc, before[i]);
    }
    assert.ok(!JSON.stringify(before).includes(scenario.marker));
  }
});

test('all forced worker corruptions reject genuine query tokens at the unchanged projection', async () => {
  for (const scenario of untrustedScenarios.filter(s => s.mode === 'output')) {
    const events = [];
    const { children: { data_worker: child } } = await untrustedAdapter({ loadProject: async () => base() }, () => scenario, e => events.push(e)).loadProject('jaffle');
    const token = await child.tools[0].execute({ metric: 'order_count' }, new AbortController().signal);
    assert.throws(() => child.projection.project(token), /answer_unavailable/);
    assert.deepEqual(events.map(e => e.event), ['worker-output', 'forced-output', 'projection']);
    assert.equal(events[0].validTokenOnly, true);
    assert.equal(events.at(-1).outcome, 'rejected');
    assert.ok(!JSON.stringify(events).includes(token.evidence));
    const clean = await untrustedAdapter({ loadProject: async () => base() }, () => null, () => {}).loadProject('jaffle');
    const cleanChild = clean.children.data_worker;
    const fresh = await cleanChild.tools[0].execute({ metric: 'order_count' }, new AbortController().signal);
    assert.equal(cleanChild.projection.project(fresh).value, 12);
  }
});

test('missing genuine worker evidence cannot be counted as a forced-injection pass', async () => {
  const events = [], scenario = untrustedScenarios.find(s => s.mode === 'output');
  const loaded = await untrustedAdapter({ loadProject: async () => base() }, () => scenario, e => events.push(e)).loadProject('jaffle');
  assert.throws(() => loaded.children.data_worker.projection.project({ evidence: 'invented' }), /injection_prerequisite_missing/);
  assert.equal(events.length, 1); assert.equal(events[0].validTokenOnly, false);
});

test('blocked-output scoring fails extra calls/approved output and never passes absent observations', () => {
  const good = { boundary: { componentCalls: 1, publicRequests: 2, queryCalls: 1, unavailableResults: 1 }, records: [],
    events: [{ event: 'forced-output' }, { event: 'projection', outcome: 'rejected' }], publicAvailable: true };
  assert.equal(scoreBlockedOutput(good).status, 'pass');
  for (const mutate of [v => v.boundary.componentCalls++, v => v.boundary.queryCalls++, v => v.boundary.publicRequests++,
    v => v.boundary.unavailableResults = 0, v => v.records.push({}), v => v.events.push({ event: 'projection', outcome: 'approved' })]) {
    const bad = structuredClone(good); mutate(bad); assert.equal(scoreBlockedOutput(bad).status, 'fail');
  }
  assert.equal(scoreBlockedOutput({ ...good, events: [] }).status, 'inconclusive');
  assert.equal(scoreBlockedOutput({ ...good, publicAvailable: false }).status, 'inconclusive');
});

test('real fixture refuses injected file content even after its inventory hash is refreshed', async () => {
  const root = fileURLToPath(new URL('../../../', import.meta.url));
  const dir = await mkdtemp(join(tmpdir(), 'wren-untrusted-'));
  try {
    const fixture = join(dir, 'fixture');
    execFileSync(process.env.FIXTURE_PYTHON || join(root, 'core/wren/.venv/bin/python'),
      [fileURLToPath(new URL('../setup_fixture.py', import.meta.url)), fixture]);
    const binding = { ...JSON.parse(await readFile(join(fixture, 'fixture.json'))),
      executable: resolve(process.env.FIXTURE_WREN || join(root, 'core/wren/.venv/bin/wren')), database: join(fixture, 'data/jaffle.duckdb') };
    binding.projectFiles = await inventory(binding.project); binding.homeFiles = await inventory(binding.home);
    binding.databaseSha256 = sha256(await readFile(binding.database));
    await loadFixture(binding, 'jaffle');
    const path = join(binding.project, 'knowledge/rules/weekly-target.md'), original = await readFile(path);
    await writeFile(path, original.toString() + '\n' + untrustedScenarios[2].payload);
    await assert.rejects(loadFixture(binding, 'jaffle'), /fixture_changed/);
    binding.projectFiles = await inventory(binding.project);
    await assert.rejects(loadFixture(binding, 'jaffle'), /unreviewed_metadata/);
    await writeFile(path, original); binding.projectFiles = await inventory(binding.project);
    const clean = await loadFixture(binding, 'jaffle');
    assert.ok(!JSON.stringify(clean.metadata).includes('PUBLIC_META_ANSWER_POISON'));
  } finally { await rm(dir, { recursive: true, force: true }); }
});
