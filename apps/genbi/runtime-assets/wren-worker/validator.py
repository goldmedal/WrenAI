"""Fixed enrichment validator for the credential-less, no-network data-worker sandbox. No CLI arguments are accepted.

Protocol genbi-validate/1: print one identity line, read ONE request line from stdin, print ONE result line, exit 0.
The snapshot is mounted read-only; the candidate is applied to a scratch copy only. The host re-checks everything it receives,
so this script's claims carry no authority: its value is that a semantic failure is found in an isolated copy of the real toolchain.
"""
import contextlib
import hashlib
import io
import json
import os
from pathlib import Path
import platform
import re
import runpy
import sys
import tempfile

ROOT = Path('/opt/genbi-project')
ASSETS = Path('/opt/genbi')
SCRATCH = Path('/sandbox')
PROTOCOL = 'genbi-validate/1'
MAX_FILES = 20
MAX_PATH = 160
MAX_CONTENT = 64 * 1024
MAX_MDL = 96 * 1024
MAX_REQUEST = 192 * 1024
MAX_RESULT = 512 * 1024
MAX_COPY_FILES = 4096
MAX_COPY_BYTES = 32 * 1024 * 1024
CHECKS = ('additivity', 'context_validate', 'context_build', 'dry_plan', 'cube_sql', 'dry_run')
SINKS = (
    re.compile(r'knowledge/(?:rules|glossary|metrics|caveats|sql)/[a-z0-9_-]+\.md', re.IGNORECASE),
    re.compile(r'cubes/[a-z0-9_-]+/metadata\.yml'),
    re.compile(r'views/[a-z0-9_-]+/metadata\.yml'),
    re.compile(r'models/[a-z0-9_-]+/metadata\.yml'),
    re.compile(r'relationships\.yml'),
)


UNSUPPORTED_SINK = re.compile(r'(?:cubes|views)/')
UNSUPPORTED_MESSAGE = ('This runtime only accepts additions to existing knowledge, model descriptions and relationships; '
                       'new files, cubes, views and calculated columns are not supported.')


class Refusal(Exception):
    def __init__(self, code, message):
        super().__init__(message)
        self.code = code
        self.message = message


def digest(data):
    return 'sha256:' + hashlib.sha256(data).hexdigest()


def sanitize(text):
    """Drop control characters and path-like tokens; bound the length. Exception text never reaches the transport raw."""
    text = re.sub(r'[\x00-\x1f\x7f]+', ' ', str(text))
    text = re.split(r'\sLINE \d+:|\sphase=', text)[0]
    text = re.sub(r'(?:[A-Za-z]:\\|/)[^\s,;:\'")]*', '<path>', text)
    return re.sub(r'\s+', ' ', text).strip()[:240]


def check(name, status, code, message=''):
    return {'check': name, 'status': status, 'code': code, 'message': sanitize(message)}


def safe_path(path):
    if (not isinstance(path, str) or not path or len(path) > MAX_PATH or path.startswith('/') or '\\' in path or '\x00' in path
            or any(part in ('', '.', '..') for part in path.split('/'))):
        raise Refusal('path_invalid', 'A proposed path is not a valid project-relative path.')
    if not any(pattern.fullmatch(path) for pattern in SINKS):
        raise Refusal('sink_not_allowed', 'A proposed path is not an allowed enrichment sink.')
    if UNSUPPORTED_SINK.match(path):
        raise Refusal('unsupported_by_runtime', UNSUPPORTED_MESSAGE)


def parse_request(line):
    try:
        request = json.loads(line.decode('utf-8'))
    except Exception:
        raise Refusal('request_invalid', 'The request is not valid JSON.') from None
    if not isinstance(request, dict) or set(request) != {'version', 'files'} or type(request['version']) is not int or request['version'] != 1:
        raise Refusal('request_invalid', 'The request has an unexpected shape.')
    files = request['files']
    if not isinstance(files, list) or not files:
        raise Refusal('no_changes', 'The request changes no project file.')
    if len(files) > MAX_FILES:
        raise Refusal('too_many_files', 'The request changes more files than the review limit allows.')
    seen, total, parsed = set(), 0, []
    for item in files:
        if not isinstance(item, dict) or set(item) != {'path', 'content'} or not isinstance(item['content'], str):
            raise Refusal('request_invalid', 'The request has an unexpected shape.')
        safe_path(item['path'])
        if item['path'].lower() in seen:
            raise Refusal('duplicate_path', 'Two proposed changes target the same file.')
        seen.add(item['path'].lower())
        try:
            data = item['content'].encode('utf-8')
        except UnicodeEncodeError:
            raise Refusal('binary_content', 'Proposed text is not plain UTF-8 text.') from None
        if b'\x00' in data:
            raise Refusal('binary_content', 'Proposed text is not plain UTF-8 text.')
        total += len(data)
        if total > MAX_CONTENT:
            raise Refusal('too_large', 'The proposed change exceeds the review size limits.')
        parsed.append((item['path'], data))
    return parsed


