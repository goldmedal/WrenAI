"""Build a fork-only Wren wheel from hash-pinned public source and build tools.

This helper never publishes. Its output is a separate source-wheel release,
which the managed-runtime workflow subsequently downloads by exact digest.
"""

import argparse
import email.parser
import hashlib
import io
import json
import os
from pathlib import Path, PurePosixPath
import re
import subprocess
import sys
import tarfile
import tempfile
import urllib.request
import zipfile


def digest(data):
    return hashlib.sha256(data).hexdigest()


def validate(spec):
    commit = spec.get("commit", "")
    if not re.fullmatch(r"[a-f0-9]{40}", commit):
        raise ValueError("fixed source commit required")
    expected = "https://codeload.github.com/goldmedal/WrenAI/tar.gz/" + commit
    if spec.get("archiveUrl") != expected or not re.fullmatch(r"[a-f0-9]{64}", spec.get("archiveSha256", "")):
        raise ValueError("exact public fork source required")
    if not re.fullmatch(r"\d+\.\d+\.\d+", spec.get("baseVersion", "")):
        raise ValueError("base version required")
    if not re.fullmatch(re.escape(spec["baseVersion"]) + r"\+genbi\.[1-9]\d*", spec.get("version", "")):
        raise ValueError("distinct fork version required")
    tools = spec.get("builderWheels", [])
    if not tools or len({t.get("filename") for t in tools}) != len(tools):
        raise ValueError("unique pinned builder closure required")
    for tool in tools:
        if (not re.fullmatch(r"[A-Za-z0-9._+-]+\.whl", tool.get("filename", ""))
                or not tool.get("url", "").startswith("https://files.pythonhosted.org/packages/")
                or tool["url"].split("/")[-1] != tool["filename"]
                or not re.fullmatch(r"[a-f0-9]{64}", tool.get("sha256", ""))):
            raise ValueError("exact builder wheel required")


def fetch(url, expected):
    with urllib.request.urlopen(url, timeout=60) as response:
        data = response.read()
    if digest(data) != expected:
        raise ValueError("download digest mismatch")
    return data


def extract_source(data, destination, commit):
    prefix = "WrenAI-" + commit
    selected = 0
    with tarfile.open(fileobj=io.BytesIO(data), mode="r:gz") as archive:
        for item in archive:
            parts = PurePosixPath(item.name).parts
            if not parts or parts[0] != prefix or ".." in parts or item.name.startswith("/"):
                raise ValueError("invalid source archive path")
            if parts[1:3] == ("core", "wren"):
                relative = PurePosixPath(*parts[3:])
            elif parts[1:] in (("LICENSE",), ("LICENSE-APACHE-2.0",), ("NOTICE",)):
                relative = PurePosixPath(parts[-1])
            else:
                continue
            if item.isdir():
                continue
            if not item.isfile() or not relative.parts:
                raise ValueError("source links and special files are forbidden")
            target = destination.joinpath(*relative.parts)
            target.parent.mkdir(parents=True, exist_ok=True)
            with target.open("xb") as output:
                output.write(archive.extractfile(item).read())
            target.chmod(0o644)
            selected += 1
    if not selected or not all((destination / name).is_file() for name in ("LICENSE", "LICENSE-APACHE-2.0")):
        raise ValueError("source and distribution license required")


def build(spec, output):
    validate(spec)
    if sys.version_info[:2] != (3, 11):
        raise ValueError("build requires Python 3.11")
    output.mkdir(mode=0o700, parents=True, exist_ok=False)
    with tempfile.TemporaryDirectory(prefix="wren-source-") as temporary:
        root = Path(temporary)
        source = root / "source"
        source.mkdir()
        extract_source(fetch(spec["archiveUrl"], spec["archiveSha256"]), source, spec["commit"])
        project = source / "pyproject.toml"
        old = 'version = "' + spec["baseVersion"] + '"'
        text = project.read_text()
        if text.count(old) != 1:
            raise ValueError("source version differs from reviewed base")
        project.write_text(text.replace(old, 'version = "' + spec["version"] + '"', 1))
        wheels = root / "builder-wheels"
        wheels.mkdir()
        for tool in spec["builderWheels"]:
            (wheels / tool["filename"]).write_bytes(fetch(tool["url"], tool["sha256"]))
        env = {"HOME": str(root), "PATH": "/usr/bin:/bin", "SOURCE_DATE_EPOCH": "315532800",
               "PYTHONNOUSERSITE": "1", "PYTHONDONTWRITEBYTECODE": "1", "PIP_CONFIG_FILE": os.devnull}
        venv = root / "builder"
        subprocess.run([sys.executable, "-m", "venv", str(venv)], env=env, check=True, timeout=60)
        python = str(venv / "bin/python")
        subprocess.run([python, "-m", "pip", "install", "--no-index", "--no-deps", *map(str, sorted(wheels.glob("*.whl")))], env=env, check=True, timeout=60)
        subprocess.run([python, "-m", "hatchling", "build", "-t", "wheel", "-d", str(output.resolve())], cwd=source, env=env, check=True, timeout=60)
    built = list(output.glob("*.whl"))
    expected_name = "wrenai-" + spec["version"] + "-py3-none-any.whl"
    if len(built) != 1 or built[0].name != expected_name:
        raise ValueError("unexpected wheel output")
    with zipfile.ZipFile(built[0]) as archive:
        names = archive.namelist()
        if not all(name in names for name in ("wren/governed_stdio.py", "wren/read_only.py", "wren/query_semantics.py")):
            raise ValueError("governed transport missing from wheel")
        if not any(name.endswith(".dist-info/licenses/LICENSE-APACHE-2.0") for name in names):
            raise ValueError("Apache-2.0 distribution license missing from wheel")
        metadata = next(name for name in names if name.endswith(".dist-info/METADATA"))
        parsed = email.parser.Parser().parsestr(archive.read(metadata).decode())
        if parsed["Name"] != "wrenai" or parsed["Version"] != spec["version"]:
            raise ValueError("wheel identity mismatch")
    receipt = {"schema": 1, "source": spec, "wheel": {"filename": built[0].name, "sha256": digest(built[0].read_bytes()), "version": spec["version"]},
               "sourceChanges": ["fork package version label", "include repository LICENSE and LICENSE-APACHE-2.0 plus NOTICE when present"],
               "builderScriptSha256": digest(Path(__file__).read_bytes())}
    (output / "source-provenance.json").write_text(json.dumps(receipt, indent=2) + "\n")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("inputs", type=Path)
    parser.add_argument("output", type=Path)
    args = parser.parse_args()
    build(json.loads(args.inputs.read_text()), args.output)
