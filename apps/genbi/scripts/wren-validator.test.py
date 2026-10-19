"""Offline contracts for runtime-assets/wren-worker/validator.py (synthetic project and data only).

The refusal and additivity tests need only PyYAML. The semantic tests run the real wren library against a synthetic DuckDB snapshot and
are skipped when wren is not importable. Run with a Python 3.11 that has the worker lock installed, for example:
  UV_PROJECT_ENVIRONMENT=<scratch> uv sync --directory core/wren --frozen --python 3.11 --no-dev
  <scratch>/bin/python -B apps/genbi/scripts/wren-validator.test.py
"""
import importlib.util
import json
import os
from pathlib import Path
import shutil
import tempfile
import unittest

HERE = Path(__file__).resolve().parent
SPEC = importlib.util.spec_from_file_location('wren_validator', HERE.parent / 'runtime-assets' / 'wren-worker' / 'validator.py')
validator = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(validator)

try:
    import duckdb
    from wren.context import build_json
    HAVE_WREN = True
except Exception:  # pragma: no cover - environment dependent
    HAVE_WREN = False

MODEL = '''name: orders
ref_sql: SELECT id, customer_id, amount, order_date FROM shop.main.orders
primary_key: id
properties:
  description: One row per order.
columns:
  - name: id
    type: INTEGER
  - name: customer_id
    type: INTEGER
  - name: amount
    type: DOUBLE
  - name: order_date
    type: DATE
'''


def request(*files):
    return json.dumps({'version': 1, 'files': [{'path': p, 'content': c} for p, c in files]}).encode()


def make_snapshot(base, config='schema_version: 5\nname: shop\ndata_source: duckdb\n', build=True):
    project = base / 'project'
    for directory in ('data', 'models/orders', 'knowledge/rules', 'target'):
        (project / directory).mkdir(parents=True)
    (project / 'wren_project.yml').write_text(config)
    (project / 'models/orders/metadata.yml').write_text(MODEL)
    (project / 'knowledge/rules/revenue.md').write_text('Revenue is net of refunds.\n')
    if HAVE_WREN:
        connection = duckdb.connect(str(project / 'data/shop.duckdb'))
        connection.execute('create table orders(id integer, customer_id integer, amount double, order_date date)')
        connection.execute("insert into orders values (1, 1, 10.5, '2024-01-01')")
        connection.close()
        if build:
            (project / 'target/mdl.json').write_text(json.dumps(build_json(project), indent=2, ensure_ascii=False))
    return base


