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
  ``query_denied:<sub>``, only ``not_read_only``, ``denied_column``, ``external_source`` or
  ``unknown_model``): the task ends, a rewrite cannot help. A function outside the allowlist
  (``unsupported_function``) and an unexpected planner error (``unsupported``) are form
  errors, not authorization failures;
* failed in the engine (raised by ``execute``): the service counts it separately.

Views are expanded in place before anything else looks at the statement: a view the statement
reads becomes a marked subquery over the models behind it, so the denylist, source tracking
(and with it authorization) and the declared rules see the models the view reads, and the view
itself is exempt only from the rules its definition guarantees.
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
from wren.declared_default_fx import VIEW_MARK, evaluate
from wren.read_only import UnsupportedFunctionError, check_read_only_query


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
        "unsupported_function",
        "unsupported",
        "cube_not_a_table",
    }
)
MAX_JOINS = 4
DUPLICATE_AGGREGATION = "duplicate_aggregation"
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
    unverified: list


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
        catalog = snapshot.catalog
        self.primary_keys = {
            m["name"]: frozenset(m.get("primary_key") or []) for m in models
        }
        self.cube_names = {c["name"].lower() for c in catalog.get("cubes") or []}
        self.cube_measures = {
            member["name"].lower()
            for cube in catalog.get("cubes") or []
            for member in cube.get("measures") or []
        }
        self.model_columns = {
            c.lower() for columns in self.schema.values() for c in columns
        }
        self.semantics = list(catalog.get("semantics") or [])
        self.views, self.broken_views = self._read_views(snapshot, catalog)
        self.checker = DefaultsChecker(
            snapshot.declarations,
            {"models": models},
            "duckdb",
            guarantees={
                v["name"].lower(): v.get("guarantees") or []
                for v in catalog.get("views") or []
                if v.get("guarantees")
            },
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

    def _read_views(self, snapshot, catalog):
        """The views the catalog lists, as parsed bodies over models: ``(usable, broken)``.

        A body that does not parse as one query, or that reads anything but a bound model, is
        broken: a statement that reads it is refused as ``unsupported_source`` rather than run
        through a definition the host could not check.
        """
        statements = {
            v["name"].lower(): v.get("statement")
            for v in ((getattr(snapshot, "manifest", None) or {}).get("views") or [])
            if isinstance(v, dict) and isinstance(v.get("name"), str)
        }
        usable, broken = {}, set()
        for view in catalog.get("views") or []:
            name = view["name"].lower()
            statement = statements.get(name)
            try:
                if not isinstance(statement, str):
                    raise ValueError("no statement")
                body = sqlglot.parse_one(statement, read="duckdb")
                if not isinstance(body, exp.Query):
                    raise ValueError("not a query")
                qualify(
                    body.copy(),
                    dialect="duckdb",
                    schema=self.schema,
                    validate_qualify_columns=True,
                    identify=False,
                )
                if any(
                    t.db or t.catalog or t.name not in self.schema
                    for t in body.find_all(exp.Table)
                ):
                    raise ValueError("reads more than models")
            except Exception:  # noqa: BLE001 - any unreadable view is unusable, never trusted
                broken.add(name)
                continue
            usable[name] = body
        return usable, broken

    def _expand_views(self, tree):
        """Replace every reference to a view by its marked body; return the names read."""
        shadowed = {cte.alias.lower() for cte in tree.find_all(exp.CTE)}
        read = []
        for table in list(tree.find_all(exp.Table)):
            name = table.name.lower()
            if (
                table.db
                or table.catalog
                or not isinstance(table.this, exp.Identifier)
                or table.name in self.schema
                or name in shadowed
                or (name not in self.views and name not in self.broken_views)
            ):
                continue
            if name in self.broken_views or any(
                table.args.get(k) for k in ("pivots", "sample", "version", "hints")
            ):
                raise QueryFormError("unsupported_source")
            alias = table.alias or table.name
            body = exp.Subquery(
                this=self.views[name].copy(),
                alias=exp.TableAlias(this=exp.to_identifier(alias)),
            )
            body.meta[VIEW_MARK] = name
            table.replace(body)
            if name not in read:
                read.append(name)
        return tree, read

    def _reject_cubes(self, tree):
        """A cube is not a table and a measure is not a column: neither can be read by name.

        Cubes answer through the engine's cube query, not through ``FROM <cube>`` or a measure
        summed as if some model held it.
        """
        shadowed = {cte.alias.lower() for cte in tree.find_all(exp.CTE)}
        for table in tree.find_all(exp.Table):
            name = table.name.lower()
            if (
                name in self.cube_names
                and table.name not in self.schema
                and name not in shadowed
            ):
                raise QueryFormError("cube_not_a_table")
        if not self.cube_measures:
            return
        defined = {a.alias.lower() for a in tree.find_all(exp.Alias)}
        for aggregate in tree.find_all(exp.AggFunc):
            for column in aggregate.find_all(exp.Column):
                name = column.name.lower()
                if (
                    name in self.cube_measures
                    and name not in self.model_columns
                    and name not in defined
                ):
                    raise QueryFormError("cube_not_a_table")

    @staticmethod
    def _view_of(expression):
        """The view whose body ``expression`` is (or sits inside), by name."""
        node = expression
        while node is not None:
            name = node.meta.get(VIEW_MARK)
            if name:
                return name
            node = node.parent
        return None

    def _duplicate_aggregation(self, scopes):
        """An aggregate over a view's value in a select that joins the view to a model on a
        column that is not the model's key: each view row can repeat once per matching model
        row, and the aggregate counts it every time."""
        for scope in scopes:
            select = scope.expression
            if not isinstance(select, exp.Select):
                continue
            views = {
                alias
                for alias, source in scope.sources.items()
                if isinstance(source, Scope)
                and isinstance(source.expression.parent, exp.Subquery)
                and source.expression.parent.meta.get(VIEW_MARK)
            }
            if not views:
                continue
            aggregated = {
                column.table
                for aggregate in select.find_all(exp.AggFunc)
                if aggregate.find_ancestor(exp.Select) is select
                for column in aggregate.find_all(exp.Column)
                if column.table in views
            }
            if not aggregated:
                continue
            conditions = [j.args.get("on") for j in select.args.get("joins") or []] + [
                w.this for w in [select.args.get("where")] if w is not None
            ]
            for condition in conditions:
                for node in condition.find_all(exp.EQ) if condition is not None else ():
                    sides = (node.this, node.expression)
                    if not all(isinstance(side, exp.Column) for side in sides):
                        continue
                    for mine, other in (sides, sides[::-1]):
                        source = scope.sources.get(other.table)
                        if (
                            mine.table in aggregated
                            and isinstance(source, exp.Table)
                            and other.name not in self.primary_keys.get(source.name, ())
                        ):
                            return True
        return False

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

    def prepare(self, sql, status_scopes=None):
        """Plan ``sql``. ``status_scopes`` maps a ``sale_statuses`` rule id to the folded status
        set the caller confirmed for it."""
        try:
            tree = sqlglot.parse_one(sql, read="duckdb")
        except sqlglot.errors.SqlglotError:
            raise QueryFormError("invalid_sql") from None
        pending = None
        try:
            check_read_only_query(sql, "duckdb")
        except UnsupportedFunctionError:
            # A form limit, not an authorization failure; but a denied column or an
            # external source in the same statement still ends the task, so planning
            # goes on and this is raised once the denylist has been applied.
            pending = QueryFormError("unsupported_function")
        except Exception:
            raise denied("not_read_only") from None
        try:
            if sum(1 for _ in tree.walk()) > 1000:
                raise ValueError("complexity_limit")
            if any(w.args.get("recursive") for w in tree.find_all(exp.With)):
                raise ValueError("recursive_query")
            if len(list(tree.find_all(exp.Join))) > MAX_JOINS:
                raise ValueError("join_limit")
            for t in tree.find_all(exp.Table):
                if t.db or t.catalog or not isinstance(t.this, exp.Identifier):
                    raise ValueError("external_source")
            self._reject_unsupported_forms(tree)
            tree, views_read = self._expand_views(tree)
            self._reject_cubes(tree)
            if sum(1 for _ in tree.walk()) > 1000:
                raise ValueError("complexity_limit")
            if len(list(tree.find_all(exp.Join))) > MAX_JOINS:
                raise ValueError("join_limit")
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
            if pending is not None:
                raise pending
            sources, physical = {}, []
            for scope in scopes:
                if not isinstance(
                    scope.expression, (exp.Select, exp.Union, exp.Intersect, exp.Except)
                ):
                    raise ValueError("unsupported_source")
                # ``scope.sources``, not ``selected_sources``: a SEMI/ANTI join target that no
                # column references is still a model the statement reads.
                for src in scope.sources.values():
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
                if self._view_of(scope.expression) is None:
                    for projection in scope.expression.selects:
                        self._projection(projection)
            if not physical:
                raise ValueError("no_source")
            verdict = evaluate(self.checker, unqualified, status_scopes)
            if verdict is None:
                raise DeclaredDefaultUndetermined(NO_VERDICT)
            if verdict.violations:
                raise DeclaredDefaultMissing(RULE_VIOLATION, verdict.violations)
            if verdict.undetermined:
                raise DeclaredDefaultUndetermined(NO_VERDICT, verdict.undetermined)
            # COUNT(*) has no Column nodes; its table still receives authorization.
            conditions = {}
            leaves = self._leaves(scopes[-1])
            labels = [self._label(x, leaves[0]) for x in leaves[0].expression.selects]
            if not labels or len(labels) > 20:
                raise ValueError("column_limit")
            # Uniqueness is per select: the branches of a set operation are separate
            # selects, and a column both of them project is not a duplicate.
            for leaf in leaves:
                names = [self._label(x, leaf) for x in leaf.expression.selects]
                if len(set(names)) != len(names):
                    raise QueryShapeError("duplicate_label")
            observed = self._observed(tree, scopes, sources)
            if verdict.fx_missing_rate_handling:
                observed["fx_missing_rate_handling"] = verdict.fx_missing_rate_handling
            unverified = list(verdict.unverified)
            if self._duplicate_aggregation(scopes):
                observed["duplicate_aggregation"] = True
                unverified.append(DUPLICATE_AGGREGATION)
            touched = {name.lower() for name in sources} | set(views_read)
            unverified += [
                entry["id"]
                for entry in self.semantics
                if touched & {m.lower() for m in entry["models"]}
            ]
            # Strip every user/model alias from the public schema. Even a quoted
            # alias containing a private SQL statement must not leave this host.
            return Prepared(
                tree.sql(dialect="duckdb"),
                {k: sorted(v) for k, v in sources.items()},
                conditions,
                labels,
                {rule: dict(c) for rule, c in verdict.checks.items()},
                observed,
                list(dict.fromkeys(unverified)),
            )
        except (QueryFormError, PermissionError):
            # Rewritable rejections, shape errors and denials keep their own class.
            raise
        except ValueError as exc:
            if str(exc) in FORM_CODES:
                raise QueryFormError(str(exc)) from None
            if str(exc) in ("unknown_model", "external_source"):
                raise denied(str(exc)) from None
            raise QueryFormError("unsupported") from None
        except sqlglot.errors.OptimizeError:
            raise QueryFormError("unresolved_column") from None
        except sqlglot.errors.SqlglotError:
            raise QueryFormError("invalid_sql") from None
        except Exception:
            raise QueryFormError("unsupported") from None

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

    @staticmethod
    def _leaves(scope):
        """The plain selects behind a statement, first branch first."""
        if scope.union_scopes:
            return [leaf for u in scope.union_scopes for leaf in AdHocSQL._leaves(u)]
        return [scope]

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
        sql, sources, conditions, labels, checks, observed, unverified = prepared
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
            "unverified": unverified,
        }