def copy_project(source, target):
    """Copy the read-only snapshot project (minus data/ and target/) into scratch; refuse anything that is not a plain file or directory."""
    count = total = 0
    target.mkdir(mode=0o700, parents=True)

    def walk(directory, destination, top):
        nonlocal count, total
        for entry in sorted(os.scandir(directory), key=lambda item: item.name):
            if top and entry.name in ('data', 'target'):
                continue
            info = entry.stat(follow_symlinks=False)
            if entry.is_symlink() or not (entry.is_dir(follow_symlinks=False) or entry.is_file(follow_symlinks=False)):
                raise Refusal('symlink', 'The project contains a link or special file.')
            if entry.is_dir(follow_symlinks=False):
                child = destination / entry.name
                child.mkdir(mode=0o700)
                walk(entry.path, child, False)
            else:
                count += 1
                total += info.st_size
                if count > MAX_COPY_FILES or total > MAX_COPY_BYTES:
                    raise Refusal('too_large', 'The project exceeds the validation copy limits.')
                (destination / entry.name).write_bytes(Path(entry.path).read_bytes())

    walk(source, target, True)


def complete_project_config(project):
    """The published snapshot carries a minimal projected `wren_project.yml` (no `name`); structural validation requires one. Scratch-only."""
    import yaml
    config_file = project / 'wren_project.yml'
    try:
        config = yaml.safe_load(config_file.read_text(encoding='utf-8'))
    except Exception:
        raise Refusal('project_invalid', 'The snapshot project configuration could not be read.') from None
    if not isinstance(config, dict) or config.get('data_source') != 'duckdb':
        raise Refusal('project_invalid', 'The snapshot project is not a DuckDB snapshot.')
    if not config.get('name'):
        config_file.write_text(config_file.read_text(encoding='utf-8').rstrip('\n') + '\nname: validation\n', encoding='utf-8')


def reject_links(base, relative):
    current = base
    for part in relative.split('/'):
        current = current / part
        if current.is_symlink():
            raise Refusal('symlink', 'A proposed path passes through a link.')


def load_yaml(text):
    import yaml

    class Strict(yaml.SafeLoader):
        pass

    def mapping(loader, node, deep=False):
        keys = set()
        for key_node, _ in node.value:
            key = loader.construct_object(key_node, deep=deep)
            if key in keys:
                raise yaml.constructor.ConstructorError(None, None, 'duplicate key', key_node.start_mark)
            keys.add(key)
        return yaml.SafeLoader.construct_mapping(loader, node, deep)

    Strict.add_constructor(yaml.resolver.BaseResolver.DEFAULT_MAPPING_TAG, mapping)
    return yaml.load(text, Loader=Strict)


def additive(old, new, key=''):
    """Existing keys and values stay, lists only grow, only a `description` string may be extended."""
    if type(old) is not type(new):
        return False
    if isinstance(old, dict):
        return all(k in new and additive(v, new[k], str(k)) for k, v in old.items())
    if isinstance(old, list):
        return len(new) >= len(old) and all(additive(a, b) for a, b in zip(old, new))
    if isinstance(old, str) and key == 'description':
        return new.startswith(old)
    return old == new


def description_only(old, new, key=''):
    """The narrower rule for model metadata: everything stays; the only change is extending a `description` or adding one to a mapping.
    New columns (calculated or not), keys and list items are not description additions."""
    if isinstance(old, dict):
        if not isinstance(new, dict):
            return False
        if not all(k in new and description_only(v, new[k], str(k)) for k, v in old.items()):
            return False
        return all(k in old or (k == 'description' and isinstance(v, str))
                   or (k == 'properties' and isinstance(v, dict) and set(v) == {'description'} and isinstance(v['description'], str)) for k, v in new.items())
    if isinstance(old, list):
        return isinstance(new, list) and len(new) == len(old) and all(description_only(a, b) for a, b in zip(old, new))
    return additive(old, new, key)


