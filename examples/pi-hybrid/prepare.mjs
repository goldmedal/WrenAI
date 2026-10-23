import { execFileSync } from 'node:child_process';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { inventory, sha256, loadFixture } from './adapter.mjs';

const here = fileURLToPath(new URL('.', import.meta.url));
export function validateDeployment(input) {
  const fields = value => value && typeof value === 'object' && !Array.isArray(value) ? Object.keys(value).sort().join(',') : '';
  if (fields(input) !== 'models,privateModel' || !input.models || typeof input.models !== 'object' || Array.isArray(input.models)
    || !Object.keys(input.models).length || Object.keys(input.models).length > 16
    || Object.keys(input.models).some(k => !/^[A-Za-z][A-Za-z0-9_-]*$/.test(k))) throw new Error('invalid_deployment');
  for (const [binding, zone] of [...Object.values(input.models).map(b => [b, 'public']), [input.privateModel, 'private']]) {
    if (fields(binding) !== 'api,baseUrl,credentialEnv,deployment,model,zone' || binding.zone !== zone
      || !['openai-completions', ...(zone === 'public' ? ['anthropic-messages'] : [])].includes(binding.api)
      || typeof binding.model !== 'string' || !binding.model || binding.model.length > 256
      || typeof binding.deployment !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(binding.deployment)
      || typeof binding.credentialEnv !== 'string' || !/^[A-Z][A-Z0-9_]{0,127}$/.test(binding.credentialEnv)) throw new Error('invalid_deployment');
    const url = new URL(binding.baseUrl);
    if (url.username || url.password || url.search || url.hash || !(url.protocol === 'https:'
      || url.protocol === 'http:' && ['127.0.0.1', '[::1]'].includes(url.hostname))) throw new Error('invalid_deployment');
  }
}
export async function prepare({ directory, python, wren, warble, deployment }) {
  directory = resolve(directory); python = resolve(python); wren = resolve(wren); warble = resolve(warble);
  // Deployment input is mandatory. Neither endpoints, keys nor model IDs have defaults.
  const input = JSON.parse(await readFile(deployment, 'utf8'));
  validateDeployment(input);
  await mkdir(directory, { mode: 0o700 });
  const fixture = join(directory, 'fixture');
  execFileSync(python, [join(here, 'setup_fixture.py'), fixture], { stdio: 'pipe', timeout: 30000,
    env: { HOME: directory, PYTHONNOUSERSITE: '1', PYTHONIOENCODING: 'utf-8' } });
  const binding = { ...JSON.parse(await readFile(join(fixture, 'fixture.json'), 'utf8')), executable: wren,
    database: join(fixture, 'data/jaffle.duckdb') };
  binding.projectFiles = await inventory(binding.project);
  binding.homeFiles = await inventory(binding.home);
  binding.databaseSha256 = sha256(await readFile(binding.database));
  await loadFixture(binding, 'jaffle'); // CLI protocol + reviewed metadata preflight, zero model traffic
  const adapterPath = join(directory, 'adapter.mjs');
  const wrapper = `import { loadFixture } from ${JSON.stringify(pathToFileURL(join(here, 'adapter.mjs')).href)};\nconst binding = ${JSON.stringify(binding)};\nexport const loadProject = project => loadFixture(binding, project);\n`;
  await writeFile(adapterPath, wrapper, { mode: 0o600, flag: 'wx' });
  const selection = metadata => ({ metadata, components: ['data_worker'], approvedAnswers: true });
  const schema = [{ kind: 'schema.structure', documents: ['structure'] }, { kind: 'schema.descriptions', documents: ['descriptions'] }];
  const config = { format: 'warble-pi-hybrid-config/1', entry: 'planner', adapter: { path: adapterPath, sha256: sha256(wrapper) },
    policy: await readFile(join(here, 'policy.cedar'), 'utf8'),
    selections: { blind: selection([]), schema: selection(schema), business: selection([...schema, { kind: 'knowledge.rules', documents: ['business-rules', 'weekly-target'] }]) },
    models: input.models, projects: { jaffle: { privateModels: { data_worker: { cheap: input.privateModel } } } },
    defaults: { policy: 'blind', model: Object.keys(input.models)[0], project: 'jaffle' } };
  const configPath = join(directory, 'runtime.json'), ir = join(directory, 'ir.json');
  await writeFile(configPath, JSON.stringify(config, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
  execFileSync(warble, ['compile', join(here, 'profile'), '--out', ir], { stdio: 'pipe', timeout: 30000 });
  execFileSync(warble, ['dispatch', ir, '--target', 'pi:hybrid', '--hybrid-config', configPath, '--out', join(directory, 'session')], { stdio: 'pipe', timeout: 30000 });
  return join(directory, 'session');
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  try {
    const args = process.argv.slice(2), options = {};
    if (args.length !== 10) throw Error();
    for (let i = 0; i < args.length; i += 2) {
      const key = args[i].slice(2);
      if (!['directory', 'python', 'wren', 'warble', 'deployment'].includes(key) || key in options || !args[i].startsWith('--')) throw Error();
      options[key] = args[i + 1];
    }
    console.log('Prepared session:', await prepare(options));
  } catch { console.error('Preparation unavailable. Use --directory NEW_DIR --python PYTHON --wren WREN --warble WARBLE --deployment JSON. No model was contacted.'); process.exitCode = 1; }
}
