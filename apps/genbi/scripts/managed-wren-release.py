"""Build managed-runtime review metadata; this script never approves or publishes."""

import argparse
import email.parser
import hashlib
import json
import os
import re
from pathlib import Path
import sys
import urllib.request
import zipfile


PACKAGE = Path(__file__).resolve().parent.parent


def read_json_url(url):
    with urllib.request.urlopen(url, timeout=30) as response:
        return json.load(response)


def require_source_build(inputs):
    root = inputs["wrenai"]
    proof = root.get("sourceBuild", {})
    prefix = "https://github.com/goldmedal/WrenAI/releases/download/"
    if (not re.fullmatch(r"\d+\.\d+\.\d+\+genbi\.[1-9]\d*", root.get("version", ""))
            or not root.get("url", "").startswith(prefix)
            or proof.get("url") != root["url"].rsplit("/", 1)[0] + "/source-provenance.json"
            or not re.fullmatch(r"[a-f0-9]{64}", proof.get("sha256", ""))):
        raise SystemExit("exact fork sourceBuild is required")


def source_wheel_identity(wheel, sha256, meta, inputs):
    require_source_build(inputs)
    root = inputs["wrenai"]
    if (wheel.name != root["filename"] or sha256 != root["sha256"]
            or meta["Name"] != "wrenai" or meta["Version"] != root["version"]):
        raise SystemExit("source wheel differs from exact release input")
    prefix = "https://github.com/goldmedal/WrenAI/releases/download/"
    provenance = root["sourceBuild"]
    if (not root["url"].startswith(prefix)
            or root["url"].split("/")[-1] != wheel.name
            or provenance["url"] != root["url"].rsplit("/", 1)[0] + "/source-provenance.json"):
        raise SystemExit("source wheel must belong to its exact fork source release")
    with urllib.request.urlopen(provenance["url"], timeout=30) as response:
        raw = response.read()
    if hashlib.sha256(raw).hexdigest() != provenance["sha256"]:
        raise SystemExit("source provenance hash mismatch")
    receipt = json.loads(raw)
    source = json.loads((PACKAGE / "managed-wren/source-inputs.json").read_text())
    if (receipt.get("schema") != 1 or receipt.get("source") != source or source["version"] != root["version"]
            or receipt.get("wheel") != {"filename": wheel.name, "sha256": sha256, "version": meta["Version"]}):
        raise SystemExit("source provenance does not match reviewed source and wheel")
    return root["url"], provenance


def wheel_inventory(release, inputs=None):
    if inputs is not None:
        require_source_build(inputs)
    rows = []
    for wheel in sorted((release / "wheels").glob("*.whl")):
        with zipfile.ZipFile(wheel) as archive:
            entries = [n for n in archive.namelist() if n.endswith(".dist-info/METADATA")]
            if len(entries) != 1:
                raise SystemExit("wheel must have exactly one METADATA entry")
            # Wheel core metadata is UTF-8. Parsing bytes with compat32 wraps
            # non-ASCII values in Header objects instead of returning strings.
            meta = email.parser.Parser().parsestr(archive.read(entries[0]).decode("utf-8"))
        if len(meta.get_all("Name", [])) != 1 or len(meta.get_all("Version", [])) != 1:
            raise SystemExit("wheel must declare one Name and Version")
        expressions = meta.get_all("License-Expression", [])
        if len(expressions) > 1:
            raise SystemExit("wheel has ambiguous License-Expression")
        licenses = [v for v in meta.get_all("License", []) if v.strip() and v.strip() != "UNKNOWN"]
        classifiers = [v for v in meta.get_all("Classifier", []) if v.startswith("License ::")]
        license_value = "; ".join(expressions or licenses or classifiers) or "UNKNOWN"
        sha256 = hashlib.sha256(wheel.read_bytes()).hexdigest()
        build = None
        if meta["Name"] == "wrenai" and inputs:
            source, build = source_wheel_identity(wheel, sha256, meta, inputs)
        else:
            source_release = read_json_url(
                "https://pypi.org/pypi/{}/{}/json".format(meta["Name"], meta["Version"]))
            source = next(
                (item["url"] for item in source_release["urls"]
                 if item["filename"] == wheel.name and item["digests"]["sha256"] == sha256),
                None,
            )
        if not source:
            raise SystemExit("could not establish exact source identity for " + wheel.name)
        rows.append({
            "filename": wheel.name,
            "sha256": sha256,
            "distribution": meta["Name"].lower().replace("-", "_"),
            "version": meta["Version"],
            "license": license_value,
            "sourceUrl": source,
            **({"sourceBuild": build} if build else {}),
        })
    (release / "wheel-inputs.json").write_text(json.dumps(rows))
    (release / "wheel-license-inventory.json").write_text(
        json.dumps({"schema": 1, "wheels": rows}, indent=2)
    )


def pbs_inventory(paths, archive_sha256):
    evidence = [
        p.strip() for p in paths
        if any(marker in p.upper() for marker in ("LICENSE", "COPYING", "NOTICE"))
    ]
    return {
        "schema": 1,
        "archiveSha256": archive_sha256,
        "bundledLicenseEvidence": [
            {"path": p, "declaredLicense": "REVIEW_REQUIRED"} for p in evidence
        ],
    }