def apply_change(project, path, data):
    reject_links(project, path)
    target = project / path
    before = target.read_bytes() if target.is_file() else None
    if before is None:
        # The governed snapshot must keep equalling its approved file list, so a file the snapshot lacks is never created.
        raise Refusal('unsupported_by_runtime', UNSUPPORTED_MESSAGE)
    if len(before) > MAX_CONTENT:
        raise Refusal('too_large', 'The proposed change exceeds the review size limits.')
    try:
        after_text = data.decode('utf-8')
        before_text = before.decode('utf-8')
    except UnicodeDecodeError:
        raise Refusal('binary_content', 'Existing or proposed text is not plain UTF-8 text.') from None
    if path.endswith('.md'):
        if not data.startswith(before):
            raise Refusal('not_additive', 'The change modifies or removes existing content; only additive edits are allowed.')
    else:
        try:
            new = load_yaml(after_text)
            old = load_yaml(before_text)
        except Exception:
            raise Refusal('yaml_invalid', 'The YAML could not be parsed.') from None
        if not isinstance(new, (dict, list)):
            raise Refusal('yaml_invalid', 'Expected a YAML mapping or list.')
        if not additive(old, new):
            raise Refusal('not_additive', 'The change modifies or removes existing content; only additive edits are allowed.')
        if path.startswith('models/') and not description_only(old, new):
            raise Refusal('unsupported_by_runtime', UNSUPPORTED_MESSAGE)
    target.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    reject_links(project, path)
    target.write_bytes(data)


def baseline_matches(project, expected_file):
    """The unmodified snapshot must rebuild to its own target MDL. Otherwise it is not the project governed access sees, and a change to it
    could be validated yet never loaded (for example when a projected config drops the project's schema version): refuse instead."""
    from wren.context import build_json
    try:
        return build_json(project) == json.loads(expected_file.read_text(encoding='utf-8'))
    except Exception:
        return False


def semantic_checks(project, data_dir, applied):
    """Library equivalents of `context validate`, `context build`, `dry-plan`, `cube query --sql-only` and `dry-run`. Returns (checks, mdl text)."""
    import base64
    from wren.context import build_json, validate_manifest, validate_project
    checks = []

    def stop(name, code, message):
        checks.append(check(name, 'fail', code, message))
        return checks, None

    try:
        hard = [e for e in validate_project(project) if e.level == 'error']
        if hard:
            return stop('context_validate', 'structure_invalid', str(hard[0]))
        manifest = build_json(project)
        encoded = base64.b64encode(json.dumps(manifest, ensure_ascii=False).encode()).decode()
        semantic = validate_manifest(encoded, 'duckdb', level='error')
        if semantic['errors']:
            return stop('context_validate', 'semantic_invalid', semantic['errors'][0])
    except Exception as error:
        return stop('context_validate', 'validate_error', error)
    checks.append(check('context_validate', 'pass', 'ok'))
    try:
        hard = [e for e in validate_project(project) if e.level == 'error']
        if hard:
            return stop('context_build', 'structure_invalid', str(hard[0]))
        mdl = json.dumps(build_json(project), indent=2, ensure_ascii=False)
        if len(mdl.encode('utf-8')) > MAX_MDL:
            return stop('context_build', 'mdl_too_large', 'The regenerated MDL exceeds the size limit.')
    except Exception as error:
        return stop('context_build', 'build_error', error)
    checks.append(check('context_build', 'pass', 'ok'))
    from wren.engine import WrenEngine
    connection = {'url': str(data_dir), 'format': 'duckdb'}
    relations = sorted({p.split('/')[1] for p, _ in applied if p.startswith(('models/', 'views/'))})
    cubes = sorted({p.split('/')[1] for p, _ in applied if p.startswith('cubes/')})
    try:
        with WrenEngine(encoded, 'duckdb', connection) as engine:
            if relations:
                for name in relations:
                    engine.dry_plan('SELECT * FROM "' + name + '" LIMIT 0')
                checks.append(check('dry_plan', 'pass', 'ok'))
            else:
                checks.append(check('dry_plan', 'skipped', 'not_applicable'))
            if not cubes:
                checks.append(check('cube_sql', 'skipped', 'not_applicable'))
                checks.append(check('dry_run', 'skipped', 'not_applicable'))
                return checks, mdl
            from wren_core import cube_query_to_sql
            statements = []
            for name in cubes:
                cube = next((c for c in manifest.get('cubes', []) if c.get('name') == name), None)
                measures = [m.get('name') for m in (cube or {}).get('measures', []) if isinstance(m, dict)]
                if not cube or not measures:
                    return stop('cube_sql', 'cube_without_measures', 'A new or changed cube needs at least one measure to be verified.')
                try:
                    statements.append(cube_query_to_sql(json.dumps({'cube': name, 'measures': measures}), json.dumps(manifest)).strip().splitlines()[-1])
                except Exception as error:
                    return stop('cube_sql', 'cube_sql_error', error)
            checks.append(check('cube_sql', 'pass', 'ok'))
            for sql in statements:
                try:
                    engine.dry_run(sql)
                except Exception as error:
                    return stop('dry_run', 'dry_run_error', error)
            checks.append(check('dry_run', 'pass', 'ok'))
    except Exception as error:
        name = 'dry_plan' if not any(c['check'] == 'dry_plan' for c in checks) else 'dry_run'
        return stop(name, 'plan_error', error)
    return checks, mdl


