"""Trusted project adapter for bounded, read-only analytical plans."""

from __future__ import annotations

import hashlib
import json
import re
from datetime import date
from pathlib import Path
from typing import Literal

import sqlglot
from pydantic import BaseModel, ConfigDict, Field
from sqlglot import exp


class Query(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)
    grain: Literal["total", "week"]
    start: str | None = None
    end: str | None = None
    rule: str | None = None
    threshold: int | None = Field(default=None, ge=0, le=1000000)


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
    def __init__(self, root: Path, config: dict, engine):
        self.root, self.config, self.engine = root, config, engine
        self.dataset = config["dataset"]
        for name in (self.dataset["model"], self.dataset["date_column"]):
            if not re.fullmatch(r"[A-Za-z_][A-Za-z0-9_]*", name):
                raise ValueError("invalid_dataset")
        self.documents = {}
        self.paths = [root / "wren_project.yml", root / "target/mdl.json"]
        for d in config["metadata"]:
            if set(d) != {"id", "kind", "path"} or d["id"] in self.documents:
                raise ValueError("invalid_metadata")
            if d["kind"] not in (
                "schema.structure",
                "schema.descriptions",
                "mdl.expressions",
                "knowledge.rules",
                "knowledge.sql",
                "data.samples",
                "data.raw",
            ):
                raise ValueError("invalid_metadata")
            path = contained(root, d["path"])
            if path.stat().st_size > 32768 or len(self.documents) >= 32:
                raise ValueError("metadata_limit")
            self.paths.append(path)
            self.documents[d["id"]] = {**d, "content": path.read_text()}
        self.version = self.fingerprint()

    def describe(self, only=None):
        """Host-generated, caller-safe summary of the data: one line per model,
        its business description with every sentence that names an identifier
        (snake_case or dotted) dropped. No columns, types, relationships or
        physical tables. The private model can request it but never rewrite it."""
        manifest = json.loads((self.root / "target/mdl.json").read_text())
        lines = [
            "Data available for analysis (business summary; technical names omitted):"
        ]
        for m in manifest.get("models", []):
            if only is not None and m["name"] not in only:
                continue
            label = m["name"].replace("_", " ")
            raw = ((m.get("properties") or {}).get("description") or "").strip()
            kept = [
                s.strip()
                for s in re.split(r"(?<=[.!?])\s+", raw)
                if s.strip() and not re.search(r"\b\w+(?:_\w+|\.\w+)\b", s)
            ]
            lines.append(f"- {label}: {' '.join(kept)}" if kept else f"- {label}")
        return "\n".join(lines)

    def fingerprint(self):
        digest = hashlib.sha256()
        for path in self.paths:
            data = path.read_bytes()
            digest.update(str(path).encode() + b"\0")
            digest.update(str(len(data)).encode() + b"\0" + data)
        return digest.hexdigest()

    def current(self):
        if self.fingerprint() != self.version:
            raise ValueError("context_changed")

    def plan(self, value, capability):
        q = Query.model_validate(value)
        for day in (q.start, q.end):
            if day and (date.fromisoformat(day).isoformat() != day or len(day) != 10):
                raise ValueError("invalid_date")
        if q.grain == "week" and any(
            day and date.fromisoformat(day).weekday() != 0 for day in (q.start, q.end)
        ):
            raise ValueError("weekly_bounds_must_be_mondays")
        if q.start and q.end and q.start >= q.end:
            raise ValueError("invalid_range")
        if q.rule and q.threshold is not None:
            raise ValueError("ambiguous_rule")
        if (q.rule or q.threshold is not None) and (
            not capability.get("rules") or q.grain != "week"
        ):
            raise PermissionError("denied")
        threshold = q.threshold
        if q.rule:
            rule = self.config["rules"].get(q.rule)
            if not rule:
                raise ValueError("unknown_rule")
            # Trusted structured definition, separate from untrusted prose metadata.
            threshold = rule["minimum"]
            if (
                not isinstance(threshold, int)
                or isinstance(threshold, bool)
                or threshold < 0
            ):
                raise ValueError("invalid_rule")
        model, column = self.dataset["model"], self.dataset["date_column"]
        terms = []
        # Mandatory server scope is intersected, never replaced by a model filter.
        scope = self.config.get("query_scope", {})
        for bound, operator in (
            (scope.get("start"), ">="),
            (scope.get("end"), "<"),
            (q.start, ">="),
            (q.end, "<"),
        ):
            if bound:
                bound = date.fromisoformat(bound).isoformat()
                terms.append(f"\"{column}\" {operator} TIMESTAMP '{bound}'")
        where = " WHERE " + " AND ".join(terms) if terms else ""
        bucket = f"date_trunc('week', \"{column}\")"
        if q.grain == "total":
            sql = f'SELECT COUNT(*) AS order_count FROM "{model}"{where}'
        else:
            sql = f'SELECT {bucket} AS week_start, COUNT(*) AS order_count FROM "{model}"{where} GROUP BY 1 ORDER BY 1'
        return q, sql, threshold

    def query(self, value, capability):
        self.current()
        q, sql, threshold = self.plan(value, capability)
        table = self.engine.query(sql, 101)
        self.current()
        if table.num_rows > 100:
            raise ValueError("result_limit")
        rows = []
        for raw in table.to_pylist():
            row = {
                k: v.isoformat()[:10] if hasattr(v, "isoformat") else v
                for k, v in raw.items()
            }
            if threshold is not None:
                row["met_target"] = row["order_count"] >= threshold
            rows.append(row)
        return {
            "kind": q.grain,
            "rows": rows,
            "timezone": "UTC",
            "week_starts_on": "Monday",
            "scope": self.effective_range(q),
        }, {
            "query": q.model_dump(),
            "sql": sql,
            "rule_version": self.version if q.rule else None,
        }

    def effective_range(self, query: Query):
        """Safe date coverage of the executed plan, including mandatory scope."""
        scope = self.config.get("query_scope", {})
        starts = [
            date.fromisoformat(x).isoformat()
            for x in (scope.get("start"), query.start)
            if x
        ]
        ends = [
            date.fromisoformat(x).isoformat()
            for x in (scope.get("end"), query.end)
            if x
        ]
        return {
            "start": max(starts) if starts else None,
            "end": min(ends) if ends else None,
        }

    def parse_sql(self, sql):
        """Accept exactly the generated analytical subset, not arbitrary SQL."""

        statements = sqlglot.parse(sql, read="duckdb")
        if len(statements) != 1 or not isinstance(statements[0], exp.Select):
            raise PermissionError("unsupported_query")
        tree = statements[0]
        # Compare normalized AST to trusted generated plans. Input is never executed.
        for grain in ("total", "week"):
            query = {"grain": grain}
            _, generated, _ = self.plan(query, {"rules": False})
            if tree == sqlglot.parse_one(generated, read="duckdb"):
                return query
        raise PermissionError("unsupported_query")
