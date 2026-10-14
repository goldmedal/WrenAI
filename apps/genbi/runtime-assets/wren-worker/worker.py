"""Fixed, credential-free DuckDB snapshot entrypoint. No CLI arguments are accepted."""
import contextlib
import hashlib
import io
import json
import os
from pathlib import Path
import platform
import runpy
import re
import sys

ROOT = Path('/opt/genbi-project')
ASSETS = Path('/opt/genbi')

def digest(data):
    return 'sha256:' + hashlib.sha256(data).hexdigest()


def prepare():
    if len(sys.argv) != 1 or platform.system() != 'Linux' or platform.machine() != 'aarch64':
        raise ValueError('unsupported worker')
    os.environ.clear()
    # Fixed host-owned resource budgets avoid querying inaccessible cgroup metadata.
    # Leave headroom within the owned sandbox's one CPU / 1 GiB limit.
    os.environ.update(HOME='/sandbox', WREN_HOME=str(ROOT / 'wren-home'), PYTHONDONTWRITEBYTECODE='1', LANG='C.UTF-8', SLURM_MEM_PER_NODE='512M', SLURM_CPUS_ON_NODE='1')
    document = json.loads((ROOT / 'snapshot.json').read_bytes())
    # Reuse the same descriptor-anchored, full-content verifier as publication.
    verifier = runpy.run_path(str(ASSETS / 'snapshot-helper.py'))
    with contextlib.redirect_stdout(io.StringIO()):
        verifier['verify'](str(ROOT), document['digest'])
    paths = [f['path'] for f in document['files']]
    data = [p for p in paths if p.startswith('project/data/')]
    if not data or any(not p.endswith('.duckdb') or len(Path(p).parts) != 3 for p in data):
        raise ValueError('unsupported data layout')
    if any(p.startswith('wren-home/') and p not in ('wren-home/profiles.yml', 'wren-home/config.json') for p in paths):
        raise ValueError('unsupported profile')
    import yaml
    config = yaml.safe_load((ROOT / 'project/wren_project.yml').read_text())
    if not isinstance(config, dict) or config.get('data_source') != 'duckdb':
        raise ValueError('unsupported connector')
    from wren.context import build_json
    manifest = build_json(ROOT / 'project')
    expected = json.loads((ROOT / 'project/target/mdl.json').read_text())
    if manifest != expected:
        raise ValueError('context mismatch')
    # Only ordinary tables in the exact attached snapshot databases may be model sources.
    from sqlglot import exp, parse
    aliases = {Path(p).stem.lower() for p in data}
    models = manifest.get('models', [])
    if not models or manifest.get('views') or manifest.get('cubes'):
        raise ValueError('unsupported context')
    for relation in manifest.get('relationships', []):
        condition = parse(relation['condition'], read='duckdb')
        if len(condition) != 1 or any(isinstance(n, (exp.Func, exp.Subquery, exp.Table)) for n in condition[0].walk()):
            raise ValueError('unsupported relationship')
    for model in models:
        for column in model.get('columns', []):
            expression = column.get('expression')
            if column.get('columnLevelAccessControl') or column.get('isCalculated') or (expression and (expression != column.get('name') or not re.fullmatch(r'[A-Za-z_][A-Za-z0-9_]*', expression))):
                raise ValueError('unsupported column expression')
        if model.get('rowLevelAccessControls'):
            raise ValueError('unsupported source policy')
        sql = model.get('refSql')
        if not isinstance(sql, str) or model.get('tableReference') or model.get('baseObject'):
            raise ValueError('unsupported model source')
        trees = parse(sql, read='duckdb')
        if len(trees) != 1 or not isinstance(trees[0], exp.Select):
            raise ValueError('unsupported model SQL')
        tree = trees[0]
        if tree.args.get('with_') or any(True for _ in tree.find_all(exp.Func)):
            raise ValueError('unsupported source function')
        tables = list(tree.find_all(exp.Table))
        if not tables or any(not isinstance(t.this, exp.Identifier) or t.catalog or t.db.lower() not in aliases for t in tables):
            raise ValueError('source outside snapshot')
    metadata_raw = (ASSETS / 'toolchain.json').read_bytes()
    metadata = json.loads(metadata_raw)
    wheel = ASSETS / metadata['wheel']
    if wheel.name != metadata['wheel'] or digest(wheel.read_bytes()) != metadata['wheelDigest']:
        raise ValueError('wheel mismatch')
    return document, manifest, metadata, digest(metadata_raw)


def main():
    document, manifest, metadata, toolchain = prepare()
    from wren import governed_stdio
    # A fixed adapter selects one approved file connector; source profile pins and
    # ambient profiles never confer connector/credential authority in this worker.
    governed_stdio.resolve_profile_for_project = lambda *a, **k: ('snapshot', {
        'datasource': 'duckdb', 'url': str(ROOT / 'project/data'), 'format': 'duckdb'})
    from wren.config import WrenConfig
    governed_stdio.load_config = lambda *a, **k: WrenConfig(strict_mode=True)
    print(json.dumps({'worker': 'genbi-wren-worker/1', 'snapshot': document['digest'],
        'script': digest(Path(__file__).read_bytes()), 'wheel': metadata['wheelDigest'],
        'toolchain': toolchain, 'architecture': 'linux-arm64', 'protocol': governed_stdio.PROTOCOL}, separators=(',', ':')), flush=True)
    governed_stdio.serve(ROOT / 'project')


if __name__ == '__main__':
    try:
        main()
    except BaseException:
        # No paths, SQL, profile data or exception text enter the transport.
        raise SystemExit(1) from None