def requirements(release):
    rows = json.loads((release / "wheel-inputs.json").read_text())
    (release / "requirements.txt").write_text("".join(
        "{}=={} --hash=sha256:{}\n".format(row["distribution"], row["version"], row["sha256"])
        for row in rows
    ))


def notices(release, inputs):
    evidence = inputs["licenseEvidence"]
    if evidence["pythonSha256"] != inputs["python"]["sha256"]:
        raise SystemExit("retained license review does not cover selected Python")
    retained = {}
    for item in evidence["retained"]:
        if (item["filename"] not in ("pbs-license-inventory.json", "THIRD_PARTY_NOTICES.txt", "wheel-license-inventory.json")
                or item["filename"] in retained
                or not item["url"].startswith("https://github.com/goldmedal/WrenAI/releases/download/")):
            raise SystemExit("invalid retained license evidence")
        with urllib.request.urlopen(item["url"], timeout=30) as response:
            data = response.read()
        if hashlib.sha256(data).hexdigest() != item["sha256"]:
            raise SystemExit("retained license evidence hash mismatch")
        retained[item["filename"]] = data
    pbs = json.loads(retained["pbs-license-inventory.json"])
    if pbs["archiveSha256"] != inputs["python"]["sha256"]:
        raise SystemExit("retained bundled-library review differs from Python archive")
    (release / "pbs-license-inventory.json").write_bytes(retained["pbs-license-inventory.json"])
    text = retained["THIRD_PARTY_NOTICES.txt"].decode("utf-8")
    root = inputs["wrenai"]
    inventory = json.loads((release / "wheel-license-inventory.json").read_text())
    previous = {row["distribution"]: row for row in json.loads(retained["wheel-license-inventory.json"])["wheels"]}
    for row in inventory["wheels"]:
        if row["distribution"] == "wrenai":
            continue
        old = previous.get(row["distribution"], {})
        if any(row.get(key) != old.get(key) for key in ("filename", "sha256", "version", "sourceUrl", "license")):
            raise SystemExit("retained wheel license review differs from selected dependency")
        row["documents"] = old["documents"]
    text += "\n\n=== Selected fork Wren wheel " + root["version"] + " ===\n"
    text += "Source wheel: " + root["url"] + "\nSHA-256: " + root["sha256"] + "\n"
    with zipfile.ZipFile(release / "wheels" / root["filename"]) as archive:
        names = sorted(name for name in archive.namelist()
                       if ".dist-info/licenses/" in name and not name.endswith("/"))
        if not all(any(name.endswith("/" + license_name) for name in names)
                   for license_name in ("LICENSE", "LICENSE-APACHE-2.0")):
            raise SystemExit("fork wheel distribution license missing")
        documents = []
        for name in names:
            raw = archive.read(name)
            text += "\n--- " + name + " ---\n" + raw.decode("utf-8") + "\n"
            documents.append({"path": name, "source": {"wheelSha256": root["sha256"], "url": root["url"]}, "sha256": hashlib.sha256(raw).hexdigest()})
        next(row for row in inventory["wheels"] if row["distribution"] == "wrenai")["documents"] = documents
    inventory["schema"] = 2
    inventory["noticesSha256"] = hashlib.sha256(text.encode("utf-8")).hexdigest()
    (release / "wheel-license-inventory.json").write_text(json.dumps(inventory, indent=2))
    (release / "THIRD_PARTY_NOTICES.txt").write_text(text)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("command", choices=("wheels", "pbs", "requirements", "download", "notices"))
    parser.add_argument("--release-dir", type=Path, default=Path("release"))
    parser.add_argument("--inputs", type=Path, default=PACKAGE / "managed-wren/release-inputs.json")
    args = parser.parse_args()
    if args.command == "wheels":
        wheel_inventory(args.release_dir, json.loads(args.inputs.read_text()))
    elif args.command == "download":
        inputs = json.loads(args.inputs.read_text())
        require_source_build(inputs)
        root = inputs["wrenai"]
        lock = json.loads((PACKAGE / "managed-wren/dependency-wheels.json").read_text())
        wheels = args.release_dir / "wheels"
        wheels.mkdir(parents=True, exist_ok=True)
        for item in [root, *lock]:
            filename = item["filename"]
            if Path(filename).name != filename or not filename.endswith(".whl"):
                raise SystemExit("invalid wheel filename")
            url = item.get("sourceUrl", item.get("url"))
            if not url.startswith("https://"):
                raise SystemExit("HTTPS wheel source required")
            with urllib.request.urlopen(url, timeout=30) as response:
                data = response.read()
            if hashlib.sha256(data).hexdigest() != item["sha256"]:
                raise SystemExit("wheel download hash mismatch")
            with (wheels / filename).open("xb") as output:
                output.write(data)
    elif args.command == "pbs":
        # stdin is the verified archive's tar listing, not extracted file contents.
        print(json.dumps(pbs_inventory(sys.stdin, os.environ["PYTHON_SHA256"]), indent=2))
    elif args.command == "notices":
        notices(args.release_dir, json.loads(args.inputs.read_text()))
    else:
        requirements(args.release_dir)


if __name__ == "__main__":
    main()
