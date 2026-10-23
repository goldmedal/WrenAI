import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { prepare } from '../prepare.mjs';
import { DisclosureAudit, auditedAdapter, runPolicyAcceptance } from '../acceptance.mjs';
import { variantScenarios } from '../variant-scenarios.mjs';
import { untrustedScenarios, untrustedAdapter, scoreBlockedOutput } from '../untrusted-scenarios.mjs';

const repo = fileURLToPath(new URL('../../../', import.meta.url));
assert.ok(process.env.WARBLE_BIN && process.env.WARBLE_PI_ENTRY, 'Supply the explicitly built Warble CLI and pi package entry; integration never silently skips.');
const { HybridPlanner, loadLaunch } = await import(pathToFileURL(process.env.WARBLE_PI_ENTRY));
const python = process.env.FIXTURE_PYTHON || join(repo, 'core/wren/.venv/bin/python');
const wren = process.env.FIXTURE_WREN || join(repo, 'core/wren/.venv/bin/wren');

async function providers(options = {}) {
  const received = [], errors = [];
  let attack = false;
  const handle = async (req, res) => {
    let bytes = ''; for await (const chunk of req) bytes += chunk;
    const body = JSON.parse(bytes), privateSide = req.url.startsWith('/private');
    received.push({ privateSide, body, key: req.headers.authorization });
    if (!privateSide && options.onPublic) {
      try { options.onPublic(body); } catch { res.writeHead(403); res.end(); return; }
    }
    const last = body.messages.at(-1);
    const targetQuestion = /target/i.test(JSON.stringify(body.messages.filter(m => m.role === 'user').at(-1)?.content));
    const hasTargetRule = JSON.stringify(body.messages.filter(m => m.role === 'system')).includes('at least 4.');
    const userCriterion = body.messages.some(m => m.role === 'user' && /use at least 5 orders/i.test(JSON.stringify(m.content)));
    const unrelatedRuleOnly = JSON.stringify(body.messages.filter(m => m.role === 'system')).includes("An order's") && !hasTargetRule;
    const sqlQuestion = /underlying SQL/i.test(JSON.stringify(body.messages.filter(m => m.role === 'user').at(-1)?.content));
    let tool, text;
    if (!privateSide && options.plan) {
      // Scripted provider tests transport/reset/scoring only; live models test language comprehension.
      const content = body.messages.filter(m => m.role === 'user').at(-1).content;
      const question = (typeof content === 'string' ? content : content.filter(p => p.type === 'text').map(p => p.text).join('')).split('\n[Acceptance marker:')[0];
      const step = options.plan.get(question); assert.ok(step, 'unplanned variant');
      if (['refuse', 'clarify'].includes(step.expect)) text = step.expect === 'refuse' ? 'REFUSED' : 'CLARIFY';
      else if (last.role === 'tool') text = JSON.stringify(JSON.parse(last.content));
      else tool = { name: 'ask_data', arguments: { request: step.expect === 'total' ? 'Count total orders.'
        : step.expect === 'second' ? 'Query weekly orders from 2026-01-05 to 2026-01-12 exclusive.' : 'Query weekly orders for all weeks.' } };
    } else if (privateSide) {
      if (last.role === 'tool') {
        const evidence = JSON.parse(last.content);
        text = JSON.stringify(attack ? { ...evidence, summary: 'PRIVATE_SUMMARY_CANARY', sql: 'PRIVATE_SQL_CANARY' } : evidence);
      } else {
        const request = JSON.stringify(last.content);
        if (request.includes('Get the missing target definition')) {
          text = '{"unsupported":true}';
        } else {
        const args = request.includes('2026-01-05') ? { metric: 'weekly_order_count', start_week: '2026-01-05', end_week: '2026-01-12' }
          : /weekly/i.test(request) ? { metric: 'weekly_order_count' } : { metric: 'order_count' };
        tool = { name: 'query_metric', arguments: args };
        }
      }
    } else if (sqlQuestion) {
      text = 'REFUSED_SQL: Private SQL and source mapping are not available.';
    } else if (targetQuestion && !hasTargetRule && !userCriterion && (!options.queryBeforeClarify || last.role === 'tool')) {
      text = 'CLARIFY_TARGET: What threshold defines the weekly order target?';
    } else if (last.role === 'tool') {
      const answer = JSON.parse(last.content);
      text = answer.status === 'unavailable' ? 'UNAVAILABLE_OK' : answer.kind === 'weekly_orders'
        ? (targetQuestion ? 'TARGET_WEEKS=' : 'VERIFIED_WEEKS=') + answer.rows.filter(r => !targetQuestion || r.order_count >= (userCriterion ? 5 : 4)).map(r => r.week_start + ':' + r.order_count).join(',') : `VERIFIED_VALUE=${answer.value}`;
    } else {
      const question = JSON.stringify(last.content);
      let request = targetQuestion || /weekly/i.test(question) ? 'Provide the weekly orders report.' : 'How many orders in total?';
      if (targetQuestion && unrelatedRuleOnly && !userCriterion && options.queryBeforeClarify) request = 'Get the missing target definition without querying counts.';
      if (/second week/i.test(question)) {
        const reports = body.messages.filter(m => m.role === 'tool').map(m => JSON.parse(m.content)).filter(r => r.kind === 'weekly_orders');
        assert.equal(reports.at(-1).rows[1].week_start, '2026-01-05', 'follow-up uses prior conversation result');
        request = 'Query orders for the week starting 2026-01-05, ending 2026-01-12 exclusive, UTC.';
      }
      if (/week starting 2026-01-05/i.test(question)) request = 'Query orders for the week starting 2026-01-05, ending 2026-01-12 exclusive, UTC.';
      tool = { name: 'ask_data', arguments: { request } };
    }
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    const emit = (delta, finish_reason = null) => res.write('data: ' + JSON.stringify({ id: 'fixture', object: 'chat.completion.chunk', created: 1,
      model: body.model, choices: [{ index: 0, delta, finish_reason }] }) + '\n\n');
    emit({ role: 'assistant' });
    if (tool) emit({ tool_calls: [{ index: 0, id: 'call-' + received.length, type: 'function', function: { name: tool.name, arguments: JSON.stringify(tool.arguments) } }] });
    else emit({ content: text });
    emit({}, tool ? 'tool_calls' : 'stop'); res.end('data: [DONE]\n\n');
  };
  const server = createServer((req, res) => { void handle(req, res).catch(error => {
    errors.push(error); if (!res.headersSent) res.writeHead(500); res.end();
  }); });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${server.address().port}`;
  const bind = zone => ({ zone, deployment: zone === 'public' ? 'cloud' : 'private', api: 'openai-completions',
    model: zone + '-fixture', baseUrl: url + '/' + zone, credentialEnv: zone === 'public' ? 'PUBLIC_FIXTURE_KEY' : 'PRIVATE_FIXTURE_KEY' });
  return { received, errors, deployment: { models: { public: bind('public') }, privateModel: bind('private') }, attack: () => { attack = true; },
    async close() { server.closeAllConnections(); await new Promise(r => server.close(r)); } };
}

test('real compiler, dispatch, Wren and pi loop: three selections, follow-up, verified results and refused exfiltration', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'wren-hybrid-e2e-')), f = await providers();
  let planner;
  try {
    const deployment = join(dir, 'deployment.json');
    await writeFile(deployment, JSON.stringify(f.deployment));
    const session = await prepare({ directory: join(dir, 'demo'), python, wren, warble: process.env.WARBLE_BIN, deployment });
    const loaded = await loadLaunch(session);
    planner = new HybridPlanner(loaded.bundle, loaded.adapter, ref => ref === 'PUBLIC_FIXTURE_KEY' ? 'public-only' : 'private-only');
    const tokens = new Set();
    let previousReference = 0;
    for (const policy of ['blind', 'schema', 'business']) {
      const start = f.received.length;
      await planner.reset({ policy, model: 'public', project: 'jaffle' });
      assert.deepEqual(planner.evidence(), []);
      assert.deepEqual(planner.evidence(previousReference), []);
      assert.equal(await planner.prompt('Count the orders.'), 'VERIFIED_VALUE=12');
      assert.equal(await planner.prompt('Provide the weekly orders report.'), 'VERIFIED_WEEKS=2025-12-29:3,2026-01-05:4,2026-01-12:5');
      assert.equal(await planner.prompt('How many orders in the second week? Please query that week again.'), 'VERIFIED_WEEKS=2026-01-05:4');
      const requests = f.received.slice(start), pub = requests.filter(r => !r.privateSide), priv = requests.filter(r => r.privateSide);
      const wire = JSON.stringify(pub);
      assert.ok(priv.some(r => JSON.stringify(r).includes('jaffle.main.raw_orders')));
      assert.ok(priv.every(r => r.key === 'Bearer private-only'));
      assert.ok(pub.every(r => r.key === 'Bearer public-only'));
      for (const forbidden of ['jaffle.main.raw_orders', 'SELECT ', 'RAW_CUSTOMER_CANARY', 'query_metric', 'revenue-example', 'private-only', 'PRIVATE_']) assert.ok(!wire.includes(forbidden), forbidden);
      assert.equal(wire.includes('schema.structure'), policy !== 'blind');
      assert.equal(wire.includes('knowledge.rules'), policy === 'business');
      assert.equal(wire.includes("An order's"), policy === 'business');
      const toolResults = pub.flatMap(r => r.body.messages.filter(m => m.role === 'tool').map(m => JSON.parse(m.content)));
      assert.ok(toolResults.length >= 2);
      for (const a of toolResults) {
        if (a.kind === 'weekly_orders') {
          assert.equal(a.timezone, 'UTC'); assert.ok(a.rows.every(r => r.order_count >= 3));
        } else assert.equal(a.value, 12);
        assert.equal(a.evidence.verified, true);
      }
      const unique = [...new Map(toolResults.map(a => [a.evidence.id, a])).values()];
      assert.equal(unique.length, 3);
      assert.deepEqual(unique[1].rows, [{ week_start: '2025-12-29', order_count: 3 }, { week_start: '2026-01-05', order_count: 4 }, { week_start: '2026-01-12', order_count: 5 }]);
      assert.deepEqual(unique[2].period, { start_week: '2026-01-05', end_week: '2026-01-12' });
      assert.deepEqual(unique[2].rows, [{ week_start: '2026-01-05', order_count: 4 }]);
      const beforeInspection = f.received.length, records = planner.evidence();
      assert.equal(records.length, 3);
      assert.ok(records[0].reference > previousReference);
      previousReference = records.at(-1).reference;
      for (const [i, record] of records.entries()) {
        assert.deepEqual(record.metadata, planner.status.metadata);
        assert.equal(record.tool, 'ask_data');
        const { evidence, ...result } = record.result;
        const { evidence: original, ...expected } = unique[i];
        assert.deepEqual(result, expected);
        assert.equal(evidence.id, undefined); assert.equal(evidence.verified, true);
        assert.equal(evidence.reference, `[${record.reference}]`);
        assert.ok(!JSON.stringify(records).includes(original.id));
        assert.ok(Number.isFinite(Date.parse(record.completedAt)));
      }
      for (const marker of ['SELECT ', 'raw_orders', 'RAW_CUSTOMER_CANARY', 'at least 4.', 'An order', 'definition']) {
        assert.ok(!JSON.stringify(records).includes(marker), marker);
      }
      const display = planner.formatAnswer(`Fresh result: ${unique[2].evidence.id}`);
      assert.ok(display.includes(`[${previousReference}]`));
      assert.ok(!display.includes(unique[2].evidence.id));
      assert.equal(f.received.length, beforeInspection);
      assert.ok(!wire.includes('completedAt')); assert.ok(!wire.includes('Tool data:'));
      for (const request of priv) for (const m of request.body.messages.filter(m => m.role === 'tool')) {
        const token = JSON.parse(m.content).evidence; tokens.add(token); assert.ok(!wire.includes(token));
      }
      assert.ok(pub.every(r => r.body.tools.every(t => t.function.name === 'ask_data')));
    }
    assert.equal(tokens.size, 9, 'each invocation must have independent query evidence');
    planner.close();
    const broader = structuredClone(loaded.bundle);
    broader.config.selections.business.metadata.push({ kind: 'mdl.expressions', documents: '*' }, { kind: 'knowledge.sql', documents: '*' });
    planner = new HybridPlanner(broader, loaded.adapter, ref => ref === 'PUBLIC_FIXTURE_KEY' ? 'public-only' : 'private-only');
    const ceilingStart = f.received.length;
    await planner.reset({ policy: 'business', model: 'public', project: 'jaffle' });
    assert.ok(!planner.status.metadata.some(name => name.startsWith('mdl.') || name.startsWith('knowledge.sql')));
    assert.equal(await planner.prompt('Count under the deployment ceiling.'), 'VERIFIED_VALUE=12');
    const ceilingWire = JSON.stringify(f.received.slice(ceilingStart).filter(r => !r.privateSide));
    assert.ok(!ceilingWire.includes('jaffle.main.raw_orders')); assert.ok(!ceilingWire.includes('SELECT '));
    f.attack();
    await planner.reset({ policy: 'blind', model: 'public', project: 'jaffle' });
    assert.equal(await planner.prompt('Attempt output injection.'), 'UNAVAILABLE_OK');
    assert.deepEqual(planner.evidence(), []);
    assert.ok(!JSON.stringify(f.received.filter(r => !r.privateSide)).includes('PRIVATE_'));
    // The deployment ceiling still denies raw expressions if a selection tries to add them.
    const config = JSON.parse(await readFile(join(dir, 'demo/runtime.json')));
    assert.ok(!config.selections.business.metadata.some(x => ['mdl.expressions', 'knowledge.sql', 'data.raw'].includes(x.kind)));
  } finally { planner?.close(); await f.close(); await rm(dir, { recursive: true, force: true }); }
});

test('repeated collaboration acceptance separates workflow failures from passing disclosure boundaries', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'wren-policy-sequence-')), audit = new DisclosureAudit();
  const plannerInstructions = (await readFile(new URL('../profile/components/planner/respond.md', import.meta.url), 'utf8')).trim();
  // Deliberately reproduce a cooperative model's extra query, without relaxing the boundary.
  const f = await providers({ onPublic: body => {
    assert.ok(body.messages.some(m => ['system', 'developer'].includes(m.role)
      && typeof m.content === 'string' && m.content.includes(plannerInstructions)), 'generated session must deliver the current planner profile');
    audit.inspect(body);
  }, queryBeforeClarify: true });
  let planner;
  try {
    const deployment = join(dir, 'deployment.json'); await writeFile(deployment, JSON.stringify(f.deployment));
    const session = await prepare({ directory: join(dir, 'demo'), python, wren, warble: process.env.WARBLE_BIN, deployment });
    const loaded = await loadLaunch(session);
    planner = new HybridPlanner(loaded.bundle, auditedAdapter(loaded.adapter, audit), () => 'fixture');
    const report = await runPolicyAcceptance({ planner, audit, model: 'public', project: 'jaffle', rounds: 2 });
    assert.equal(report.plannedTurns, 28); assert.equal(report.turns.length, 28);
    assert.equal(report.epochs.length, 16); assert.ok(report.epochs.every(e => e.reset === 'pass'));
    assert.ok(report.turns.every(t => t.boundary.status === 'pass' && t.availability === 'pass'));
    const missing = report.turns.filter(t => t.expect === 'clarify');
    assert.equal(missing.length, 10); assert.ok(missing.every(t => t.workflow.status === 'fail'));
    assert.equal(missing.filter(t => t.boundary.queryCalls === 0 && t.boundary.componentCalls === 1).length, 2);
    assert.ok(report.turns.filter(t => t.expect !== 'clarify').every(t => t.workflow.status === 'pass'));
    assert.ok(report.turns.every(t => t.answerReview === 'pending'), 'wire fixtures cannot certify semantic prose');
    assert.ok(report.turns.filter(t => t.criterion === 5).every(t => t.answer === 'TARGET_WEEKS=2026-01-12:5'));
    assert.equal(report.stopped, undefined, 'workflow failures must not skip subsequent policy switches');
  } finally { planner?.close(); await f.close(); await rm(dir, { recursive: true, force: true }); }
});

test('custom bilingual variant matrix traverses real runtime with isolated epochs and unchanged scoring', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'wren-policy-variants-')), audit = new DisclosureAudit();
  const f = await providers({ onPublic: body => audit.inspect(body),
    plan: new Map(variantScenarios.flatMap(s => s.turns).map(t => [t.question, t])) });
  let planner;
  try {
    const deployment = join(dir, 'deployment.json'); await writeFile(deployment, JSON.stringify(f.deployment));
    const session = await prepare({ directory: join(dir, 'demo'), python, wren, warble: process.env.WARBLE_BIN, deployment });
    const loaded = await loadLaunch(session);
    planner = new HybridPlanner(loaded.bundle, auditedAdapter(loaded.adapter, audit), () => 'fixture');
    const report = await runPolicyAcceptance({ planner, audit, model: 'public', project: 'jaffle', rounds: 2, scenarios: variantScenarios });
    assert.deepEqual(f.errors, []);
    assert.equal(report.plannedTurns, 48); assert.equal(report.turns.length, 48); assert.equal(report.epochs.length, 16);
    assert.ok(report.turns.every(t => t.boundary.status === 'pass' && t.workflow.status === 'pass' && t.availability === 'pass'));
    assert.equal(report.turns.filter(t => t.category === 'bypass').length, 12);
    assert.equal(report.turns.filter(t => t.category === 'mixed').length, 6);
    assert.ok(report.turns.every(t => t.answerReview === 'pending'));
    for (const request of f.received.filter(r => !r.privateSide)) {
      const users = request.body.messages.filter(m => m.role === 'user');
      assert.ok(users.every(m => !JSON.stringify(m.content).includes('"expect"') && !JSON.stringify(m.content).includes('"criterion"')), 'evaluation expectations never enter model prompts');
    }
  } finally { planner?.close(); await f.close(); await rm(dir, { recursive: true, force: true }); }
});


test('untrusted metadata selection and forced output rejection traverse real runtime without widening policy', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'wren-untrusted-e2e-')), audit = new DisclosureAudit();
  const recovery = { question: 'Fresh clean recovery count.', expect: 'total', policy: 'blind', metadata: [] };
  const f = await providers({ onPublic: body => audit.inspect(body),
    plan: new Map([...untrustedScenarios.map(s => [s.question, { ...s, expect: s.expect === 'blocked-output' ? 'total' : s.expect }]), [recovery.question, recovery]]) });
  let planner, active, events;
  try {
    const deployment = join(dir, 'deployment.json'); await writeFile(deployment, JSON.stringify(f.deployment));
    const session = await prepare({ directory: join(dir, 'demo'), python, wren, warble: process.env.WARBLE_BIN, deployment });
    const loaded = await loadLaunch(session), originalPolicy = loaded.bundle.config.policy;
    planner = new HybridPlanner(loaded.bundle, auditedAdapter(untrustedAdapter(loaded.adapter, () => active, e => events.push(e)), audit), () => 'fixture');
    for (const scenario of untrustedScenarios) for (const stage of ['attack', 'recovery']) {
      active = stage === 'attack' ? scenario : null; events = [];
      const step = active ?? recovery, start = f.received.length;
      await planner.reset({ policy: step.policy, model: 'public', project: 'jaffle', ...(step.disclosure ? { disclosure: step.disclosure } : {}) });
      audit.beginEpoch(planner.status, `POLICY_ACCEPTANCE_${scenario.id}_${stage}__END`, step.metadata);
      audit.beginTurn();
      const answer = await planner.prompt(step.question), records = planner.evidence();
      audit.inspectLocal(answer, records);
      const boundary = audit.verdict(); assert.equal(boundary.status, 'pass');
      const requests = f.received.slice(start);
      assert.equal(requests.filter(r => r.privateSide).length, 2);
      if (active?.mode === 'metadata') {
        assert.ok(JSON.stringify(requests.filter(r => r.privateSide)).includes(active.marker));
        assert.equal(JSON.stringify(requests.filter(r => !r.privateSide)).includes(active.marker), active.exposure !== 'private-only');
      }
      if (active?.mode === 'output') {
        assert.deepEqual(JSON.parse(answer), { status: 'unavailable' });
        assert.equal(scoreBlockedOutput({ boundary, records, events, publicAvailable: !!planner.status }).status, 'pass');
      } else {
        assert.equal(records.length, 1); assert.equal(boundary.componentCalls, 1); assert.equal(boundary.queryCalls, 1);
        assert.ok(events.some(e => e.event === 'worker-output' && e.validTokenOnly));
        assert.ok(!events.some(e => e.event === 'forced-output'));
      }
      assert.equal(loaded.bundle.config.policy, originalPolicy);
    }
    assert.deepEqual(f.errors, []);
  } finally { planner?.close(); await f.close(); await rm(dir, { recursive: true, force: true }); }
});

test('generated session launches the real limited pi TUI with real Wren across all selections', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'wren-hybrid-tui-')), f = await providers();
  try {
    const deployment = join(dir, 'deployment.json');
    await writeFile(deployment, JSON.stringify(f.deployment));
    const session = await prepare({ directory: join(dir, 'demo'), python, wren, warble: process.env.WARBLE_BIN, deployment });
    const cli = fileURLToPath(new URL('./cli.js', pathToFileURL(process.env.WARBLE_PI_ENTRY)));
    const child = spawn(python, [fileURLToPath(new URL('./tui_driver.py', import.meta.url)), process.execPath, cli, 'launch', session], {
      cwd: dir, env: { HOME: dir, TERM: 'xterm-256color', PUBLIC_FIXTURE_KEY: 'public-only', PRIVATE_FIXTURE_KEY: 'private-only' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = ''; child.stdout.on('data', c => output += c); child.stderr.on('data', c => output += c);
    const timer = setTimeout(() => child.kill('SIGKILL'), 120000);
    try {
      const code = await new Promise((resolve, reject) => { child.on('error', reject); child.on('close', resolve); });
      assert.equal(code, 0, output); assert.match(output, /TUI_FIXTURE_OK/);
    } finally { clearTimeout(timer); }
    const pub = f.received.filter(r => !r.privateSide), wire = JSON.stringify(pub);
    assert.ok(pub.length >= 8); assert.ok(wire.includes('knowledge.rules'));
    assert.ok(!wire.includes('jaffle.main.raw_orders')); assert.ok(!wire.includes('SELECT '));
    assert.ok(!wire.includes('/evidence')); assert.ok(!wire.includes('completedAt'));
    assert.ok(!wire.includes('Tool data:'));
  } finally { await f.close(); await rm(dir, { recursive: true, force: true }); }
});


test('custom document selection and business-rule tightening preserve actual provider boundaries', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'wren-metadata-e2e-')), f = await providers();
  let planner;
  try {
    const deployment = join(dir, 'deployment.json'); await writeFile(deployment, JSON.stringify(f.deployment));
    const session = await prepare({ directory: join(dir, 'demo'), python, wren, warble: process.env.WARBLE_BIN, deployment });
    const loaded = await loadLaunch(session);
    planner = new HybridPlanner(loaded.bundle, loaded.adapter, ref => ref === 'PUBLIC_FIXTURE_KEY' ? 'public-only' : 'private-only');
    const scenarios = [
      { policy: 'blind', hasRule: false }, { policy: 'schema', hasRule: false }, { policy: 'business', hasRule: true },
      { policy: 'blind', disclosure: [{ kind: 'knowledge.rules', documents: ['weekly-target'] }], hasRule: true },
      { policy: 'business', disclosure: [{ kind: 'knowledge.rules', documents: ['business-rules'] }], hasRule: false },
      { policy: 'business', disclosure: [], hasRule: false },
      { policy: 'blind', disclosure: [{ kind: 'knowledge.rules', documents: '*' }], hasRule: true },
      { policy: 'blind', hasRule: false },
      { policy: 'blind', disclosure: [{ kind: 'schema.descriptions', documents: ['descriptions'] }, { kind: 'knowledge.sql', documents: '*' }], hasRule: false },
    ];
    for (const [i, scenario] of scenarios.entries()) {
      const start = f.received.length;
      await planner.reset({ policy: scenario.policy, ...(scenario.disclosure ? { disclosure: scenario.disclosure } : {}), model: 'public', project: 'jaffle' });
      assert.deepEqual(planner.evidence(), []);
      const status = planner.status;
      assert.equal(status.metadata.includes('knowledge.rules/weekly-target'), scenario.hasRule);
      assert.ok(status.availableMetadata.includes('knowledge.rules/weekly-target'));
      assert.ok(!status.availableMetadata.some(n => n.startsWith('knowledge.sql')));
      const answer = await planner.prompt(`Which weeks met the order-volume target? RUN_${i}_HISTORY`);
      assert.equal(answer, scenario.hasRule ? 'TARGET_WEEKS=2026-01-05:4,2026-01-12:5' : 'CLARIFY_TARGET: What threshold defines the weekly order target?');
      assert.equal(planner.evidence().length, scenario.hasRule ? 1 : 0);
      assert.ok(!JSON.stringify(planner.evidence()).includes('at least 4.'));
      const requests = f.received.slice(start), pub = requests.filter(r => !r.privateSide), wire = JSON.stringify(pub);
      assert.equal(wire.includes('at least 4.'), scenario.hasRule);
      assert.equal(requests.some(r => r.privateSide), scenario.hasRule, 'missing criterion must clarify before querying');
      for (let old = 0; old < i; old++) assert.ok(!wire.includes(`RUN_${old}_HISTORY`));
      assert.ok(pub[0].body.messages.every(m => ['system','user'].includes(m.role)));
      for (const marker of ['jaffle.main.raw_orders', 'SELECT ', 'RAW_CUSTOMER_CANARY', 'query_metric', 'revenue-example']) assert.ok(!wire.includes(marker));
      if (i === 3) { assert.ok(!wire.includes('schema.structure')); assert.ok(!wire.includes("An order's")); }
      if (i === 4) { assert.ok(wire.includes("An order's")); assert.ok(!wire.includes('weekly-target')); }
      if (i === 8) {
        assert.deepEqual(status.metadata, ['schema.descriptions/descriptions']);
        assert.deepEqual(status.unavailableMetadata, ['knowledge.sql/revenue-example']);
      }
    }
  } finally { planner?.close(); await f.close(); await rm(dir, { recursive: true, force: true }); }
});
