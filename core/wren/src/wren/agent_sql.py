"""Opt-in private SQL execution over configured semantic models.

The model supplies SQL, never policy resources or public labels. Parse and qualify
before authorization; scope every physical relation, including CTEs/self joins.
Only host-produced tables/evidence may leave the private loop.

Every SQL statement, whoever wrote it, goes through ``AdHocSQL.prepare``: read-only,
bounded, denylist, declared default rules. Its failures are of three kinds, each with its
own exception family:

* rejected before execution and rewritable (``QueryFormError``, ``QueryShapeError``,
  ``DeclaredDefaultMissing``, ``DeclaredDefaultUndetermined``): all carry ``error``, ``code``
  and ``rules`` for the worker-visible answer;
* refused by authorization (``QueryDenied``, a ``PermissionError`` named
  ``query_denied:<sub>``): the task ends, a rewrite cannot help;
* failed in the engine (raised by ``execute``): the service counts it separately.
"""

from __future__ import annotations

import json
import math
from datetime import date, datetime
from decimal import Decimal
from typing import NamedTuple

import sqlglot
from pydantic import BaseModel, ConfigDict, Field
from sqlglot import exp
from sqlglot.optimizer.qualify import qualify
from sqlglot.optimizer.scope import Scope, traverse_scope

from wren.declared_default_check import DefaultsChecker
from wren.declared_default_fx import evaluate
from wren.read_only import validate_read_only_query


class QueryShapeError(PermissionError):
    """Rejected output shape; the private worker may try a different safe query."""

    error = "unsupported_result_shape"
    rules: tuple = ()

    @property
    def code(self) -> str:
        return str(self)


class QueryFormError(ValueError):
    """SQL that cannot be planned against the bound models (unknown alias, too many
    joins, correlated reference, parse error); the private worker may rewrite it.
    Authorization failures never take this path."""

    error = "unsupported_query"

    def __init__(self, code: str, rules: tuple = ()):
        super().__init__(code)
        self.code = code
        self.rules = tuple(rules)


class DeclaredDefaultMissing(QueryFormError):
    """The statement breaks declared default rules; ``rules`` names them."""

    error = "declared_default_missing"


class DeclaredDefaultUndetermined(QueryFormError):
    """The checker has no verdict for the statement, so it is not run."""

    error = "declared_default_undetermined"


class QueryDenied(PermissionError):
    """Authorization failure, ``query_denied:<sub>``: the task ends, nothing is rewritten."""


def denied(sub: str) -> QueryDenied:
    return QueryDenied(f"query_denied:{sub}")


FORM_CODES = frozenset(
    {
        "complexity_limit",
        "recursive_query",
        "join_limit",
        "unsupported_source",
        "unresolved_column",
        "no_source",
        "column_limit",
        "column_list_alias",
        "natural_join",
        "positional_reference",
    }
)
RULE_VIOLATION = "rule_violation"
NO_VERDICT = "no_verdict"
OPERATORS = {
    exp.EQ: "=",
    exp.NEQ: "<>",
    exp.GT: ">",
    exp.GTE: ">=",
    exp.LT: "<",
    exp.LTE: "<=",
    exp.In: "in",
    exp.Between: "between",
    exp.Like: "like",
    exp.ILike: "ilike",
    exp.Is: "is",
    exp.NullSafeEQ: "is not distinct from",
    exp.NullSafeNEQ: "is distinct from",
}
NEGATED = {"=": "<>", "<>": "=", "<": ">=", ">=": "<", ">": "<=", "<=": ">"}


class Prepared(NamedTuple):
    """A planned statement: what to run and what the host learned about it."""

    sql: str
    sources: dict
    conditions: dict
    labels: list
    checks: dict
    observed: dict


class PrivateSQL(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)
    sql: str = Field(min_length=1, max_length=16384)


