"""Opt-in private SQL execution over configured semantic models.

The model supplies SQL, never policy resources or public labels. Parse and qualify
before authorization; scope every physical relation, including CTEs/self joins.
Only host-produced tables/evidence may leave the private loop.
"""

from __future__ import annotations

import json
import math
import re
from datetime import date, datetime
from decimal import Decimal

import sqlglot
from pydantic import BaseModel, ConfigDict, Field
from sqlglot import exp
from sqlglot.optimizer.qualify import qualify
from sqlglot.optimizer.scope import Scope, traverse_scope

from wren.read_only import validate_read_only_query


class QueryShapeError(PermissionError):
    """Rejected output shape; the private worker may try a different safe query."""


class PrivateSQL(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)
    sql: str = Field(min_length=1, max_length=16384)


class AdHocSQL:
    def __init__(self, project):
        self.project = project
        self.models = project.config["adhoc"]["models"]
        manifest = json.loads((project.root / "target/mdl.json").read_text())
        self.schema = {
            m["name"]: {c["name"]: c["type"] for c in m["columns"]}
            for m in manifest["models"]
        }
        if not self.models or not set(self.models) <= set(self.schema):
            raise ValueError("invalid_sql_models")
        for name, model in self.models.items():
            cols = model["columns"]
            if (
                not cols
                or len(cols) != len(set(cols))
                or not set(cols) <= set(self.schema[name])
                or any(not re.fullmatch(r"[a-z][a-z0-9_]*", c) for c in [name, *cols])
            ):
                raise ValueError("invalid_sql_columns")
            if model.get("date_column") not in [None, *cols]:
                raise ValueError("invalid_scope_column")
        self.schema = {k: self.schema[k] for k in self.models}

    def prepare(self, sql):
        try:
            validate_read_only_query(sql, "duckdb")
            tree = sqlglot.parse_one(sql, read="duckdb")
            if sum(1 for _ in tree.walk()) > 1000:
                raise ValueError("complexity_limit")
            if any(w.args.get("recursive") for w in tree.find_all(exp.With)):
                raise ValueError("recursive_query")
            if len(list(tree.find_all(exp.Join))) > 4:
                raise ValueError("join_limit")
            for t in tree.find_all(exp.Table):
                if t.db or t.catalog or not isinstance(t.this, exp.Identifier):
                    raise ValueError("external_source")
            tree = qualify(
                tree,
                dialect="duckdb",
                schema=self.schema,
                validate_qualify_columns=True,
                identify=True,
            )
            scopes = list(traverse_scope(tree))
            sources, physical = {}, []
            for scope in scopes:
                if not isinstance(
                    scope.expression, (exp.Select, exp.Union, exp.Intersect, exp.Except)
                ):
                    raise ValueError("unsupported_source")
                for alias, (_, src) in scope.selected_sources.items():
                    if isinstance(src, exp.Table):
                        if src.name not in self.models:
                            raise ValueError("unknown_model")
                        sources.setdefault(src.name, set())
                        physical.append(src)
                for col in scope.columns:
                    src = scope.sources.get(col.table)
                    if isinstance(src, exp.Table):
                        if col.name not in self.models[src.name]["columns"]:
                            raise ValueError("column_denied")
                        sources[src.name].add(col.name)
                    elif not isinstance(src, Scope):
                        # Correlated references and ambiguous scope are not inferred.
                        raise ValueError("unresolved_column")
                for projection in scope.expression.selects:
                    self._projection(projection)
            if not physical:
                raise ValueError("no_source")
            # COUNT(*) has no Column nodes; its table still receives authorization.
            conditions = {}
            deployment = self.project.config.get("query_scope", {})
            for table in physical:
                cfg = self.models[table.name]
                column = cfg.get("date_column")
                if column and deployment:
                    terms = []
                    for bound, op in (("start", exp.GTE), ("end", exp.LT)):
                        if deployment.get(bound):
                            value = date.fromisoformat(deployment[bound]).isoformat()
                            terms.append(
                                op(
                                    this=exp.column(column),
                                    expression=exp.Cast(
                                        this=exp.Literal.string(value),
                                        to=exp.DataType.build("TIMESTAMP"),
                                    ),
                                )
                            )
                    if terms:
                        sources[table.name].add(column)
                        conditions[table.name] = {
                            k: deployment.get(k) for k in ("start", "end")
                        }
                        # Replace each physical occurrence, not the outer WHERE: OR,
                        # subqueries and joins cannot escape the mandatory scope.
                        scoped = (
                            exp.select("*")
                            .from_(exp.to_table(table.name))
                            .where(*terms)
                        )
                        table.replace(scoped.subquery(alias=table.alias_or_name))
            labels = [self._label(x, scopes[-1]) for x in scopes[-1].expression.selects]
            if not labels or len(labels) > 20:
                raise ValueError("column_limit")
            # Strip every user/model alias from the public schema. Even a quoted
            # alias containing a private SQL statement must not leave this host.
            return (
                tree.sql(dialect="duckdb"),
                {k: sorted(v) for k, v in sources.items()},
                conditions,
                labels,
            )
        except QueryShapeError:
            raise
        except Exception:
            raise PermissionError("unsupported_query") from None

    @staticmethod
    def _projection(expr):
        # Arbitrary strings from instructions/metadata cannot be echoed as cells.
        # Predicates can contain string filters; date units are a closed vocabulary.
        for lit in expr.find_all(exp.Literal):
            if not lit.is_string:
                continue
            parent = lit.parent
            permitted = False
            while parent is not None and parent is not expr:
                if isinstance(parent, (exp.Predicate, exp.Where)):
                    permitted = True
                    break
                if isinstance(parent, (exp.DateTrunc, exp.TimestampTrunc)):
                    permitted = lit.this.lower() in {
                        "day",
                        "week",
                        "month",
                        "quarter",
                        "year",
                        "hour",
                    }
                    break
                parent = parent.parent
            if not permitted:
                raise QueryShapeError("literal_disclosure")
        value = expr.unalias()
        if not list(value.find_all(exp.Column)) and not list(
            value.find_all(exp.AggFunc)
        ):
            raise QueryShapeError("unbacked_result")
        # Text-producing transforms can synthesize instruction/SQL strings from
        # numeric constants or fragments. Keep textual outputs as source columns.
        blocked = {
            "concat",
            "concatws",
            "replace",
            "substring",
            "timetostr",
            "strtodate",
            "strtotime",
        }
        if any(n.key in blocked for n in value.walk()):
            raise QueryShapeError("text_synthesis")
        for cast in value.find_all(exp.Cast):
            if cast.to.this in {
                exp.DataType.Type.TEXT,
                exp.DataType.Type.VARCHAR,
                exp.DataType.Type.CHAR,
            }:
                raise QueryShapeError("text_cast")

    def _label(self, expr, scope, depth=0):
        if depth > 8:
            return "value"
        expr = expr.unalias()
        if isinstance(expr, exp.Column):
            source = scope.sources.get(expr.table)
            if isinstance(source, exp.Table):
                # Comes from validated, operator-configured model column names.
                return expr.name
            if isinstance(source, Scope):
                for child in source.expression.selects:
                    if child.alias_or_name == expr.name:
                        return self._label(child, source, depth + 1)
            return "value"
        if isinstance(expr, exp.Star):
            return "rows"
        cols = [self._label(c, scope, depth + 1) for c in expr.find_all(exp.Column)]
        operation = {
            "timestamptrunc": "period",
            "datetrunc": "period",
            "count": "count",
        }.get(expr.key, expr.key)
        # Expression class names are parser constants; aliases/literals are omitted.
        return "_".join([operation, *dict.fromkeys(cols)])[:96]

    def execute(self, prepared):
        sql, sources, conditions, labels = prepared
        table = self.project.engine.query(sql, 101, read_only=True)
        self.project.current()
        if table.num_rows > 100 or len(table.columns) != len(labels):
            raise ValueError("result_limit")
        rows = []
        for raw in zip(*(c.to_pylist() for c in table.columns)):
            row = {}
            for i, v in enumerate(raw):
                if isinstance(v, (date, datetime)):
                    v = v.isoformat()
                elif isinstance(v, Decimal):
                    v = float(v)
                if v is not None and not isinstance(v, (str, int, float, bool)):
                    raise ValueError("unsupported_result")
                if isinstance(v, str) and len(v) > 256:
                    raise ValueError("result_limit")
                if isinstance(v, float) and not math.isfinite(v):
                    raise ValueError("unsupported_result")
                row[f"c{i + 1}"] = v
            rows.append(row)
        result = {
            "kind": "table",
            "columns": [
                {"key": f"c{i + 1}", "label": label} for i, label in enumerate(labels)
            ],
            "rows": rows,
            "mandatory_scope": conditions,
            "timezone": "UTC",
        }
        if len(json.dumps(result).encode()) > 32768:
            raise ValueError("result_limit")
        return result, {"sql": sql, "sources": sources}
