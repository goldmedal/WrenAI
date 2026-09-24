"""Collect exact, hash-verified redistribution documents without changing runtime bytes."""
import argparse
import hashlib
import json
from pathlib import Path, PurePosixPath
import re
import subprocess
import tarfile
import tempfile
import urllib.request
import zipfile


def sha(data):
    return hashlib.sha256(data).hexdigest()


def notice_path(name):
    return bool(re.fullmatch(r"(?:licen[cs]e(?:[._-].*)?|copying(?:[._-].*)?|notice(?:[._-].*)?|copyright(?:[._-].*)?)", PurePosixPath(name).name, re.I))


def safe_path(name):
    p = PurePosixPath(name)
    if p.is_absolute() or '..' in p.parts or not name:
        raise ValueError('unsafe document path')
    return name


def document(source, member, data):
    safe_path(member)
    text = data.decode('utf-8')
    if not text.strip():
        raise ValueError('empty redistribution document')
    return {'path': member, 'source': source, 'sha256': sha(data), 'text': text}


def verified_source(source, cache):
    key = source['sha256']
    if not re.fullmatch('[a-f0-9]{64}', key) or not source['url'].startswith('https://'):
        raise ValueError('invalid pinned source')
    file = cache / key
    if not file.exists():
        with urllib.request.urlopen(source['url'], timeout=90) as response:
            file.write_bytes(response.read())
    if sha(file.read_bytes()) != key:
        raise ValueError('license source hash mismatch')
    return file


def open_source(source, cache, stack):
    file = verified_source(source, cache)
    if source['format'] == 'text':
        return file.read_bytes()
    if source['format'] == 'tar.zst':
        temp = stack.enter_context(tempfile.TemporaryFile())
        subprocess.run(['zstd', '-dc', str(file)], stdout=temp, check=True, timeout=120)
        temp.seek(0)
        return stack.enter_context(tarfile.open(fileobj=temp))
    if source['format'] == 'tar.gz':
        return stack.enter_context(tarfile.open(file))
    raise ValueError('unsupported source format')


def archive_bytes(archive, name):
    entry = archive.getmember(safe_path(name))
    if not entry.isfile():
        raise ValueError('license entry must be a regular file')
    return archive.extractfile(entry).read()


def prove_install_identity(installed, full):
    count = 0
    for entry in installed:
        safe_path(entry.name)
        if entry.isdir():
            continue
        if not entry.name.startswith('python/'):
            raise ValueError('unexpected Python archive layout')
        counterpart = full.getmember('python/install/' + entry.name[len('python/'):])
        if entry.type != counterpart.type or entry.linkname != counterpart.linkname:
            raise ValueError('full/install archive entry differs')
        if entry.isfile():
            if installed.extractfile(entry).read() != full.extractfile(counterpart).read():
                raise ValueError('full/install archive bytes differ')
        elif not entry.issym():
            raise ValueError('unsupported Python archive entry')
        count += 1
    if count == 0:
        raise ValueError('empty install archive')
    return count


def collect(release, config, cache):
    from contextlib import ExitStack
    archive = release / 'python.tar.gz'
    if sha(archive.read_bytes()) != config['pythonArchiveSha256']:
        raise ValueError('unreviewed Python archive')
    cache.mkdir(parents=True, exist_ok=True)
    with ExitStack() as stack:
        sources = {key: open_source(value, cache, stack) for key, value in config['sources'].items()}
        full = sources['pbs-full']
        installed = stack.enter_context(tarfile.open(archive))
        matched = prove_install_identity(installed, full)
        metadata = json.loads(archive_bytes(full, 'python/PYTHON.json'))
        if metadata['python_version'] != '3.11.16' or metadata['target_triple'] != 'aarch64-apple-darwin':
            raise ValueError('wrong PBS release metadata')
        def supplemental(spec):
            src = config['sources'][spec['source']]
            source = sources[spec['source']]
            data = source if isinstance(source, bytes) else archive_bytes(source, spec['path'])
            return document({'url': src['url'], 'sha256': src['sha256']}, spec['path'], data)
        native = []
        for row in config['nativeComponents']:
            native.append({**row, 'documents': [supplemental(d) for d in row['documents']]})
        covered = {link for row in native for link in row.get('linkedNames', [])}
        extensions = {}
        for name, variants in metadata['build_info']['extensions'].items():
            for variant in variants:
                links = variant.get('links', [])
                for link in links:
                    if 'path_static' in link and link['name'] not in covered:
                        raise ValueError('unmapped bundled native dependency: ' + link['name'])
                if links:
                    extensions[name] = {'links': links, 'declaredLicenses': variant.get('licenses', [])}
        native_files = [m.name for m in installed.getmembers() if m.name.endswith(('.dylib', '.a'))]
        for name in native_files:
            if not any(token in name for token in ['libpython3.11', 'libtcl9.0', 'libtcl9tk9.0', 'itcl4.3.8/', 'thread3.0.6/']):
                raise ValueError('unmapped installed native library: ' + name)
        retained = [document({'archiveSha256': config['pythonArchiveSha256']}, m.name, installed.extractfile(m).read())
                    for m in installed.getmembers() if m.isfile() and notice_path(m.name)]
        vendor_manifests = [document({'archiveSha256': config['pythonArchiveSha256']}, m.name, installed.extractfile(m).read())
                            for m in installed.getmembers() if m.isfile() and m.name.endswith('/vendor.txt')]
        pbs = {'schema': 2, 'archiveSha256': config['pythonArchiveSha256'],
               'sourceRelease': config['pbsRelease'], 'sourceCommit': config['pbsCommit'],
               'fullDistribution': config['sources']['pbs-full'], 'matchingInstallEntries': matched,
               'pythonVersion': metadata['python_version'], 'pythonLicenses': metadata['licenses'],
               'documents': [supplemental({'source': 'pbs-full', 'path': 'python/' + metadata['license_path']})],
               'nativeComponents': native, 'extensionLinks': extensions, 'installedNativeLibraries': native_files,
               'retainedDocuments': retained, 'vendorVersionManifests': vendor_manifests}
        wheel_rows = json.loads((release / 'wheel-inputs.json').read_text())
        for row in wheel_rows:
            wheel = release / 'wheels' / safe_path(row['filename'])
            if sha(wheel.read_bytes()) != row['sha256']:
                raise ValueError('wheel hash mismatch')
            with zipfile.ZipFile(wheel) as z:
                docs = [document({'wheelSha256': row['sha256'], 'url': row['sourceUrl']}, n, z.read(n))
                        for n in sorted(z.namelist()) if not n.endswith('/') and notice_path(n)]
            extra = config['wheelSupplements'].get(row['distribution'])
            if extra:
                if (extra['version'], extra['wheelSha256']) != (row['version'], row['sha256']):
                    raise ValueError('supplement does not match exact wheel')
                docs.extend(supplemental(d) for d in extra['documents'])
            if not docs:
                raise ValueError('wheel missing redistribution documents: ' + row['distribution'])
            row['documents'] = docs
        (release / 'pbs-license-inventory.json').write_text(json.dumps(pbs, indent=2) + '\n')
        (release / 'wheel-license-inventory.json').write_text(json.dumps({'schema': 2, 'wheels': wheel_rows}, indent=2) + '\n')


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--release-dir', type=Path, default=Path('release'))
    parser.add_argument('--source-cache', type=Path)
    args = parser.parse_args()
    config = json.loads((Path(__file__).resolve().parent.parent / 'managed-wren/license-inputs.json').read_text())
    collect(args.release_dir, config, args.source_cache or args.release_dir / 'license-source-cache')


if __name__ == '__main__':
    main()
