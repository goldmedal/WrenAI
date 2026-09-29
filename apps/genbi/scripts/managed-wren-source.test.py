"""Offline source-build boundary tests; no tools or source are downloaded."""

import copy
import io
import json
from pathlib import Path
import runpy
import tarfile
import tempfile
import unittest


SCRIPT = Path(__file__).with_name("managed-wren-source.py")
BUILD = runpy.run_path(str(SCRIPT))
SPEC = json.loads((SCRIPT.parent.parent / "managed-wren/source-inputs.json").read_text())


class SourceBuildTests(unittest.TestCase):
    def test_rejects_unpinned_or_other_repository_and_ambiguous_versions(self):
        BUILD["validate"](SPEC)
        for key, value in [
            ("commit", "main"), ("archiveSha256", ""),
            ("archiveUrl", SPEC["archiveUrl"].replace("goldmedal", "Canner")),
            ("archiveUrl", SPEC["archiveUrl"] + "?changed"),
            ("version", SPEC["baseVersion"]), ("version", "0.13.0+genbi.0"),
            ("version", "0.13.0+other.1"), ("baseVersion", "latest"),
        ]:
            with self.subTest(key=key, value=value):
                spec = copy.deepcopy(SPEC)
                spec[key] = value
                with self.assertRaises(ValueError):
                    BUILD["validate"](spec)

    def test_builder_closure_requires_unique_safe_hashed_public_wheels(self):
        mutations = [
            lambda tools: tools.clear(),
            lambda tools: tools.append(tools[0]),
            lambda tools: tools[0].update(filename="../tool.whl"),
            lambda tools: tools[0].update(sha256=""),
            lambda tools: tools[0].update(url="http://example.test/tool.whl"),
        ]
        for mutate in mutations:
            spec = copy.deepcopy(SPEC)
            mutate(spec["builderWheels"])
            with self.assertRaises(ValueError):
                BUILD["validate"](spec)

    def archive(self, entries):
        data = io.BytesIO()
        with tarfile.open(fileobj=data, mode="w:gz") as archive:
            for name, kind in entries:
                item = tarfile.TarInfo(name)
                item.type = kind
                if kind == tarfile.REGTYPE:
                    item.size = 7
                    archive.addfile(item, io.BytesIO(b"fixture"))
                else:
                    item.linkname = "/outside"
                    archive.addfile(item)
        return data.getvalue()

    def test_extracts_only_selected_package_and_license(self):
        root = "WrenAI-" + SPEC["commit"] + "/"
        data = self.archive([(root + name, tarfile.REGTYPE) for name in
                             ("LICENSE", "LICENSE-APACHE-2.0", "core/wren/src/wren/cli.py", "other/unused.py")])
        with tempfile.TemporaryDirectory() as temporary:
            dest = Path(temporary)
            BUILD["extract_source"](data, dest, SPEC["commit"])
            self.assertEqual((dest / "LICENSE").read_text(), "fixture")
            self.assertEqual((dest / "LICENSE-APACHE-2.0").read_text(), "fixture")
            self.assertTrue((dest / "src/wren/cli.py").is_file())
            self.assertFalse((dest / "other").exists())

    def test_missing_apache_license_rejects_source(self):
        root = "WrenAI-" + SPEC["commit"] + "/"
        data = self.archive([(root + "LICENSE", tarfile.REGTYPE)])
        with tempfile.TemporaryDirectory() as temporary, self.assertRaisesRegex(ValueError, "license"):
            BUILD["extract_source"](data, Path(temporary), SPEC["commit"])

    def test_links_traversal_and_duplicate_entries_fail(self):
        root = "WrenAI-" + SPEC["commit"] + "/"
        cases = [[(root + "core/wren/src/link", kind)] for kind in
                 (tarfile.SYMTYPE, tarfile.LNKTYPE, tarfile.FIFOTYPE)]
        cases += [[(root + "core/wren/../escape", tarfile.REGTYPE)],
                  [("/absolute", tarfile.REGTYPE)],
                  [(root + "LICENSE", tarfile.REGTYPE)] * 2]
        for entries in cases:
            with tempfile.TemporaryDirectory() as temporary, self.assertRaises((ValueError, FileExistsError)):
                BUILD["extract_source"](self.archive(entries), Path(temporary), SPEC["commit"])


if __name__ == "__main__":
    unittest.main()
