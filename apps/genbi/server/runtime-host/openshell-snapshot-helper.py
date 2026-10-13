"""Bounded descriptor-anchored snapshot capture and independent verification.

Only the trusted host invokes capture. No source file is ever opened for writing.
The publication archive goes to inherited descriptor 3, never a supplied path.
"""
import hashlib
import io
import json
import os
import re
import stat
import sys
import tarfile

MAX_FILES = 4096
MAX_TOTAL = 256 * 1024 * 1024
MAX_FILE = 128 * 1024 * 1024
MAX_MANIFEST = 1024 * 1024


def canonical(value):
    return json.dumps(value, sort_keys=True, separators=(',', ':'), ensure_ascii=True).encode('ascii')


def digest(value):
    return 'sha256:' + hashlib.sha256(canonical(value)).hexdigest()


def safe_path(value):
    if not isinstance(value, str) or not value or len(value.encode('utf8')) > 240:
        raise ValueError('path')
    parts = value.split('/')
    if len(parts) > 16 or any(not part or not (part[0].isascii() and part[0].isalnum()) or
                              any(not (c.isascii() and (c.isalnum() or c in '_-.')) for c in part)
                              for part in parts):
        raise ValueError('path')
    return parts


def anchored_root(value):
    if not isinstance(value, str) or not value.startswith('/') or '\x00' in value:
        raise ValueError('root')
    # Linux O_PATH anchors ancestors without asking Landlock for permission to
    # read their contents. Only the admitted final root needs a readable fd.
    ancestor_flags = getattr(os, 'O_PATH', os.O_RDONLY) | os.O_DIRECTORY | os.O_NOFOLLOW
    fd = os.open('/', ancestor_flags)
    try:
        parts = value.split('/')[1:]
        for index, part in enumerate(parts):
            if not part or part in ('.', '..'):
                raise ValueError('root')
            flags = os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW if index == len(parts) - 1 else ancestor_flags
            child = os.open(part, flags, dir_fd=fd)
            os.close(fd)
            fd = child
        return fd
    except BaseException:
        os.close(fd)
        raise


def stamp(info):
    return (info.st_dev, info.st_ino, info.st_size, info.st_mtime_ns, info.st_ctime_ns)


def read_regular(parent, name, limit):
    fd = os.open(name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=parent)
    try:
        before = os.fstat(fd)
        if not stat.S_ISREG(before.st_mode) or before.st_nlink != 1 or before.st_size > limit:
            raise ValueError('file')
        with os.fdopen(os.dup(fd), 'rb') as stream:
            data = stream.read(limit + 1)
        if len(data) > limit or stamp(before) != stamp(os.fstat(fd)):
            raise ValueError('drift')
        return data
    finally:
        os.close(fd)


def inventory(root, allowed=None, exclude_manifest=False):
    files = {}
    total = 0
    folded = set()

    def walk(fd, prefix):
        nonlocal total
        before = os.fstat(fd)
        names = sorted(os.listdir(fd))
        for name in names:
            relative = prefix + name
            safe_path(relative)
            if relative.lower() in folded:
                raise ValueError('alias')
            folded.add(relative.lower())
            info = os.stat(name, dir_fd=fd, follow_symlinks=False)
            if stat.S_ISDIR(info.st_mode):
                if allowed is not None and not any(p.startswith(relative + '/') for p in allowed):
                    raise ValueError('undeclared')
                child = os.open(name, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=fd)
                try:
                    if (info.st_dev, info.st_ino) != (os.fstat(child).st_dev, os.fstat(child).st_ino):
                        raise ValueError('drift')
                    walk(child, relative + '/')
                finally:
                    os.close(child)
            else:
                if not stat.S_ISREG(info.st_mode) or info.st_nlink != 1:
                    raise ValueError('file')
                if relative.lower().endswith(('.wal', '-wal', '-shm', '.journal', '-journal')):
                    raise ValueError('writer')
                if exclude_manifest and relative == 'snapshot.json':
                    continue
                if allowed is not None and relative not in allowed:
                    raise ValueError('undeclared')
                data = read_regular(fd, name, min(MAX_FILE, MAX_TOTAL - total))
                total += len(data)
                files[relative] = data
                if len(files) > MAX_FILES:
                    raise ValueError('limit')
        if names != sorted(os.listdir(fd)) or stamp(before) != stamp(os.fstat(fd)):
            raise ValueError('drift')

    walk(root, '')
    if allowed is not None and set(files) != set(allowed):
        raise ValueError('missing')
    return files


def entries(files):
    return [{'path': p, 'size': len(files[p]), 'sha256': hashlib.sha256(files[p]).hexdigest()}
            for p in sorted(files)]


def validate_body(body):
    if set(body) != {'version', 'project', 'bindingGeneration', 'bindingRevision', 'context', 'source', 'files'} or body['version'] != 1:
        raise ValueError('manifest')
    for name in ('project', 'bindingRevision', 'context', 'source'):
        value = body[name]
        if not isinstance(value, str) or len(value) != 71 or not value.startswith('sha256:') or any(c not in '0123456789abcdef' for c in value[7:]):
            raise ValueError('manifest')
    if not isinstance(body['bindingGeneration'], str) or not body['bindingGeneration'].isdigit() or len(body['bindingGeneration']) > 20:
        raise ValueError('manifest')


