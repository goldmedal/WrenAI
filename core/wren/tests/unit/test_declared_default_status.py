"""What a statement's filters keep of a status column, computed over the column's whole domain."""

from pathlib import Path

import pytest
from sqlglot import parse_one
from sqlglot.optimizer.qualify import qualify

from wren.context import build_json
from wren.declared_default_check import DefaultsChecker, _Statement
from wren.declared_default_status import (
    StatusUndetermined,
    _Status,
    display,
    fold_all,
    judge,
)
from wren.declared_defaults import ColumnRef, SaleStatuses

pytestmark = pytest.mark.unit

FIXTURE = Path(__file__).resolve().parent.parent / "fixtures" / "declared_defaults"
DOMAIN = ("paid", "shipped", "cancelled", "pending")
RULE = SaleStatuses(
    id="paid-and-shipped",
    column=ColumnRef("orders", "status"),
    values=("paid", "shipped"),
    domain=DOMAIN,
    overridable_by_caller=False,
    aggregated_only=False,
)
CHECKER = DefaultsChecker([RULE], build_json(FIXTURE), "duckdb")


def statement(sql: str) -> _Statement:
    tree = qualify(
        parse_one(sql, dialect="duckdb"),
        dialect="duckdb",
        schema=CHECKER.schema,
        validate_qualify_columns=True,
        identify=False,
    )
    return _Statement(tree, CHECKER)


def outcome(sql: str, target=None, rule: SaleStatuses = RULE) -> str:
    folded = None if target is None else fold_all(target)
    return judge(statement(sql), CHECKER, rule, folded).outcome


def retained(sql: str) -> list[list[str]]:
    status = _Status(statement(sql), CHECKER, RULE, frozenset())
    return [display(RULE, kept) for kept in status.retained().values()]


def count(where: str) -> str:
    return f"SELECT COUNT(*) FROM orders WHERE {where}"


EQUAL = [
    "status IN ('paid', 'shipped')",
    "status = 'paid' OR status = 'shipped'",
    "status NOT IN ('cancelled', 'pending')",
    "NOT status IN ('cancelled', 'pending')",
    "NOT (status = 'cancelled' OR status = 'pending')",
    "status <> 'cancelled' AND status <> 'pending'",
    "status != 'cancelled' AND status != 'pending'",
    "lower(status) IN ('paid', 'shipped')",
    "LOWER(status) NOT IN ('cancelled', 'pending')",
    "UPPER(status) IN ('PAID', 'SHIPPED')",
    "UPPER(TRIM(status)) IN ('PAID', 'SHIPPED')",
    "status IN ('Paid', 'SHIPPED')",
    "status IN ('paid', 'shipped', 'refunded')",
    "status IN ('paid', 'shipped') AND order_total > 5",
    "order_total > 5 AND status IN ('paid', 'shipped')",
    "status IN ('paid', 'shipped', 'cancelled') AND status <> 'cancelled'",
    "(status = 'paid' OR status = 'shipped') AND NOT (status = 'pending')",
    "status IS NOT NULL AND status IN ('paid', 'shipped')",
    "(status = 'paid' AND order_total > 5) OR status = 'shipped'",
]


@pytest.mark.parametrize("where", EQUAL)
def test_a_filter_that_keeps_exactly_the_declared_set_is_satisfied(where):
    assert outcome(count(where)) == "satisfied"


def test_not_in_is_computed_over_the_domain_not_compared_as_a_literal_list():
    assert retained(count("status NOT IN ('cancelled', 'pending')")) == [
        ["paid", "shipped"]
    ]
    assert retained(count("status NOT IN ('cancelled')")) == [
        ["paid", "shipped", "pending"]
    ]
    assert retained(count("status <> 'paid'")) == [["shipped", "cancelled", "pending"]]


SUBSET = [
    "status = 'paid'",
    "status IN ('paid')",
    "status NOT IN ('cancelled', 'pending', 'shipped')",
    "lower(status) = 'shipped'",
    "status IN ('paid', 'shipped') AND status <> 'paid'",
    "status = 'paid' AND order_total > 5",
    "status IN ('paid', 'refunded')",
    "status IS NULL",
    "status = 'refunded'",
]


