"""Trusted project adapter: one validated Wren context snapshot plus the engine over its build."""

from __future__ import annotations

import hashlib
from pathlib import Path

from pydantic import BaseModel, ConfigDict, Field

from wren.context_adapter import ContextReader, Snapshot, project_digest


class Query(BaseModel):
    """Transitional count request: ``SELECT COUNT(*)`` over one model of the project.

    It exists so a deployment can offer a bounded count without SQL authoring; it is planned
    and executed through the same path as ``run_sql``.
    """

    model_config = ConfigDict(extra="forbid", strict=True)
    model: str = Field(pattern=r"^[A-Za-z_][A-Za-z0-9_]*$", max_length=128)


def count_sql(model: str) -> str:
    return f'SELECT COUNT(*) FROM "{model}"'


def discover(explicit: Path | None) -> Path:
    if explicit is not None:
        root = explicit.expanduser().resolve(strict=True)
        if not (root / "wren_project.yml").is_file():
            raise ValueError("invalid_project")
        return root
    here = Path.cwd().resolve()
    for root in [here, *here.parents]:
        if (root / "wren_project.yml").is_file():
            return root
        if root == Path.home() or root == root.parent:
            break
    raise ValueError("project_not_found")


def contained(root: Path, relative: str) -> Path:
    target = (root / relative).resolve(strict=True)
    if not target.is_relative_to(root) or not target.is_file():
        raise ValueError("invalid_project_file")
    return target


class Project:
    """The bound project: its context snapshot, the planner documents, and the engine.

    ``version`` fingerprints the project sources (via the loader's content digest definition),
    the built manifest and every extra file the service registers in ``paths``; any change
    makes ``current`` raise ``context_changed``.
    """

    def __init__(
        self,
        root: Path,
        config: dict,
        engine,
        snapshot: Snapshot,
        reader: ContextReader,
    ):
        self.root, self.config, self.engine = root, config, engine
        self.snapshot, self.reader = snapshot, reader
        self.documents = reader.documents()
        self.paths = [root / "target/mdl.json"]
        self.version = self.fingerprint()

    def describe(self) -> str:
        """Host-generated, caller-safe business summary, one line per model."""
        return self.reader.describe()

    def fingerprint(self):
        digest = hashlib.sha256()
        digest.update(b"project\0" + project_digest(self.root).encode() + b"\0")
        for path in self.paths:
            data = path.read_bytes()
            digest.update(str(path).encode() + b"\0")
            digest.update(str(len(data)).encode() + b"\0" + data)
        return digest.hexdigest()

    def current(self):
        if self.fingerprint() != self.version:
            raise ValueError("context_changed")
