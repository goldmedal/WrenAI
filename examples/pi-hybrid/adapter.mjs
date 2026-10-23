import { readFile, readdir, lstat } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { governed } from './governed.mjs';
import { queryPlan, metricParameters, projectResult, validWeekly } from './queries.mjs';
export { COUNT_SQL } from './queries.mjs';

export const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const exact = (value, keys) => value && typeof value === 'object' && !Array.isArray(value)
  && Object.keys(value).sort().join(',') === [...keys].sort().join(',');
const canonical = value => JSON.stringify(value, (_, v) => v && typeof v === 'object' && !Array.isArray(v)
  ? Object.fromEntries(Object.keys(v).sort().map(k => [k, v[k]])) : v);

export async function inventory(root) {
  const files = {};
  async function walk(path, prefix) {
    for (const name of (await readdir(path)).sort()) {
      const full = join(path, name), relative = prefix + name, stat = await lstat(full);
      if (stat.isSymbolicLink()) throw new Error('fixture_changed');
      if (stat.isDirectory()) await walk(full, relative + '/');
      else if (stat.isFile() && stat.size <= 16777216) files[relative] = sha256(await readFile(full));
      else throw new Error('fixture_changed');
    }
  }
  await walk(root, '');
  return files;
}

// This example has a deliberately reviewed fixture contract, not a classifier for
// arbitrary Wren projects. Changed/unknown/mixed content requires another review.
export function classify(manifest, review, rules, sql, targetRules) {
  if (canonical(manifest) !== canonical(review.manifest)
    || sha256(rules) !== review.rulesSha256 || sha256(sql) !== review.sqlSha256
    || !Buffer.isBuffer(targetRules) || sha256(targetRules) !== review.targetRulesSha256) throw new Error('unreviewed_metadata');
  return [
    { kind: 'schema.structure', document: 'structure', value: {
      models: manifest.models.map(m => ({ name: m.name, primaryKey: m.primaryKey,
        columns: m.columns.map(c => ({ name: c.name, type: c.type, notNull: c.notNull })) })),
      relationships: manifest.relationships.map(r => ({ name: r.name, models: r.models, joinType: r.joinType })),
    } },
    { kind: 'schema.descriptions', document: 'descriptions', value: manifest.models.map(m => ({ name: m.name, description: m.properties.description })) },
    { kind: 'mdl.expressions', document: 'expressions', value: {
      models: manifest.models.map(m => ({ name: m.name, ...(m.refSql ? { refSql: m.refSql } : { tableReference: m.tableReference }) })),
      relationships: manifest.relationships.map(r => ({ name: r.name, condition: r.condition })),
    } },
    { kind: 'knowledge.rules', document: 'business-rules', value: rules.toString('utf8') },
    { kind: 'knowledge.sql', document: 'revenue-example', value: sql.toString('utf8') },
    { kind: 'knowledge.rules', document: 'weekly-target', value: targetRules.toString('utf8') },
  ];
}

// Only this host ledger can mint evidence. The model returns a single-use opaque
// token, never a numeric answer, SQL, columns, narrative or provenance to redact.
export function evidenceBridge(query) {
  let pending;
  const approved = new Map();
  const validArgs = args => { try { queryPlan(args); return true; } catch { return false; } };
  return {
    // Trusted host lookup only; never registered as a model tool or public field.
    evidenceFor(id) { return approved.has(id) ? structuredClone(approved.get(id)) : undefined; },
    tool: {
      name: 'query_metric', capability: 'sql_execution:read_only', action: 'query', zone: 'private', readOnly: true,
      description: 'Query total orders or weekly order counts. Weeks start Monday in UTC. Omit dates for all available weeks; supply start_week inclusive and end_week exclusive Mondays for a range (max 53 weeks). Only weeks with orders are returned. Groups below three refuse the whole result. Return the evidence token unchanged.',
      parameters: metricParameters,
      validate: validArgs,
      async execute(args, signal) {
        pending = undefined;
        if (!validArgs(args)) throw new Error('query_unavailable');
        signal.throwIfAborted();
        const plan = queryPlan(args);
        const result = await query(signal, plan);
        signal.throwIfAborted();
        if (canonical(result?.definition) !== canonical({ sql: plan.sql, source_tables: ['orders'], filters: plan.filters })) {
          throw new Error('query_unavailable');
        }
        const answer = projectResult(result, plan);
        const token = randomUUID();
        pending = { token, answer, definition: structuredClone(result.definition), signal };
        pending.expires = Date.now() + 30000;
        signal.addEventListener('abort', () => { if (pending?.token === token) pending = undefined; }, { once: true });
        return { evidence: token };
      },
    },
    projection: {
      project(raw) {
        const saved = pending; pending = undefined;
        if (!exact(raw, ['evidence']) || !saved || saved.signal.aborted || raw.evidence !== saved.token || Date.now() > saved.expires) throw new Error('answer_unavailable');
        const id = randomUUID();
        if (approved.size >= 32) throw new Error('answer_unavailable');
        approved.set(id, { ...structuredClone(saved.answer), definition: saved.definition });
        return { ...structuredClone(saved.answer), evidence: { id, verified: true } };
      },
      validate(value) {
        if (!value || !exact(value.evidence, ['id', 'verified']) || typeof value.evidence.id !== 'string'
          || !/^[0-9a-f-]{36}$/.test(value.evidence.id) || value.evidence.verified !== true) return false;
        if (exact(value, ['value', 'evidence'])) return Number.isSafeInteger(value.value) && value.value >= 3 && value.value <= 10000;
        const { evidence, ...answer } = value;
        return validWeekly(answer);
      },
    },
  };
}

export async function loadFixture(binding, project) {
  if (project !== 'jaffle') throw new Error('unknown_project');
  const review = JSON.parse(await readFile(new URL('./reviewed.json', import.meta.url)));
  if (canonical(Object.keys(binding.projectFiles).sort()) !== canonical(review.projectPaths)) throw new Error('unreviewed_metadata');
  const unchanged = async () => {
    if (canonical(await inventory(binding.project)) !== canonical(binding.projectFiles)
      || sha256(await readFile(binding.database)) !== binding.databaseSha256
      || canonical(await inventory(binding.home)) !== canonical(binding.homeFiles)) throw new Error('fixture_changed');
  };
  await unchanged();
  const manifest = await governed(binding, { operation: 'inspect' });
  await unchanged();
  const rules = await readFile(join(binding.project, 'knowledge/rules/business-rules.md'));
  const sql = await readFile(join(binding.project, 'knowledge/sql/total-revenue.md'));
  const targetRules = await readFile(join(binding.project, 'knowledge/rules/weekly-target.md'));
  const metadata = classify(manifest, review, rules, sql, targetRules);
  const bridge = evidenceBridge(async (signal, plan) => {
    await unchanged();
    const result = await governed(binding, { operation: 'query', sql: plan.sql, limit: plan.limit }, signal);
    await unchanged();
    return result;
  });
  return { metadata, children: { data_worker: { context: metadata, tools: [bridge.tool], projection: bridge.projection } } };
}