def capture(request):
    if set(request) != {'root', 'identity', 'paths', 'project', 'bindingGeneration', 'bindingRevision', 'context', 'projection'}:
        raise ValueError('request')
    paths = request['paths']
    if not isinstance(paths, list) or len(paths) > MAX_FILES - 2 or len(set(paths)) != len(paths):
        raise ValueError('paths')
    for p in paths:
        safe_path(p)
    if len({p.lower() for p in paths}) != len(paths):
        raise ValueError('alias')
    root = anchored_root(request['root'])
    try:
        info = os.fstat(root)
        if request['identity'] != f'dev:{info.st_dev}:ino:{info.st_ino}':
            raise ValueError('identity')
        files = inventory(root, paths)
        configuration = files['wren_project.yml'].decode('utf8')
        sources = re.findall(r'^data_source:\s*([^\r\n#]+)', configuration, flags=re.MULTILINE)
        if len(sources) != 1 or sources[0].strip().strip('\"\'') != 'duckdb':
            raise ValueError('datasource')
        semantic = hashlib.sha256()
        for p in ('wren_project.yml', 'target/mdl.json'):
            semantic.update(p.encode()); semantic.update(files[p])
        if request['bindingRevision'] != 'sha256:' + semantic.hexdigest():
            raise ValueError('revision')
        source = digest(entries(files))
        if entries(files) != entries(inventory(root, paths)):
            raise ValueError('drift')
        # Reopen the full root chain to reject a renamed/replaced root too.
        current = anchored_root(request['root'])
        try:
            if (info.st_dev, info.st_ino) != (os.fstat(current).st_dev, os.fstat(current).st_ino):
                raise ValueError('drift')
        finally:
            os.close(current)
        payload = {'project/' + p: data for p, data in files.items()}
        projection = request['projection']
        if not isinstance(projection, dict) or set(projection) != {'project/wren_project.yml', 'wren-home/profiles.yml'}:
            raise ValueError('projection')
        for p, text in projection.items():
            if not isinstance(text, str) or len(text.encode()) > 65536:
                raise ValueError('projection')
            payload[p] = text.encode()
        if sum(map(len, payload.values())) > MAX_TOTAL or len(payload) > MAX_FILES:
            raise ValueError('limit')
        body = {k: request[k] for k in ('project', 'bindingGeneration', 'bindingRevision', 'context')}
        body.update(version=1, source=source, files=entries(payload))
        validate_body(body)
        manifest = {**body, 'digest': digest(body)}
        document = canonical(manifest)
        if len(document) > MAX_MANIFEST:
            raise ValueError('limit')
        payload['snapshot.json'] = document
        with os.fdopen(os.dup(3), 'wb') as stream:
            with tarfile.open(fileobj=stream, mode='w|') as archive:
                dirs = sorted({parent for p in payload for parent in
                               ['/'.join(p.split('/')[:i]) for i in range(1, len(p.split('/')))]})
                for p in dirs:
                    member = tarfile.TarInfo(p)
                    member.type = tarfile.DIRTYPE
                    # The publisher drops DAC override capabilities: it must be
                    # able to create children before the volume becomes read-only.
                    member.mode = 0o755
                    archive.addfile(member)
                for p in sorted(payload):
                    member = tarfile.TarInfo(p)
                    member.size = len(payload[p])
                    member.mode = 0o444
                    archive.addfile(member, io.BytesIO(payload[p]))
        print(document.decode())
    finally:
        os.close(root)


def verify(root_path, expected):
    root = anchored_root(root_path)
    try:
        raw = read_regular(root, 'snapshot.json', MAX_MANIFEST)
        document = json.loads(raw)
        body = {k: v for k, v in document.items() if k != 'digest'}
        validate_body(body)
        if set(document) != set(body) | {'digest'} or raw != canonical(document) or document['digest'] != expected or digest(body) != expected:
            raise ValueError('digest')
        # The manifest also defines the exact permitted parent directories;
        # otherwise an extra empty directory would evade a file-only inventory.
        actual = inventory(root, allowed=[entry['path'] for entry in body['files']], exclude_manifest=True)
        if body['files'] != entries(actual):
            raise ValueError('content')
        print(canonical(document).decode())
    finally:
        os.close(root)


def main():
    if sys.argv[1:] == ['probe']:
        if os.open not in os.supports_dir_fd or os.listdir not in os.supports_fd or not hasattr(os, 'O_NOFOLLOW'):
            raise ValueError('capability')
        print('{"protocol":"genbi-snapshot/1","anchored":true}')
    elif sys.argv[1:] == ['capture']:
        data = sys.stdin.buffer.read(MAX_MANIFEST + 1)
        if len(data) > MAX_MANIFEST:
            raise ValueError('limit')
        capture(json.loads(data))
    elif len(sys.argv) == 4 and sys.argv[1] == 'verify':
        verify(sys.argv[2], sys.argv[3])
    else:
        raise ValueError('operation')


if __name__ == '__main__':
    try:
        main()
    except BaseException:
        sys.stderr.write('Snapshot operation refused.\n')
        sys.exit(1)
