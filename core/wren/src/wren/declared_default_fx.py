"""Single-match and base-currency judgments for ``require_rate_join``, plus rule applicability.

``declared_default_check`` decides whether a statement *joins* a rate on currency and date; it
cannot tell that the rate source yields one row per amount row, nor that rows in the base
currency survive the join. This module adds those two judgments (they only run for a rule that
declares ``match: single`` or ``base_currency``) and reports, per declared rule, whether it
applied and whether the statement satisfied it. The existing decisions are reused as they are,
so a rule without the new keys gets exactly the verdict ``DefaultsChecker.check`` gives.

Violations come back as ``<rule id>`` (an existing decision) or ``<rule id>:<sub>``:

``rate_multi_match``
    ``match: single`` and the rate source is an ordinary join: several rate rows can match one
    amount row. An ``ASOF JOIN``, or a derived source that keeps the latest row per ``ROW_NUMBER()``,
    is single.
``base_currency_dropped``
    the rate model is inner-joined, so amounts in the base currency (which have no rate row)
    vanish from the result.
``rate_default_literal``
    a rate column is defaulted to a literal (``COALESCE(rate, 1)``, ``CASE WHEN rate IS NULL
    THEN 1``) outside a branch that is known to be the base currency, which would turn a
    missing foreign rate into 1.

Like the rest of the checker this reads only the qualified syntax tree: no prose, aliases or
column names as strings.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Iterator

from sqlglot import exp
from sqlglot.optimizer.qualify import qualify

from wren.declared_default_check import (
    DefaultsChecker,
    _conjuncts,
    _Statement,
    _unparen,
)
from wren.declared_defaults import ExcludeRows, RequireRateJoin

RATE_MULTI_MATCH = "rate_multi_match"
BASE_CURRENCY_DROPPED = "base_currency_dropped"
RATE_DEFAULT_LITERAL = "rate_default_literal"
UNGUARDED_LEFT_JOIN = "unguarded_left_join"
GUARDED_BY_BASE_CURRENCY = "guarded_by_base_currency"

_PRESERVING_SIDES = ("LEFT", "FULL")


@dataclass(frozen=True)
class Evaluation:
    """What the declared rules say about one statement.

    ``violations`` are rule ids (``<id>`` or ``<id>:<sub>``); ``checks`` maps every declared rule
    to ``{"applicable": bool, "result": "satisfied" | "not_applicable" | "violated"}`` and is only
    meant to be kept for a statement that passed; ``fx_missing_rate_handling`` records how a
    passing statement treats a missing non-base rate when the rate model is LEFT-joined.
    """

    violations: tuple[str, ...]
    checks: dict
    fx_missing_rate_handling: str | None = None


def evaluate(checker: DefaultsChecker, ast: exp.Expression) -> Evaluation | None:
    """Evaluate every declared rule on ``ast``; ``None`` means no verdict (as ``check``)."""
    if not checker.rules:
        return Evaluation((), {})
    if not isinstance(ast, exp.Query):
        return None
    try:
        qualified = qualify(
            ast.copy(),
            dialect=checker.dialect,
            schema=checker.schema,
            validate_qualify_columns=True,
            identify=False,
        )
        statement = _Statement(qualified, checker)
    except Exception:  # noqa: BLE001 - any parse/qualify failure is "no verdict"
        return None
    try:
        return _evaluate(checker, statement)
    except Exception:  # noqa: BLE001 - a checker fault is "no verdict", never a refusal
        return None


def _evaluate(checker: DefaultsChecker, statement: _Statement) -> Evaluation:
    violations: list[str] = []
    checks: dict = {}
    handling: str | None = None
    for rule in checker.rules:
        if isinstance(rule, ExcludeRows):
            applicable = bool(checker.covered_of(rule) & statement.tables_read) and (
                not rule.aggregated_only or statement.aggregated
            )
            broken = [rule.id] if statement.fires_exclude(rule) else []
        else:
            fx = _Rate(statement, checker, rule)
            applicable = fx.applicable()
            broken = [rule.id] if statement.fires_rate(rule) else []
            if applicable and not broken and not fx.excused():
                found, rule_handling = fx.judge()
                broken = [f"{rule.id}:{sub}" for sub in found]
                if not broken:
                    handling = handling or rule_handling
        violations += broken
        checks[rule.id] = {
            "applicable": applicable,
            "result": "violated"
            if broken
            else "satisfied"
            if applicable
            else "not_applicable",
        }
    return Evaluation(tuple(violations), checks, handling)


def _numeric_literal(node: exp.Expression) -> bool:
    node = _unparen(node)
    if isinstance(node, exp.Neg):
        node = _unparen(node.this)
    return isinstance(node, exp.Literal) and not node.is_string


class _Rate:
    """The new judgments for one ``require_rate_join`` rule on one qualified statement."""

    def __init__(
        self, statement: _Statement, checker: DefaultsChecker, rule: RequireRateJoin
    ) -> None:
        self.st = statement
        self.rule = rule
        norm = checker.norm_pair
        self.model = checker.norm(rule.rate_model)
        self.amounts = {norm(ref) for group in rule.amounts for ref in group.columns}
        self.currencies = {norm(group.currency) for group in rule.amounts}
        self.rate_currency = norm(rule.rate_currency)
        self.rate_date = norm(rule.rate_date)
        keys = {rule.rate_currency.column, rule.rate_date.column}
        self.rate_values = {
            (self.model, checker.norm(column))
            for column in checker.schema.get(rule.rate_model, ())
            if column not in keys
        }
        self.base = rule.base_currency.casefold() if rule.base_currency else None
        self.ctes = {cte.alias: cte.this for cte in statement.ast.find_all(exp.CTE)}

    # -- applicability --------------------------------------------------

    def applicable(self) -> bool:
        if self.rule.aggregated_only and not self.st.aggregated:
            return False
        return any(self.st.taint(a) & self.amounts for a in self.st.aggregates)

    def excused(self) -> bool:
        """The rule's own ``unless`` flags already excuse the statement."""
        if self.rule.groups_by_currency and any(
            self.st.taint(group) & self.currencies
            for group in self.st.ast.find_all(exp.Group)
        ):
            return True
        return bool(
            self.rule.filters_currency_literal
            and self.st._filters_currency_literal(self.currencies)
        )

    # -- where the rate comes from ---------------------------------------

    def _reads(self, node: exp.Expression, seen: frozenset = frozenset()) -> bool:
        for table in node.find_all(exp.Table):
            if table.name == self.model:
                return True
            body = self.ctes.get(table.name)
            if body is not None and table.name not in seen:
                if self._reads(body, seen | {table.name}):
                    return True
        return False

    def _direct(self, node: exp.Expression) -> bool:
        return isinstance(node, exp.Table) and node.name == self.model

    def _attachments(self) -> Iterator[tuple[str, exp.Select, exp.Join | None]]:
        """Each place a select takes the rate model (or a source built on it) into its FROM tree."""
        for select in self.st.ast.find_all(exp.Select):
            source = select.args.get("from_") or select.args.get("from")
            if source is not None and self._reads(source.this):
                yield "from", select, None
            for join in select.args.get("joins") or []:
                if self._reads(join.this):
                    yield "join", select, join

    @staticmethod
    def _preserved(kind: str, select: exp.Select, join: exp.Join | None) -> bool:
        """Whether rows of the other side survive when the rate has no match."""
        if kind == "join":
            return join is not None and join.side in _PRESERVING_SIDES
        return any(j.side in ("RIGHT", "FULL") for j in select.args.get("joins") or [])

    def _kept_by_outer(self, select: exp.Select) -> bool:
        """The select is the body of a derived source that an outer LEFT/FULL join keeps."""
        node: exp.Expression | None = select
        while node is not None:
            if isinstance(node, exp.CTE):
                return any(
                    isinstance(join.this, exp.Table)
                    and join.this.name == node.alias
                    and join.side in _PRESERVING_SIDES
                    for join in self.st.ast.find_all(exp.Join)
                )
            if isinstance(node, exp.Subquery) and isinstance(node.parent, exp.Join):
                return node.parent.side in _PRESERVING_SIDES
            node = node.parent
        return False

    # -- single match -----------------------------------------------------

    def _latest_one(self, select: exp.Select) -> bool:
        """The select keeps only the newest rate row: ``ROW_NUMBER() ... ORDER BY date DESC`` = 1."""
        for window in select.find_all(exp.Window):
            if not isinstance(window.this, exp.RowNumber):
                continue
            if window.find_ancestor(exp.Select) is not select:
                continue
            order = window.args.get("order")
            newest_first = order is not None and any(
                isinstance(item, exp.Ordered)
                and item.args.get("desc")
                and self.st.direct(item.this) == self.rate_date
                for item in order.expressions
            )
            if newest_first and self._limited_to_one(select, window):
                return True
        return False

    def _limited_to_one(self, select: exp.Select, window: exp.Window) -> bool:
        alias = window.parent.alias if isinstance(window.parent, exp.Alias) else None
        clauses = [q.this for q in select.find_all(exp.Qualify)]
        if alias:
            clauses += self.st.roots
        for clause in clauses:
            for node in clause.find_all(exp.EQ, exp.LTE):
                for side, other in (
                    (node.this, node.expression),
                    (node.expression, node.this),
                ):
                    one = (
                        isinstance(other, exp.Literal)
                        and not other.is_string
                        and other.this == "1"
                    )
                    names_it = side == window or (
                        alias is not None
                        and isinstance(side, exp.Column)
                        and side.name == alias
                    )
                    if one and names_it:
                        return True
        return False

    def _single(self, kind: str, select: exp.Select, join: exp.Join | None) -> bool:
        if join is not None and join.args.get("method") == "ASOF":
            return True
        if self._latest_one(select):
            return True
        if join is not None:
            source = join.this
        else:
            source = (select.args.get("from_") or select.args.get("from")).this
        return not self._direct(source) and self._derived_single(source)

    def _derived_single(
        self, node: exp.Expression, seen: frozenset = frozenset()
    ) -> bool:
        for select in node.find_all(exp.Select):
            if self._takes_rate_directly(select) and self._latest_one(select):
                return True
        for table in node.find_all(exp.Table):
            body = self.ctes.get(table.name)
            if body is not None and table.name not in seen:
                if self._derived_single(body, seen | {table.name}):
                    return True
        return False

    def _takes_rate_directly(self, select: exp.Select) -> bool:
        source = select.args.get("from_") or select.args.get("from")
        sources = [source.this] if source is not None else []
        sources += [join.this for join in select.args.get("joins") or []]
        return any(self._direct(s) for s in sources)

    # -- base currency ------------------------------------------------------

    def _base_test(self, condition: exp.Expression) -> str | None:
        """``eq`` / ``neq`` for ``<currency column> = / <> '<base>'`` among the conjuncts."""
        known = self.currencies | {self.rate_currency}
        for conjunct in _conjuncts(condition):
            if not isinstance(conjunct, (exp.EQ, exp.NEQ)):
                continue
            for side, other in (
                (conjunct.this, conjunct.expression),
                (conjunct.expression, conjunct.this),
            ):
                literal = _unparen(other)
                if (
                    self.st.direct(side) in known
                    and isinstance(literal, exp.Literal)
                    and literal.is_string
                    and literal.this.casefold() == self.base
                ):
                    return "eq" if isinstance(conjunct, exp.EQ) else "neq"
        return None

    def _has_base_guard(self) -> bool:
        return any(
            self._base_test(branch.this) is not None
            for branch in self.st.ast.find_all(exp.If)
        )

    def _is_rate(self, node: exp.Expression) -> bool:
        return bool(self.st.taint(node) & self.rate_values)

    def _defaults(self) -> Iterator[exp.Expression]:
        """Nodes that replace a missing rate value with a literal."""
        for node in self.st.ast.find_all(exp.Coalesce, exp.If):
            if isinstance(node, exp.Coalesce):
                args = [node.this, *node.expressions]
                if any(self._is_rate(a) for a in args) and any(
                    _numeric_literal(a) for a in args
                ):
                    yield node
                continue
            condition, taken = _unparen(node.this), node.args.get("true")
            if (
                isinstance(condition, exp.Is)
                and isinstance(condition.expression, exp.Null)
                and self._is_rate(condition.this)
                and taken is not None
                and _numeric_literal(taken)
            ):
                yield node

    def _guarded(self, node: exp.Expression) -> bool:
        """The node sits in a branch that only the base currency can reach."""
        child, parent = node, node.parent
        while parent is not None:
            if isinstance(parent, exp.If):
                if (
                    child is parent.args.get("true")
                    and self._base_test(parent.this) == "eq"
                ):
                    return True
            elif isinstance(parent, exp.Case) and child is parent.args.get("default"):
                if any(
                    self._base_test(branch.this) == "neq"
                    for branch in parent.args.get("ifs") or []
                ):
                    return True
            child, parent = parent, parent.parent
        return False

    # -- verdict --------------------------------------------------------

    def judge(self) -> tuple[list[str], str | None]:
        found: list[str] = []
        attachments = list(self._attachments())
        if self.rule.match == "single" and any(
            not self._single(*a) for a in attachments
        ):
            found.append(RATE_MULTI_MATCH)
        handling = None
        if self.base is not None:
            kept = False
            for kind, select, join in attachments:
                if self._preserved(kind, select, join):
                    kept = True
                elif not self._kept_by_outer(select):
                    if BASE_CURRENCY_DROPPED not in found:
                        found.append(BASE_CURRENCY_DROPPED)
            if any(not self._guarded(node) for node in self._defaults()):
                found.append(RATE_DEFAULT_LITERAL)
            if kept and not found:
                handling = (
                    GUARDED_BY_BASE_CURRENCY
                    if self._has_base_guard()
                    else UNGUARDED_LEFT_JOIN
                )
        return found, handling