@pytest.mark.parametrize("where", SUBSET)
def test_a_proper_subset_is_a_violation(where):
    assert outcome(count(where)) == "subset"


SUPERSET = [
    "status NOT IN ('cancelled')",
    "status <> 'cancelled'",
    "status IN ('paid', 'shipped', 'pending')",
    "status IS NOT NULL",
    "status = 'paid' OR order_total > 5",
    "status IN ('paid', 'shipped') OR order_total > 5",
    "NOT (status = 'cancelled' AND order_total > 5)",
    "status IN ('paid', 'pending')",
    "NOT (status = 'cancelled' AND status = 'pending')",
]


@pytest.mark.parametrize("where", SUPERSET)
def test_a_superset_or_one_that_also_keeps_a_value_it_should_not_is_a_violation(where):
    assert outcome(count(where)) == "superset"


def test_no_status_predicate_at_all_is_missing():
    assert outcome("SELECT COUNT(*) FROM orders") == "missing"
    assert outcome(count("order_total > 5")) == "missing"
    assert outcome("SELECT status, COUNT(*) FROM orders GROUP BY status") == "missing"


@pytest.mark.parametrize(
    "where",
    [
        "status = currency",
        "status = lower(currency)",
        "status IN (SELECT currency FROM orders)",
        "status IN (currency, 'paid')",
        "status LIKE 'p%'",
        "status > 'a'",
        "status BETWEEN 'a' AND 'z'",
        "substr(status, 1, 3) = 'pai'",
        "concat(status, 'x') = 'paidx'",
        "CASE WHEN status = 'paid' THEN 1 ELSE 0 END = 1",
        "status = ANY(['paid'])",
        "status IS NOT DISTINCT FROM 'paid'",
        "status = NULL",
        "TRIM(status, 'x') = 'paid'",
        "CAST(status AS VARCHAR) = 'paid'",
    ],
)
def test_a_predicate_the_module_does_not_evaluate_has_no_verdict(where):
    with pytest.raises(StatusUndetermined):
        outcome(count(where))


def test_a_status_derived_in_a_subquery_has_no_verdict():
    sql = (
        "WITH t AS (SELECT lower(status) AS s, order_total FROM orders) "
        "SELECT COUNT(*) FROM t WHERE s IN ('paid', 'shipped')"
    )
    with pytest.raises(StatusUndetermined):
        outcome(sql)


def test_a_status_passed_through_a_cte_or_derived_table_is_followed():
    assert (
        outcome(
            "WITH t AS (SELECT status, order_total FROM orders) "
            "SELECT COUNT(*) FROM t WHERE status IN ('paid', 'shipped')"
        )
        == "satisfied"
    )
    assert (
        outcome(
            "SELECT COUNT(*) FROM (SELECT status AS s FROM orders) t WHERE t.s = 'paid'"
        )
        == "subset"
    )
    assert (
        outcome(
            "WITH t AS (SELECT * FROM orders WHERE status IN ('paid', 'shipped')) "
            "SELECT COUNT(*) FROM t"
        )
        == "satisfied"
    )


def test_each_branch_of_a_union_is_judged_on_its_own_read():
    branch = "SELECT id FROM orders WHERE status IN ('paid', 'shipped')"
    assert (
        outcome(f"SELECT COUNT(*) FROM ({branch} UNION ALL {branch}) t") == "satisfied"
    )
    two_halves = (
        "SELECT id FROM orders WHERE status = 'paid' UNION ALL "
        "SELECT id FROM orders WHERE status = 'shipped'"
    )
    assert outcome(f"SELECT COUNT(*) FROM ({two_halves}) t") == "subset"
    unfiltered = f"{branch} UNION ALL SELECT id FROM orders"
    assert outcome(f"SELECT COUNT(*) FROM ({unfiltered}) t") == "missing"


def test_a_filter_on_a_union_column_applies_to_every_branch_it_comes_from():
    sql = (
        "WITH u AS (SELECT status FROM orders UNION ALL SELECT status FROM orders) "
        "SELECT COUNT(*) FROM u WHERE status IN ('paid', 'shipped')"
    )
    assert outcome(sql) == "satisfied"