class AdHocSQL:
    """Plans and runs private SQL over the models of the bound Wren project.

    The schema is the loader catalog's (non-hidden columns of every model); the project's
    denied columns resolve like any other column and are refused after qualification, so
    a CTE, a subquery or a ``SELECT *`` expansion cannot carry one through. The project's
    declared default rules are applied to every statement before it can run.
    """

    def __init__(self, project):
        self.project = project
        snapshot = project.snapshot
        models = snapshot.catalog.get("models") or []
        self.schema = {
            m["name"]: {
                c["name"]: c["type"]
                for c in m.get("columns") or []
                if not c.get("is_hidden")
            }
            for m in models
        }
        if not self.schema:
            raise ValueError("invalid_sql_models")
        self.denied = frozenset((m.lower(), c.lower()) for m, c in snapshot.denied)
        self.checker = DefaultsChecker(
            snapshot.declarations, {"models": models}, "duckdb"
        )
        # Literals worth recording are the ones the project itself declares for a column.
        self.enums = {
            (m["name"].lower(), c["name"].lower()): {
                str(v["value"]) for v in c["enum_values"]
            }
            for m in models
            for c in m.get("columns") or []
            if c.get("enum_values")
        }

    @staticmethod
    def _reject_unsupported_forms(tree):
        """Forms that reach a column without naming it; refused before resolution.

        A column-list alias on a table renames its columns by position, ``NATURAL JOIN``
        equates every common column, and ``#N`` is a positional reference: none of them
        can be checked against the denylist the way a named column can.
        """
        for table in tree.find_all(exp.Table):
            alias = table.args.get("alias")
            if alias is not None and alias.args.get("columns"):
                raise QueryFormError("column_list_alias")
        if any(j.args.get("method") == "NATURAL" for j in tree.find_all(exp.Join)):
            raise QueryFormError("natural_join")
        if tree.find(exp.PositionalColumn) is not None:
            raise QueryFormError("positional_reference")

    def prepare(self, sql):
        try:
            tree = sqlglot.parse_one(sql, read="duckdb")
        except sqlglot.errors.SqlglotError:
            raise QueryFormError("invalid_sql") from None
        try:
            validate_read_only_query(sql, "duckdb")
        except Exception:
            raise denied("not_read_only") from None
        try:
            if sum(1 for _ in tree.walk()) > 1000:
                raise ValueError("complexity_limit")
            if any(w.args.get("recursive") for w in tree.find_all(exp.With)):
                raise ValueError("recursive_query")
            if len(list(tree.find_all(exp.Join))) > 4:
                raise ValueError("join_limit")
            for t in tree.find_all(exp.Table):
                if t.db or t.catalog or not isinstance(t.this, exp.Identifier):
                    raise ValueError("external_source")
            self._reject_unsupported_forms(tree)
            unqualified = tree.copy()
            tree = qualify(
                tree,
                dialect="duckdb",
                schema=self.schema,
                validate_qualify_columns=True,
                identify=True,
            )
            scopes = list(traverse_scope(tree))
            # Denial outranks every planning failure: a query that names a denied column is
            # an authorization failure even when it is also malformed.
            for scope in scopes:
                for col in scope.columns:
                    src = scope.sources.get(col.table)
                    if (
                        isinstance(src, exp.Table)
                        and (
                            src.name.lower(),
                            col.name.lower(),
                        )
                        in self.denied
                    ):
                        raise denied("denied_column")
            sources, physical = {}, []
            for scope in scopes:
                if not isinstance(
                    scope.expression, (exp.Select, exp.Union, exp.Intersect, exp.Except)
                ):
                    raise ValueError("unsupported_source")
                for alias, (_, src) in scope.selected_sources.items():
                    if isinstance(src, exp.Table):
                        if src.name not in self.schema:
                            raise ValueError("unknown_model")
                        sources.setdefault(src.name, set())
                        physical.append(src)
                for col in scope.columns:
                    src = scope.sources.get(col.table)
                    if isinstance(src, exp.Table):
                        sources[src.name].add(col.name)
                    elif not isinstance(src, Scope):
                        # Correlated references and ambiguous scope are not inferred.
                        raise ValueError("unresolved_column")
                for projection in scope.expression.selects:
                    self._projection(projection)
            if not physical:
                raise ValueError("no_source")
            verdict = evaluate(self.checker, unqualified)
            if verdict is None:
                raise DeclaredDefaultUndetermined(NO_VERDICT)
            if verdict.violations:
                raise DeclaredDefaultMissing(RULE_VIOLATION, verdict.violations)
            # COUNT(*) has no Column nodes; its table still receives authorization.
            conditions = {}
            labels = [self._label(x, scopes[-1]) for x in scopes[-1].expression.selects]
            if not labels or len(labels) > 20:
                raise ValueError("column_limit")
            if len(set(labels)) != len(labels):
                raise QueryShapeError("duplicate_label")
            observed = self._observed(tree, scopes, sources)
            if verdict.fx_missing_rate_handling:
                observed["fx_missing_rate_handling"] = verdict.fx_missing_rate_handling
            # Strip every user/model alias from the public schema. Even a quoted
            # alias containing a private SQL statement must not leave this host.
            return Prepared(
                tree.sql(dialect="duckdb"),
                {k: sorted(v) for k, v in sources.items()},
                conditions,
                labels,
                {
                    rule: {"applicable": c["applicable"], "result": c["result"]}
                    for rule, c in verdict.checks.items()
                },
                observed,
            )
        except (QueryFormError, PermissionError):
            # Rewritable rejections, shape errors and denials keep their own class.
            raise
        except ValueError as exc:
            if str(exc) in FORM_CODES:
                raise QueryFormError(str(exc)) from None
            if str(exc) in ("unknown_model", "external_source"):
                raise denied(str(exc)) from None
            raise denied("unsupported") from None
        except sqlglot.errors.OptimizeError:
            raise QueryFormError("unresolved_column") from None
        except sqlglot.errors.SqlglotError:
            raise QueryFormError("invalid_sql") from None
        except Exception:
            raise denied("unsupported") from None

    def _observed(self, tree, scopes, sources):
        """Facts read from the qualified statement: what it touched, never what it says."""
        joins, filters, literals = [], [], {}
        for scope in scopes:
            select = scope.expression
            if not isinstance(select, exp.Select):
                continue
            first = select.args.get("from_") or select.args.get("from")
            anchor = self._model_of(scope, first.this) if first is not None else None
            for join in select.args.get("joins") or []:
                right = self._model_of(scope, join.this)
                if right is None:
                    continue
                on = join.args.get("on")
                others = {
                    src.name
                    for col in (on.find_all(exp.Column) if on is not None else ())
                    if isinstance(src := scope.sources.get(col.table), exp.Table)
                } - {right}
                for other in sorted(others) or ([anchor] if anchor else [right]):
                    pair = sorted([right, other])
                    if pair not in joins:
                        joins.append(pair)
            for clause in (
                select.args.get("where"),
                select.args.get("having"),
                select.args.get("qualify"),
            ):
                if clause is not None:
                    self._filters(scope, clause.this, False, filters, literals)
        return {
            "models": sorted(sources),
            "columns": {m: sorted(c) for m, c in sorted(sources.items())},
            "joins": joins,
            "aggregated": tree.find(exp.AggFunc) is not None
            or tree.find(exp.Group) is not None,
            "filters": filters,
            "status_literals": {k: sorted(v) for k, v in sorted(literals.items())},
        }

    @staticmethod
    def _model_of(scope, node):
        if isinstance(node, exp.Table):
            source = scope.sources.get(node.alias_or_name)
            return source.name if isinstance(source, exp.Table) else None
        return None

    def _filters(self, scope, node, negated, filters, literals):
        while isinstance(node, exp.Paren):
            node = node.this
        if isinstance(node, (exp.And, exp.Or)):
            for side in (node.this, node.expression):
                self._filters(scope, side, negated, filters, literals)
            return
        if isinstance(node, exp.Not):
            self._filters(scope, node.this, not negated, filters, literals)
            return
        if isinstance(node, exp.Column):
            # A bare boolean column: ``WHERE flag`` / ``WHERE NOT flag``.
            operator, operands = ("is false" if negated else "is true"), (node,)
        else:
            operator = OPERATORS.get(type(node))
            if operator is None:
                return
            if negated:
                operator = NEGATED.get(operator) or f"not {operator}"
            operands = (node.this, node.args.get("expression"))
        for side in operands:
            if not isinstance(side, exp.Column):
                continue
            base = self._base_column(scope, side)
            if base is None:
                continue
            entry = {"column": f"{base[0]}.{base[1]}", "operator": operator}
            if entry not in filters:
                filters.append(entry)
            allowed = self.enums.get((base[0].lower(), base[1].lower()))
            if allowed and isinstance(node, (exp.EQ, exp.NEQ, exp.In)):
                values = [
                    node.args.get("expression"),
                    *(node.args.get("expressions") or []),
                ]
                found = {
                    v.this
                    for v in values
                    if isinstance(v, exp.Literal) and v.is_string and v.this in allowed
                }
                if found:
                    literals.setdefault(entry["column"], set()).update(found)

    def _base_column(self, scope, column, depth=0):
        """The ``(model, column)`` a reference reads, followed through derived tables."""
        source = scope.sources.get(column.table)
        if isinstance(source, exp.Table):
            return source.name, column.name
        if isinstance(source, Scope) and depth < 8:
            for child in source.expression.selects:
                if child.alias_or_name == column.name:
                    inner = child.unalias()
                    if isinstance(inner, exp.Column):
                        return self._base_column(source, inner, depth + 1)
        return None

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
        sql, sources, conditions, labels, checks, observed = prepared
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
        return result, {
            "sql": sql,
            "sources": sources,
            "checks": checks,
            "observed": observed,
        }