class Base(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.scratch = self.root / 'scratch'
        self.scratch.mkdir()
        self.snapshot = make_snapshot(self.root / 'snapshot')

    def run_validator(self, *files):
        return validator.validate(request(*files), self.snapshot, self.scratch)

    def failure(self, result):
        self.assertEqual(result['status'], 'failed')
        self.assertNotIn('applied', result)
        self.assertNotIn('mdl', result)
        failed = [c for c in result['checks'] if c['status'] == 'fail']
        self.assertEqual(len(failed), 1)
        return failed[0]


class RequestRefusals(Base):
    def refused(self, request_bytes, code):
        with self.assertRaises(validator.Refusal) as context:
            validator.parse_request(request_bytes)
        self.assertEqual(context.exception.code, code)

    def test_path_attacks_are_refused(self):
        for path, code in [('../escape.md', 'path_invalid'), ('/etc/passwd', 'path_invalid'), ('models/../x/metadata.yml', 'path_invalid'),
                           ('knowledge\\rules\\x.md', 'path_invalid'), ('knowledge/rules/x\x00.md', 'path_invalid'), ('', 'path_invalid'),
                           ('wren_project.yml', 'sink_not_allowed'), ('target/mdl.json', 'sink_not_allowed'), ('models/x/ref_sql.sql', 'sink_not_allowed'),
                           ('knowledge/other/x.md', 'sink_not_allowed'), ('k' * 200, 'path_invalid')]:
            with self.subTest(path=path):
                self.refused(request((path, 'x\n')), code)

    def test_shape_and_bounds(self):
        self.refused(b'not json', 'request_invalid')
        self.refused(json.dumps({'version': 2, 'files': []}).encode(), 'request_invalid')
        self.refused(json.dumps({'version': True, 'files': []}).encode(), 'request_invalid')
        self.refused(json.dumps({'version': 1, 'files': [], 'extra': 1}).encode(), 'request_invalid')
        self.refused(json.dumps({'version': 1, 'files': []}).encode(), 'no_changes')
        self.refused(json.dumps({'version': 1, 'files': [{'path': 'knowledge/rules/a.md', 'content': 'x', 'more': 1}]}).encode(), 'request_invalid')
        self.refused(request(*[(f'knowledge/rules/r{i}.md', 'x\n') for i in range(21)]), 'too_many_files')
        self.refused(request(('knowledge/rules/a.md', 'x\n'), ('knowledge/rules/A.md', 'y\n')), 'duplicate_path')
        self.refused(request(('knowledge/rules/a.md', 'x' * (64 * 1024 + 1))), 'too_large')
        self.refused(request(('knowledge/rules/a.md', 'bad\x00text')), 'binary_content')
        self.refused(b'{"version":1,"files":[{"path":"knowledge/rules/a.md","content":"\\ud800"}]}', 'binary_content')

    def test_additive_rules(self):
        old = {'name': 'a', 'properties': {'description': 'x'}, 'columns': [{'name': 'c', 'type': 'INTEGER'}]}
        self.assertTrue(validator.additive(old, {**old, 'extra': 1}))
        self.assertTrue(validator.additive(old, {**old, 'columns': old['columns'] + [{'name': 'd', 'type': 'DATE'}]}))
        self.assertTrue(validator.additive(old, {**old, 'properties': {'description': 'x and more'}}))
        self.assertFalse(validator.additive(old, {**old, 'name': 'b'}))
        self.assertFalse(validator.additive(old, {**old, 'properties': {'description': 'different'}}))
        self.assertFalse(validator.additive(old, {**old, 'columns': []}))
        self.assertFalse(validator.additive(old, {k: v for k, v in old.items() if k != 'name'}))
        self.assertFalse(validator.additive(old, {**old, 'columns': [{'name': 'c', 'type': 'BIGINT'}]}))
        self.assertFalse(validator.additive({'a': 'text'}, {'a': 'text more'}))

    def test_duplicate_yaml_keys_are_refused(self):
        with self.assertRaises(Exception):
            validator.load_yaml('a: 1\na: 2\n')

    def test_symlink_in_the_snapshot_copy_is_refused(self):
        outside = self.root / 'outside.md'
        outside.write_text('outside\n')
        (self.snapshot / 'project/knowledge/rules/linked.md').symlink_to(outside)
        result = self.run_validator(('knowledge/rules/linked.md', 'outside\nmore\n'))
        self.assertEqual(self.failure(result)['code'], 'symlink')
        self.assertEqual(outside.read_text(), 'outside\n')

    def test_symlinked_directory_in_the_snapshot_copy_is_refused(self):
        outside = self.root / 'outside-dir'
        outside.mkdir()
        shutil.rmtree(self.snapshot / 'project/knowledge/rules')
        (self.snapshot / 'project/knowledge/rules').symlink_to(outside)
        result = self.run_validator(('knowledge/rules/new.md', 'x\n'))
        self.assertEqual(self.failure(result)['code'], 'symlink')
        self.assertEqual(os.listdir(outside), [])

    def test_sanitize_drops_paths_and_sql_context(self):
        text = validator.sanitize('Binder failed at /sandbox/validate-x/project/models/a.yml\x00 near LINE 1: SELECT secret FROM t')
        self.assertNotIn('/sandbox', text)
        self.assertNotIn('SELECT', text)
        self.assertLessEqual(len(validator.sanitize('x ' * 500)), 240)

    def test_source_snapshot_is_never_modified(self):
        before = {p: p.read_bytes() for p in self.snapshot.rglob('*') if p.is_file()}
        self.run_validator(('knowledge/rules/revenue.md', 'Revenue is net of refunds.\nAnd more.\n'))
        self.assertEqual({p: p.read_bytes() for p in self.snapshot.rglob('*') if p.is_file()}, before)
        self.assertEqual(os.listdir(self.scratch), [])


class RuntimeScope(Base):
    """Runtime scope: existing files only, and only knowledge, model descriptions and relationships."""

    def test_cube_and_view_sinks_are_unsupported_by_runtime(self):
        for path in ('cubes/order_metrics/metadata.yml', 'views/recent/metadata.yml'):
            with self.subTest(path=path):
                with self.assertRaises(validator.Refusal) as context:
                    validator.parse_request(request((path, 'name: x\n')))
                self.assertEqual(context.exception.code, 'unsupported_by_runtime')
                result = self.run_validator((path, 'name: x\n'))
                self.assertEqual(self.failure(result)['code'], 'unsupported_by_runtime')

    def test_a_file_the_snapshot_lacks_is_never_created(self):
        for path, content in (('knowledge/rules/brand-new.md', 'A rule.\n'), ('relationships.yml', 'relationships: []\n'), ('models/fresh/metadata.yml', 'name: fresh\n')):
            with self.subTest(path=path):
                self.assertEqual(self.failure(self.run_validator((path, content)))['code'], 'unsupported_by_runtime')
                self.assertFalse((self.snapshot / 'project' / path).exists())
        self.assertEqual(os.listdir(self.scratch), [])

    def test_existing_files_still_pass_the_scope_gate(self):
        result = self.run_validator(('knowledge/rules/revenue.md', 'Revenue is net of refunds.\nMore.\n'))
        self.assertNotEqual(result['checks'][0].get('code'), 'unsupported_by_runtime')

    def test_description_only_rule(self):
        old = {'name': 'a', 'properties': {'description': 'x'}, 'columns': [{'name': 'c', 'type': 'INTEGER'}]}
        description = validator.description_only
        self.assertTrue(description(old, {**old, 'properties': {'description': 'x and more'}}))
        self.assertTrue(description(old, {**old, 'columns': [{'name': 'c', 'type': 'INTEGER', 'description': 'Column c.'}]}))
        self.assertTrue(description(old, {**old, 'columns': [{'name': 'c', 'type': 'INTEGER', 'properties': {'description': 'Column c.'}}]}))
        self.assertFalse(description(old, {**old, 'columns': old['columns'] + [{'name': 'd', 'type': 'DATE'}]}))
        self.assertFalse(description(old, {**old, 'columns': old['columns'] + [{'name': 'g', 'type': 'DOUBLE', 'is_calculated': True, 'expression': 'c * 2'}]}))
        self.assertFalse(description(old, {**old, 'extra': 1}))
        self.assertFalse(description(old, {**old, 'columns': [{'name': 'c', 'type': 'INTEGER', 'expression': 'c * 2'}]}))
        self.assertFalse(description(old, {**old, 'columns': [{'name': 'c', 'type': 'INTEGER', 'properties': {'description': 'x', 'other': 1}}]}))
        self.assertFalse(description(old, {**old, 'columns': [{'name': 'c', 'type': 'INTEGER', 'description': 7}]}))
        self.assertFalse(description(old, {**old, 'properties': {'description': 'different'}}))

    def test_host_merged_description_bytes_are_description_only(self):
        # The exact shape the host's line-preserving merge emits: JSON-quoted description lines inserted after a `name` line or replacing a one-line description.
        before = 'name: orders\nref_sql: SELECT id, amount_minor FROM synthetic.orders\nproperties:\n  description: One row per order.\nprimary_key: id\ncolumns:\n  - name: id\n    type: INTEGER\n  - name: amount_minor\n    type: INTEGER\n'
        merged = ('name: orders\ndescription: "A \\"quoted\\" # note: x"\nref_sql: SELECT id, amount_minor FROM synthetic.orders\nproperties:\n  description: "One row per order. Amount in USD."\nprimary_key: id\ncolumns:\n'
                  '  - name: id\n    type: INTEGER\n  - name: amount_minor\n    description: "Order amount in minor units (cents); divide by 100 for USD."\n    type: INTEGER\n')
        old, new = validator.load_yaml(before), validator.load_yaml(merged)
        self.assertEqual(new['description'], 'A "quoted" # note: x')
        self.assertEqual(new['columns'][1]['description'], 'Order amount in minor units (cents); divide by 100 for USD.')
        self.assertTrue(validator.description_only(old, new))
        self.assertFalse(validator.description_only(old, {**new, 'primary_key': 'amount_minor'}))

    def test_new_column_and_calculated_column_in_an_existing_model_are_unsupported(self):
        plain = MODEL + '  - name: plain\n    type: DATE\n'
        calculated = MODEL + '  - name: gross\n    type: DOUBLE\n    is_calculated: true\n    expression: amount * 2\n'
        for content in (plain, calculated, MODEL + 'extra_key: 1\n'):
            with self.subTest(content=content[-40:]):
                self.assertEqual(self.failure(self.run_validator(('models/orders/metadata.yml', content)))['code'], 'unsupported_by_runtime')

    def test_a_description_append_passes_the_scope_gate_and_a_new_column_smuggled_in_with_it_does_not(self):
        described = MODEL.replace('One row per order.', 'One row per order. Includes refunds.')
        self.assertNotEqual(described, MODEL)
        result = self.run_validator(('models/orders/metadata.yml', described))
        self.assertNotIn(result['checks'][0].get('code'), ('unsupported_by_runtime', 'not_additive', 'yaml_invalid'))
        smuggled = described + '  - name: smuggled\n    type: INTEGER\n'
        self.assertEqual(self.failure(self.run_validator(('models/orders/metadata.yml', smuggled)))['code'], 'unsupported_by_runtime')

    def test_additivity_is_still_reported_as_not_additive_not_unsupported(self):
        changed = MODEL.replace('primary_key: id', 'primary_key: customer_id')
        self.assertEqual(self.failure(self.run_validator(('models/orders/metadata.yml', changed)))['code'], 'not_additive')


@unittest.skipUnless(HAVE_WREN, 'the wren library and duckdb are required')
class RealToolchain(Base):
    def test_valid_knowledge_append_returns_the_applied_change_set_and_mdl(self):
        content = 'Revenue is net of refunds.\nRefunds are excluded from revenue.\n'
        result = self.run_validator(('knowledge/rules/revenue.md', content))
        self.assertEqual(result['status'], 'ok')
        self.assertEqual(result['applied'], [{'path': 'knowledge/rules/revenue.md', 'content': content}])
        self.assertEqual({c['check']: c['status'] for c in result['checks']},
                         {'additivity': 'pass', 'context_validate': 'pass', 'context_build': 'pass', 'dry_plan': 'skipped', 'cube_sql': 'skipped', 'dry_run': 'skipped'})
        body = result['mdl']['content'].encode()
        self.assertEqual(result['mdl']['size'], len(body))
        self.assertEqual(__import__('hashlib').sha256(body).hexdigest(), result['mdl']['sha256'])
        self.assertEqual(json.loads(result['mdl']['content']), build_json(self.snapshot / 'project'))

    def test_model_description_append_is_planned(self):
        result = self.run_validator(('models/orders/metadata.yml', MODEL.replace('One row per order.', 'One row per order. Amounts in USD.')))
        self.assertEqual(result['status'], 'ok')
        self.assertEqual({c['check']: c['status'] for c in result['checks']}['dry_plan'], 'pass')

    def test_column_description_additions_are_validated_and_planned(self):
        edited = MODEL.replace('  - name: id\n    type: INTEGER\n', '  - name: id\n    type: INTEGER\n    properties:\n      description: Order identifier.\n') \
            .replace('  - name: amount\n    type: DOUBLE\n', '  - name: amount\n    type: DOUBLE\n    description: Order total.\n')
        result = self.run_validator(('models/orders/metadata.yml', edited))
        self.assertEqual(result['status'], 'ok')
        self.assertEqual({c['check']: c['status'] for c in result['checks']}['dry_plan'], 'pass')

    def test_non_additive_changes_are_refused_inside_the_sandbox_too(self):
        changed = MODEL.replace('primary_key: id', 'primary_key: customer_id')
        self.assertEqual(self.failure(self.run_validator(('models/orders/metadata.yml', changed)))['code'], 'not_additive')
        shrunk = MODEL.split('columns:')[0] + 'columns:\n  - name: id\n    type: INTEGER\n'
        self.assertEqual(self.failure(self.run_validator(('models/orders/metadata.yml', shrunk)))['code'], 'not_additive')
        self.assertEqual(self.failure(self.run_validator(('knowledge/rules/revenue.md', 'Replaced.\n')))['code'], 'not_additive')

    def test_a_snapshot_that_does_not_rebuild_to_its_own_mdl_fails_closed(self):
        # A projected config without schema_version loads no model, so the baseline differs from target/mdl.json.
        (self.snapshot / 'project/wren_project.yml').write_text('version: 1\ndata_source: duckdb\nprofile: snapshot\n')
        failed = self.failure(self.run_validator(('knowledge/rules/revenue.md', 'Revenue is net of refunds.\nMore.\n')))
        self.assertEqual((failed['check'], failed['code']), ('context_build', 'baseline_mismatch'))


if __name__ == '__main__':
    unittest.main()