def test_every_read_of_the_model_needs_its_own_filter():
    both = (
        "SELECT COUNT(*) FROM orders a JOIN orders b ON a.customer_id = b.customer_id "
        "WHERE a.status IN ('paid', 'shipped') AND b.status IN ('paid', 'shipped')"
    )
    assert outcome(both) == "satisfied"
    one = both.replace(" AND b.status IN ('paid', 'shipped')", "")
    assert outcome(one) == "missing"
    mixed = both.replace("b.status IN ('paid', 'shipped')", "b.status = 'paid'")
    assert outcome(mixed) == "subset"
    crossed = (
        "SELECT COUNT(*) FROM orders a JOIN orders b ON a.customer_id = b.customer_id "
        "WHERE a.status = 'paid' OR b.status = 'shipped'"
    )
    with pytest.raises(StatusUndetermined):
        outcome(crossed)


def test_a_subquery_over_the_model_is_a_read_of_its_own():
    inner_unfiltered = (
        "SELECT COUNT(*) FROM orders WHERE status IN ('paid', 'shipped') "
        "AND customer_id IN (SELECT customer_id FROM orders)"
    )
    assert outcome(inner_unfiltered) == "missing"
    both = inner_unfiltered.replace(
        "FROM orders)", "FROM orders WHERE status IN ('paid', 'shipped'))"
    )
    assert outcome(both) == "satisfied"


def test_a_filter_in_a_join_condition_counts_like_one_in_where():
    sql = (
        "SELECT COUNT(*) FROM customers c JOIN orders o ON o.customer_id = c.id "
        "AND o.status IN ('paid', 'shipped')"
    )
    assert outcome(sql) == "satisfied"


def test_a_statement_that_does_not_read_the_model_is_not_applicable():
    assert outcome("SELECT COUNT(*) FROM customers") == "not_applicable"


def test_when_aggregated_a_plain_listing_is_not_applicable():
    rule = SaleStatuses(**{**RULE.__dict__, "aggregated_only": True})
    assert outcome("SELECT id FROM orders", rule=rule) == "not_applicable"
    assert outcome("SELECT COUNT(*) FROM orders", rule=rule) == "missing"


def test_the_target_can_be_a_set_the_caller_confirmed():
    assert outcome(count("status = 'paid'"), target=["paid"]) == "satisfied"
    assert (
        outcome(count("status IN ('paid', 'shipped')"), target=["paid"]) == "superset"
    )
    assert outcome(count("status = 'paid'"), target=["paid", "shipped"]) == "subset"
    assert outcome(count("status = 'PAID'"), target=["Paid"]) == "satisfied"


def test_comparison_ignores_case_in_the_domain_and_the_declaration():
    rule = SaleStatuses(
        **{
            **RULE.__dict__,
            "values": ("Paid", "SHIPPED"),
            "domain": ("PAID", "Shipped", "Cancelled", "pending"),
        }
    )
    checker = DefaultsChecker([rule], build_json(FIXTURE), "duckdb")
    tree = qualify(
        parse_one(count("lower(status) IN ('paid', 'shipped')"), dialect="duckdb"),
        dialect="duckdb",
        schema=checker.schema,
        validate_qualify_columns=True,
        identify=False,
    )
    assert judge(_Statement(tree, checker), checker, rule).outcome == "satisfied"


def test_display_uses_the_declared_case_in_domain_order():
    assert display(RULE, fold_all(["SHIPPED", "paid"])) == ["paid", "shipped"]


def test_the_checker_reports_a_violated_status_rule_and_no_verdict_for_an_unreadable_one():
    ok = parse_one(count("status IN ('paid', 'shipped')"), dialect="duckdb")
    assert CHECKER.check(ok) == []
    bad = parse_one(count("status = 'paid'"), dialect="duckdb")
    assert CHECKER.check(bad) == ["paid-and-shipped"]
    unreadable = parse_one(count("status = currency"), dialect="duckdb")
    assert CHECKER.check(unreadable) is None