def validate(line, root=ROOT, scratch_parent=SCRATCH):
    """One request line in, one result document out. Never raises on candidate problems; they become a failed result."""
    try:
        applied = parse_request(line)
        with tempfile.TemporaryDirectory(dir=scratch_parent, prefix='validate-') as scratch:
            project = Path(scratch) / 'project'
            copy_project(root / 'project', project)
            complete_project_config(project)
            if not baseline_matches(project, root / 'project' / 'target' / 'mdl.json'):
                return {'status': 'failed', 'checks': [check('context_build', 'fail', 'baseline_mismatch', 'The unmodified snapshot does not rebuild to its own MDL, so a change cannot be validated against it.')]}
            for path, data in applied:
                apply_change(project, path, data)
            echoed = [{'path': path, 'content': (project / path).read_bytes().decode('utf-8')} for path, _ in applied]
            lead = check('additivity', 'pass', 'ok')
            checks, mdl = semantic_checks(project, root / 'project' / 'data', applied)
            checks = [lead, *checks]
    except Refusal as refusal:
        return {'status': 'failed', 'checks': [check('additivity', 'fail', refusal.code, refusal.message)]}
    if mdl is None:
        return {'status': 'failed', 'checks': checks}
    body = mdl.encode('utf-8')
    result = {'status': 'ok', 'applied': echoed, 'checks': checks, 'mdl': {'sha256': hashlib.sha256(body).hexdigest(), 'size': len(body), 'content': mdl}}
    if len(json.dumps(result, ensure_ascii=False).encode('utf-8')) > MAX_RESULT:
        return {'status': 'failed', 'checks': [check('context_build', 'fail', 'result_too_large', 'The validation result exceeds the transport limit.')]}
    return result


def prepare():
    if len(sys.argv) != 1 or platform.system() != 'Linux' or platform.machine() != 'aarch64':
        raise ValueError('unsupported validator')
    os.environ.clear()
    os.environ.update(HOME='/sandbox', WREN_HOME=str(ROOT / 'wren-home'), PYTHONDONTWRITEBYTECODE='1', LANG='C.UTF-8', SLURM_MEM_PER_NODE='512M', SLURM_CPUS_ON_NODE='1')
    document = json.loads((ROOT / 'snapshot.json').read_bytes())
    verifier = runpy.run_path(str(ASSETS / 'snapshot-helper.py'))
    with contextlib.redirect_stdout(io.StringIO()):
        verifier['verify'](str(ROOT), document['digest'])
    metadata_raw = (ASSETS / 'toolchain.json').read_bytes()
    metadata = json.loads(metadata_raw)
    wheel = ASSETS / metadata['wheel']
    if wheel.name != metadata['wheel'] or digest(wheel.read_bytes()) != metadata['wheelDigest']:
        raise ValueError('wheel mismatch')
    return document, metadata, digest(metadata_raw)


def emit(value):
    sys.stdout.buffer.write(json.dumps(value, ensure_ascii=False, separators=(',', ':')).encode('utf-8') + b'\n')
    sys.stdout.buffer.flush()


def main():
    document, metadata, toolchain = prepare()
    emit({'worker': 'genbi-wren-validator/1', 'snapshot': document['digest'], 'script': digest(Path(__file__).read_bytes()), 'wheel': metadata['wheelDigest'],
          'toolchain': toolchain, 'architecture': 'linux-arm64', 'protocol': PROTOCOL})
    line = sys.stdin.buffer.readline(MAX_REQUEST + 1)
    if len(line) > MAX_REQUEST or not line.endswith(b'\n'):
        raise ValueError('request')
    emit(validate(line[:-1]))


if __name__ == '__main__':
    try:
        main()
    except BaseException:
        # No paths, SQL, profile data or exception text enter the transport.
        raise SystemExit(1) from None
