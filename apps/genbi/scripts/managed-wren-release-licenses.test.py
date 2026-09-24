import hashlib
import importlib.util
import io
import json
from pathlib import Path
import tarfile
import tempfile
import unittest
from unittest.mock import patch
import zipfile

spec = importlib.util.spec_from_file_location('licenses', Path(__file__).with_name('managed-wren-release-licenses.py'))
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)


def tar(path, entries):
    with tarfile.open(path, 'w:gz') as a:
        for name, data in entries.items():
            entry = tarfile.TarInfo(name)
            entry.size = len(data)
            a.addfile(entry, io.BytesIO(data))


class LicenseEvidenceTests(unittest.TestCase):
    def test_notice_filter_excludes_python_modules_and_includes_license_terms(self):
        for name in ['x/LICENSE', 'x/license.terms', 'x/LICENSE-APACHE-2.0', 'x/NOTICE.txt']:
            self.assertTrue(m.notice_path(name))
        for name in ['packaging/licenses/_spdx.py', 'licenses/__init__.py', 'LICENSE/file.py']:
            self.assertFalse(m.notice_path(name))

    def test_source_hash_checked_even_on_cache_hit(self):
        with tempfile.TemporaryDirectory() as d:
            root = Path(d); h = m.sha(b'expected'); (root / h).write_bytes(b'tampered')
            with patch.object(m.urllib.request, 'urlopen', side_effect=AssertionError('network')):
                with self.assertRaisesRegex(ValueError, 'hash mismatch'):
                    m.verified_source({'sha256': h, 'url': 'https://example.invalid/license'}, root)

    def test_collect_binds_full_archive_and_all_wheels_without_changing_bytes(self):
        with tempfile.TemporaryDirectory() as d:
            root = Path(d); release = root / 'release'; release.mkdir(); cache = root / 'cache'; cache.mkdir()
            (release / 'wheels').mkdir()
            entries = {'python/bin/python3.11': b'python', 'python/lib/libpython3.11.dylib': b'library', 'python/LICENSE.txt': b'Python license'}
            tar(release / 'python.tar.gz', entries)
            metadata = {'python_version': '3.11.16', 'target_triple': 'aarch64-apple-darwin', 'licenses': ['Python-2.0'], 'license_path': 'licenses/LICENSE.cpython.txt', 'build_info': {'extensions': {'_ctypes': [{'links': [{'name': 'ffi', 'path_static': 'build/lib/libffi.a'}]}]}}}
            full = root / 'full.tar.gz'
            full_entries = {'python/install/' + n[len('python/'):]: b for n, b in entries.items()}
            full_entries.update({'python/PYTHON.json': json.dumps(metadata).encode(), 'python/licenses/LICENSE.cpython.txt': b'Python license', 'python/licenses/LICENSE.ffi.txt': b'MIT fixture'})
            tar(full, full_entries); full_hash = m.sha(full.read_bytes()); (cache / full_hash).write_bytes(full.read_bytes())
            wheel = release / 'wheels/example.whl'
            with zipfile.ZipFile(wheel, 'w') as z: z.writestr('example.dist-info/LICENSE', 'MIT fixture')
            row = {'distribution': 'example', 'version': '1.0', 'filename': wheel.name, 'sha256': m.sha(wheel.read_bytes()), 'sourceUrl': 'https://example.invalid/example.whl'}
            (release / 'wheel-inputs.json').write_text(json.dumps([row]))
            config = {'pythonArchiveSha256': m.sha((release / 'python.tar.gz').read_bytes()), 'pbsRelease': 'fixture', 'pbsCommit': 'a'*40, 'sources': {'pbs-full': {'format': 'tar.gz', 'url': 'https://example.invalid/full.tar.gz', 'sha256': full_hash}}, 'nativeComponents': [{'name': 'libffi', 'linkedNames': ['ffi'], 'documents': [{'source': 'pbs-full', 'path': 'python/licenses/LICENSE.ffi.txt'}]}], 'wheelSupplements': {}}
            with patch.object(m.urllib.request, 'urlopen', side_effect=AssertionError('network')):
                m.collect(release, config, cache)
                pbs = json.loads((release / 'pbs-license-inventory.json').read_text())
                wheels = json.loads((release / 'wheel-license-inventory.json').read_text())
                self.assertEqual(pbs['matchingInstallEntries'], 3)
                self.assertEqual(wheels['wheels'][0]['documents'][0]['text'], 'MIT fixture')
                self.assertEqual(m.sha((release / 'python.tar.gz').read_bytes()), config['pythonArchiveSha256'])
                self.assertEqual(m.sha(wheel.read_bytes()), row['sha256'])
                config['wheelSupplements'] = {'example': {'version': '2.0', 'wheelSha256': row['sha256'], 'documents': []}}
                with self.assertRaisesRegex(ValueError, 'exact wheel'): m.collect(release, config, cache)
                config['wheelSupplements'] = {}
                row['sha256'] = 'f' * 64
                (release / 'wheel-inputs.json').write_text(json.dumps([row]))
                with self.assertRaisesRegex(ValueError, 'wheel hash'): m.collect(release, config, cache)
                with zipfile.ZipFile(wheel, 'w') as z: z.writestr('package.py', 'code')
                row['sha256'] = m.sha(wheel.read_bytes())
                (release / 'wheel-inputs.json').write_text(json.dumps([row]))
                with self.assertRaisesRegex(ValueError, 'missing redistribution'): m.collect(release, config, cache)
                config['nativeComponents'] = []
                with self.assertRaisesRegex(ValueError, 'unmapped bundled'): m.collect(release, config, cache)

    def test_mismatched_full_build_is_rejected(self):
        with tempfile.TemporaryDirectory() as d:
            a, b = Path(d)/'a.tar.gz', Path(d)/'b.tar.gz'
            tar(a, {'python/bin/python': b'one'}); tar(b, {'python/install/bin/python': b'two'})
            with tarfile.open(a) as aa, tarfile.open(b) as bb:
                with self.assertRaisesRegex(ValueError, 'bytes differ'): m.prove_install_identity(aa, bb)

    def test_documents_cannot_be_empty_links_or_unsafe_paths(self):
        for name, text in [('LICENSE', b''), ('../LICENSE', b'license')]:
            with self.assertRaises(ValueError): m.document({}, name, text)
        with tempfile.TemporaryDirectory() as d:
            p = Path(d)/'linked.tar.gz'
            with tarfile.open(p, 'w:gz') as a:
                entry = tarfile.TarInfo('LICENSE'); entry.type = tarfile.SYMTYPE; entry.linkname = '/outside'; a.addfile(entry)
            with tarfile.open(p) as a:
                with self.assertRaisesRegex(ValueError, 'regular file'): m.archive_bytes(a, 'LICENSE')


if __name__ == '__main__': unittest.main()
