"""Real synthetic queries and Cedar decisions; only private model calls are stubbed."""

import asyncio
import importlib.util
import json
import os
from pathlib import Path

import pytest

pytest.importorskip("mcp")
from wren.agent_service import Ask, Ref, build_mcp, create_service  # noqa: E402
from wren.agent_sql import QueryFormError, QueryShapeError  # noqa: E402


@pytest.fixture
def adhoc(tmp_path):
    runtime, compiler = os.getenv("WARBLE_SERVICE"), os.getenv("WARBLE_BIN")
    if not runtime or not compiler:
        pytest.skip("Set WARBLE_SERVICE and WARBLE_BIN")
    examples = Path(__file__).resolve().parents[4] / "examples/serve-agent"
    spec = importlib.util.spec_from_file_location("adhoc_setup", examples / "setup.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    services = []

    def make(policy=""):
        dest = tmp_path / f"fixture{len(services)}"
        module.prepare_adhoc(dest)
        root = dest / "project"
        with (root / "policy.cedar").open("a") as f:
            f.write(policy)
        s = create_service(
            root,
            examples / "profiles/adhoc",
            root / "service.yml",
            Path(runtime),
            compiler,
        )
        services.append(s)
        original = s.ipc.call
        s.test_sql = "SELECT SUM(amount) FROM orders WHERE NOT is_test"

        def call(op, **kwargs):
            if op == "invoke":
                cb = kwargs["callback"]
                cb("__delegate", {"component": "data_worker"})
                cb("list_context", {})
                cb("read_context", {"ids": ["orders", "customers"]})
                result = cb("run_sql", {"sql": s.test_sql})
                return (
                    {"evidence": result["evidence"]} if "evidence" in result else result
                )
            return original(op, **kwargs)

        s.ipc.call = call
        return s

    yield make
    for s in services:
        s.shutdown()


def ask(s, sql, session=None, revision=0, reply=None, request_id="one"):
    s.test_sql = sql
    return s.execute(
        Ask(
            session_id=session or s.open()["session_id"],
            request_id=request_id,
            expected_revision=revision,
            capability="analytics",
            question="analyze data",
            reply_to=reply,
        )
    )


@pytest.mark.parametrize(
    ("sql", "rows"),
    [
        (
            "SELECT SUM(amount), AVG(amount), COUNT(*) FROM orders WHERE NOT is_test",
            [{"c1": 780.0, "c2": 65.0, "c3": 12}],
        ),
        (
            "SELECT c.region, SUM(o.amount) revenue FROM orders o JOIN customers c ON o.customer_id=c.id WHERE NOT o.is_test GROUP BY c.region ORDER BY revenue DESC",
            [
                {"c1": "East", "c2": 300.0},
                {"c1": "South", "c2": 260.0},
                {"c1": "North", "c2": 220.0},
            ],
        ),
        (
            "WITH totals AS (SELECT customer_id, SUM(amount) AS revenue FROM orders WHERE NOT is_test GROUP BY customer_id) SELECT c.region, t.revenue FROM totals t JOIN customers c ON t.customer_id=c.id ORDER BY t.revenue DESC LIMIT 2",
            [{"c1": "East", "c2": 300.0}, {"c1": "South", "c2": 260.0}],
        ),
        (
            "SELECT SUM(CASE WHEN amount >= 50 THEN amount ELSE 0 END) FROM orders WHERE NOT is_test",
            [{"c1": 680.0}],
        ),
        (
            "SELECT COUNT(*) FROM orders o JOIN customers c ON o.customer_id=c.id WHERE c.region='North' AND NOT o.is_test",
            [{"c1": 4}],
        ),
    ],
)
def test_actual_adhoc_queries(adhoc, sql, rows):
    result = ask(adhoc(), sql)
    assert result["status"] == "completed"
    assert result["result"]["rows"] == rows


@pytest.mark.parametrize(
    "sql",
    [
        "DELETE FROM orders",
        "DROP TABLE orders",
        "UPDATE orders SET amount=0",
        "CREATE TABLE stolen AS SELECT * FROM orders",
        "COPY orders TO '/tmp/stolen.csv'",
        "SELECT * INTO stolen FROM orders",
        "SELECT * FROM orders; SELECT 1",
        "SELECT * FROM read_csv('/etc/passwd')",
        "SELECT * FROM read_parquet('https://example.com/x')",
        "SELECT * FROM synthetic.main.raw_orders",
        "SELECT * FROM information_schema.tables",
        "SELECT * FROM customers",
        "SELECT email FROM customers",
        "SELECT COUNT(*) FROM customers WHERE email LIKE '%@%'",
        "SELECT COUNT(*) FROM customers ORDER BY MIN(email)",
        "WITH a AS (SELECT email FROM customers) SELECT COUNT(*) FROM a",
        "SELECT 1",
        "SELECT 'PRIVATE_SQL' FROM orders",
        "SELECT MIN('PRIVATE_SQL') FROM orders",
        "SELECT CASE WHEN amount>0 THEN 'PRIVATE_RULE' ELSE 'ok' END FROM orders",
        "WITH x AS (SELECT 'PRIVATE_SQL' AS value FROM orders) SELECT value FROM x",
        "SELECT x.a FROM orders, (VALUES ('PRIVATE_SQL')) AS x(a)",
        "SELECT CONCAT('PRIVATE_', 'SQL', region) FROM customers",
        "SELECT CAST(amount AS VARCHAR) FROM orders",
        "SELECT CHR(83) FROM orders",
        "WITH RECURSIVE t(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM t) SELECT x FROM t",
        "SELECT * FROM orders o JOIN missing m ON o.id=m.id",
    ],
)
def test_admission_denies_unsafe_or_unapproved_sql(adhoc, sql):
    s = adhoc()
    with pytest.raises((PermissionError, ValueError)):
        ask(s, sql)
    assert not any(a.get("event") == "private_sql" for a in s.audit)


def test_alias_cannot_leak_sql_and_evidence_is_host_owned(adhoc):
    s = adhoc()
    session = s.open()["session_id"]
    result = ask(
        s, 'SELECT SUM(amount) AS "SELECT PRIVATE SQL FROM secret" FROM orders WHERE NOT is_test', session
    )
    evidence = s.evidence(Ref(session_id=session, evidence_ref=result["evidence_ref"]))
    assert result["result"]["columns"] == [{"key": "c1", "label": "sum_amount"}]
    assert "PRIVATE" not in json.dumps([result, evidence])
    assert "sql" not in json.dumps(evidence).lower()
    assert s.capabilities_public()["metadata_documents"] == []
    with pytest.raises(PermissionError):
        s.metadata(None, ["structure"], "planner")


@pytest.mark.parametrize(
    "action,kind", [("execute_query", "query"), ("receive_answer", "answer.sql_result")]
)
def test_cedar_column_boundary_before_execution(adhoc, action, kind):
    s = adhoc(
        f'\nforbid(principal, action == Service::Action::"{action}", resource) when {{ resource.kind == "{kind}" && resource.columns.contains("amount") }};'
    )
    with pytest.raises(PermissionError):
        ask(s, "SELECT SUM(amount) FROM orders WHERE NOT is_test")
    assert not any(a.get("event") == "private_sql" for a in s.audit)


DENIED_REFERENCES = [
    "SELECT email FROM customers",
    "SELECT c.email FROM customers c",
    'SELECT "email" FROM customers',
    "SELECT customers.email FROM customers",
    "SELECT * FROM customers",
    "SELECT c.* FROM customers c",
    "SELECT COUNT(*) FROM customers WHERE email LIKE '%@%'",
    "SELECT COUNT(*) FROM customers ORDER BY MIN(email)",
    "SELECT region, COUNT(*) FROM customers GROUP BY region HAVING MAX(email) > ''",
    "WITH a AS (SELECT email FROM customers) SELECT COUNT(*) FROM a",
    "WITH a AS (SELECT email AS e FROM customers) SELECT COUNT(e) FROM a",
    "WITH a AS (SELECT * FROM customers) SELECT COUNT(*) FROM a",
    "SELECT COUNT(*) FROM (SELECT email FROM customers) t",
    "SELECT COUNT(*) FROM (SELECT * FROM customers) t",
    "SELECT COUNT(*) FROM orders WHERE customer_id IN (SELECT id FROM customers WHERE email IS NOT NULL)",
    "SELECT COUNT(*) FROM orders o WHERE EXISTS (SELECT 1 FROM customers c WHERE c.id = o.customer_id AND c.email LIKE 'p%')",
    "SELECT COUNT(*) FROM orders o JOIN customers c ON o.customer_id = c.id AND c.email IS NOT NULL",
    "SELECT COUNT(*) FROM customers c1 JOIN customers c2 ON c1.email = c2.email",
    "SELECT COUNT(DISTINCT email) FROM customers",
    "SELECT COUNT(*) FROM customers UNION ALL SELECT COUNT(email) FROM customers",
    "SELECT MIN(LENGTH(email)) FROM customers",
]


@pytest.mark.parametrize("sql", DENIED_REFERENCES)
def test_a_denied_column_is_refused_in_every_reference_form(adhoc, sql):
    s = adhoc()
    with pytest.raises(PermissionError, match="denied_column"):
        s.sql.prepare(sql)
    with pytest.raises(PermissionError):
        ask(s, sql)
    assert not any(a.get("event") == "private_sql" for a in s.audit)
    assert not any(a.get("event") == "private_sql_rejected" for a in s.audit)


@pytest.mark.parametrize(
    "sql",
    [
        "SELECT customers FROM customers",
        "SELECT c FROM customers c",
        "SELECT COLUMNS('.*') FROM customers",
        "SELECT COLUMNS(c -> c LIKE '%mail') FROM customers",
        "SELECT TO_JSON(c) FROM customers c",
        "SELECT STRUCT_PACK(a := email) FROM customers",
        "SELECT * EXCLUDE (region) FROM customers",
    ],
)
def test_row_valued_and_pattern_forms_do_not_reach_a_denied_column(adhoc, sql):
    s = adhoc()
    with pytest.raises((PermissionError, ValueError)):
        ask(s, sql)
    assert not any(a.get("event") == "private_sql" for a in s.audit)


def test_a_non_denied_column_of_the_same_model_stays_queryable(adhoc):
    result = ask(adhoc(), "SELECT COUNT(*) FROM customers WHERE region = 'North'")
    assert result["result"]["rows"] == [{"c1": 1}]
    result = ask(adhoc(), "SELECT * EXCLUDE (email) FROM customers ORDER BY id LIMIT 2")
    assert [c["label"] for c in result["result"]["columns"]] == ["id", "region"]


def test_a_denied_column_is_in_no_worker_visible_projection(adhoc):
    s = adhoc()
    seen = []
    original = s.ipc.call

    def call(op, **kwargs):
        if op == "invoke":
            cb = kwargs["callback"]
            seen.append(json.loads(kwargs["request"])["context_index"])
            seen.append(cb("list_context", {}))
            seen.append(cb("select_context", {"ids": ["customers"]}))
            seen.append(cb("read_context", {"ids": ["customers", "orders"]}))
            seen.append(cb("read_context", {"ids": ["rule:knowledge/rules/conventions.md"]}))
            out = cb("run_sql", {"sql": "SELECT COUNT(*) FROM customers"})
            return {"evidence": out["evidence"]}
        return original(op, **kwargs)

    s.ipc.call = call
    ask(s, "ignored")
    assert "email" not in json.dumps(seen).lower()
    assert "private-" not in json.dumps(seen)


def test_followup_cache_and_evidence_reauthorize_lineage(adhoc):
    s = adhoc()
    session = s.open()["session_id"]
    sql = "SELECT SUM(amount) FROM orders WHERE NOT is_test"
    first = ask(s, sql, session)
    assert ask(s, sql, session) == first
    second = ask(
        s,
        "SELECT AVG(amount) FROM orders WHERE NOT is_test",
        session,
        1,
        first["result_ref"],
        "two",
    )
    assert second["result"]["rows"] == [{"c1": 65.0}]
    allowed = s.allowed
    s.allowed = lambda session, action, kind, *a, **kw: (
        False
        if kind == "answer.sql_result"
        else allowed(session, action, kind, *a, **kw)
    )
    with pytest.raises(PermissionError):
        s.evidence(Ref(session_id=session, evidence_ref=first["evidence_ref"]))
    with pytest.raises(PermissionError):
        ask(s, sql, session)
    with pytest.raises(PermissionError):
        ask(s, sql, session, 2, first["result_ref"], "three")


def test_public_mcp_has_no_sql_execution_tool(adhoc):
    mcp = build_mcp(adhoc())
    assert {t.name for t in asyncio.run(mcp.list_tools())} == {
        "capabilities",
        "open_session",
        "ask_data",
        "continue_task",
        "get_evidence",
        "read_metadata",
        "close_session",
    }


def test_private_can_repair_shape_without_executing_or_disclosing_literal(adhoc):
    s = adhoc()
    original = s.ipc.call

    def call(op, **kwargs):
        if op == "invoke":
            cb = kwargs["callback"]
            rejected = cb(
                "run_sql",
                {"sql": "SELECT 'PRIVATE_SQL' AS metric, SUM(amount) FROM orders"},
            )
            assert rejected["error"] == "unsupported_result_shape"
            assert "PRIVATE_SQL" not in json.dumps(rejected)
            result = cb(
                "run_sql", {"sql": "SELECT SUM(amount) FROM orders WHERE NOT is_test"}
            )
            return {"evidence": result["evidence"]}
        return original(op, **kwargs)

    s.ipc.call = call
    result = ask(s, "ignored")
    assert result["result"]["rows"] == [{"c1": 780.0}]
    assert len([a for a in s.audit if a.get("event") == "private_sql"]) == 1
    assert "PRIVATE_SQL" not in json.dumps(result)


@pytest.mark.parametrize(
    "sql,code",
    [
        ("SELECT SUM(amt) FROM orders WHERE NOT is_test", "unresolved_column"),
        (
            "WITH x AS (SELECT SUM(amount) AS total FROM orders WHERE NOT is_test) SELECT grand_total FROM x",
            "unresolved_column",
        ),
        (
            "SELECT SUM(o.amount * (SELECT COUNT(*) FROM customers c WHERE c.id = o.customer_id)) FROM orders o WHERE NOT o.is_test",
            "unresolved_column",
        ),
        ("SELECT SUM(amount) FROM orders WHERE", "invalid_sql"),
    ],
)
def test_private_can_repair_planning_failure_without_authorization_change(
    adhoc, sql, code
):
    s = adhoc()
    original = s.ipc.call

    def call(op, **kwargs):
        if op == "invoke":
            cb = kwargs["callback"]
            rejected = cb("run_sql", {"sql": sql})
            assert rejected["error"] == "unsupported_query"
            assert rejected["code"] == code
            assert set(rejected) == {"error", "code", "hint"}
            result = cb(
                "run_sql", {"sql": "SELECT SUM(amount) FROM orders WHERE NOT is_test"}
            )
            return {"evidence": result["evidence"]}
        return original(op, **kwargs)

    s.ipc.call = call
    result = ask(s, "ignored")
    assert result["result"]["rows"] == [{"c1": 780.0}]
    events = [a.get("event") for a in s.audit]
    assert events.count("private_sql_rejected") == 1
    assert events.count("private_sql") == 1
    assert not any(a.get("reason") == "denied" for a in s.audit)


@pytest.mark.parametrize(
    "sql",
    [
        "SELECT email FROM customers",
        "SELECT * FROM orders o JOIN missing m ON o.id=m.id",
        "SELECT * FROM read_csv('/etc/passwd')",
        "UPDATE orders SET amount=0",
    ],
)
def test_authorization_failures_still_end_the_task(adhoc, sql):
    s = adhoc()
    s.test_sql = sql
    with pytest.raises(PermissionError):
        ask(s, "ignored")
    assert not any(a.get("event") == "private_sql_rejected" for a in s.audit)


def test_weekly_native_dates_and_target_expression(adhoc):
    s = adhoc()
    result = ask(
        s,
        "SELECT DATE_TRUNC('week', order_date) AS week, SUM(amount), COUNT(*), COUNT(*) >= 4 FROM orders WHERE NOT is_test GROUP BY 1 ORDER BY 1",
    )
    assert [r["c2"] for r in result["result"]["rows"]] == [60.0, 220.0, 500.0]
    assert [r["c3"] for r in result["result"]["rows"]] == [3, 4, 5]
    assert [r["c4"] for r in result["result"]["rows"]] == [False, True, True]
    assert result["result"]["rows"][0]["c1"].startswith("2025-12-29")


def test_followup_has_original_question_even_if_prior_result_has_no_date(adhoc):
    s = adhoc()
    session = s.open()["session_id"]
    first = ask(
        s,
        "SELECT SUM(amount) FROM orders WHERE order_date >= TIMESTAMP '2026-01-05' AND order_date < TIMESTAMP '2026-01-12' AND NOT is_test",
        session,
    )
    original = s.ipc.call

    def call(op, **kwargs):
        if op == "invoke":
            assert (
                json.loads(kwargs["request"])["previous"]["original_question"]
                == "analyze data"
            )
        return original(op, **kwargs)

    s.ipc.call = call
    ask(
        s,
        "SELECT AVG(amount) FROM orders WHERE NOT is_test",
        session,
        1,
        first["result_ref"],
        "two",
    )


def worker(s, *statements):
    """The answers a worker gets for these statements, in order, within one task.

    The last answer carrying an evidence token is returned as the worker's final output."""
    answers = []
    original = s.ipc.call

    def call(op, **kwargs):
        if op != "invoke":
            return original(op, **kwargs)
        cb = kwargs["callback"]
        for sql in statements:
            answers.append(cb("run_sql", {"sql": sql}))
        tokens = [a["evidence"] for a in answers if "evidence" in a]
        return {"evidence": tokens[-1]} if tokens else {"value": None}

    s.ipc.call = call
    return answers


def run(s, *statements, session=None):
    answers = worker(s, *statements)
    try:
        result = s.execute(
            Ask(
                session_id=session or s.open()["session_id"],
                request_id="gate",
                expected_revision=0,
                capability="analytics",
                question="analyze data",
            )
        )
    except (ValueError, PermissionError) as exc:
        return answers, exc
    return answers, result


def events(s, name):
    return [a for a in s.audit if a.get("event") == name]


JOIN = "r.currency = i.currency AND i.invoice_date >= r.rate_date"
FX = "convert-invoices-to-usd"
RATE_COUNTEREXAMPLES = [
    pytest.param(
        "SELECT SUM(i.amount * r.rate_to_usd) FROM invoices i JOIN fx_rates r ON r.currency = i.currency AND r.rate_date <= i.invoice_date",
        [f"{FX}:rate_multi_match", f"{FX}:base_currency_dropped"],
        id="ordinary-date-join-multi-match",
    ),
    pytest.param(
        f"SELECT SUM(i.amount * r.rate_to_usd) FROM invoices i ASOF JOIN fx_rates r ON {JOIN}",
        [f"{FX}:base_currency_dropped"],
        id="inner-asof-drops-usd-rows",
    ),
    pytest.param(
        f"SELECT SUM(i.amount * COALESCE(r.rate_to_usd, 1)) FROM invoices i ASOF LEFT JOIN fx_rates r ON {JOIN}",
        [f"{FX}:rate_default_literal"],
        id="coalesce-1-for-every-currency",
    ),
    pytest.param(
        "SELECT SUM(i.amount) FROM invoices i",
        [FX],
        id="no-rate-join-at-all",
    ),
    pytest.param(
        "SELECT SUM(amount) FROM orders",
        ["exclude-test-orders"],
        id="test-orders-not-excluded",
    ),
]


@pytest.mark.parametrize(("sql", "rules"), RATE_COUNTEREXAMPLES)
def test_declared_default_counterexamples_are_rejected_and_not_executed(
    adhoc, sql, rules
):
    s = adhoc()
    answers, _ = run(s, sql)
    assert answers == [
        {
            "error": "declared_default_missing",
            "code": "rule_violation",
            "rules": rules,
            "hint": answers[0]["hint"],
        }
    ]
    assert not events(s, "private_sql")
    rejected = events(s, "private_sql_rejected")
    assert [
        (e["code"], e["sub_code"], e["rules"], e["attempt"]) for e in rejected
    ] == [("declared_default_missing", "rule_violation", rules, 1)]


FX_GUARDED = f"SELECT SUM(CASE WHEN i.currency = 'USD' THEN i.amount ELSE i.amount * r.rate_to_usd END) FROM invoices i ASOF LEFT JOIN fx_rates r ON {JOIN}"
FX_UNGUARDED = f"SELECT SUM(i.amount * r.rate_to_usd) FROM invoices i ASOF LEFT JOIN fx_rates r ON {JOIN}"


def test_a_rejected_rate_query_is_rewritten_into_the_base_currency_form(adhoc):
    s = adhoc()
    answers, result = run(
        s,
        f"SELECT SUM(i.amount * COALESCE(r.rate_to_usd, 1)) FROM invoices i ASOF LEFT JOIN fx_rates r ON {JOIN}",
        FX_GUARDED,
    )
    assert answers[0]["rules"] == [f"{FX}:rate_default_literal"]
    assert result["status"] == "completed"
    # USD 100 + 50 untouched, EUR 200 at 1.0, GBP 300 at 2.0, EUR 400 at 1.5.
    assert result["result"]["rows"] == [{"c1": 1550.0}]
    internal = s.sessions[result["session_id"]]["evidence"][result["evidence_ref"]][
        "internal"
    ]
    assert internal["checks"] == {
        "exclude-test-orders": {"applicable": False, "result": "not_applicable"},
        FX: {"applicable": True, "result": "satisfied"},
    }
    assert internal["observed"]["fx_missing_rate_handling"] == "guarded_by_base_currency"


def test_a_left_join_without_a_guard_runs_and_records_how_a_missing_rate_is_handled(
    adhoc,
):
    s = adhoc()
    _, result = run(s, FX_UNGUARDED)
    assert result["status"] == "completed"
    internal = s.sessions[result["session_id"]]["evidence"][result["evidence_ref"]][
        "internal"
    ]
    assert internal["checks"][FX] == {"applicable": True, "result": "satisfied"}
    assert internal["observed"]["fx_missing_rate_handling"] == "unguarded_left_join"


def test_checks_and_observed_come_from_the_qualified_statement(adhoc):
    s = adhoc()
    _, result = run(
        s,
        "SELECT c.region, SUM(o.amount) FROM orders o JOIN customers c ON o.customer_id = c.id "
        "WHERE NOT o.is_test AND o.order_date >= TIMESTAMP '2026-01-05' GROUP BY c.region",
    )
    internal = s.sessions[result["session_id"]]["evidence"][result["evidence_ref"]][
        "internal"
    ]
    assert internal["checks"] == {
        "exclude-test-orders": {"applicable": True, "result": "satisfied"},
        FX: {"applicable": False, "result": "not_applicable"},
    }
    assert internal["observed"] == {
        "models": ["customers", "orders"],
        "columns": {
            "customers": ["id", "region"],
            "orders": ["amount", "customer_id", "is_test", "order_date"],
        },
        "joins": [["customers", "orders"]],
        "aggregated": True,
        "filters": [
            {"column": "orders.is_test", "operator": "is false"},
            {"column": "orders.order_date", "operator": ">="},
        ],
        "status_literals": {},
    }
    text = json.dumps(internal["observed"])
    assert "email" not in text and "SELECT" not in text and "2026" not in text


FORM_ERRORS = [
    ("SELECT e FROM customers AS c(a, b, e)", "column_list_alias"),
    ("SELECT * FROM customers AS c(a, b, e)", "column_list_alias"),
    ("SELECT COUNT(*) FROM customers AS c(a, b, e) WHERE e IS NOT NULL", "column_list_alias"),
    ("SELECT COUNT(*) FROM orders NATURAL JOIN customers", "natural_join"),
    ("SELECT COUNT(*) FROM customers c1 NATURAL JOIN customers c2", "natural_join"),
    ("SELECT COUNT(*) FROM orders o NATURAL LEFT JOIN customers c", "natural_join"),
    ("SELECT MAX(#1) FROM customers", "positional_reference"),
    ("SELECT #3 FROM customers", "positional_reference"),
    ("SELECT region FROM customers ORDER BY #1", "positional_reference"),
]


@pytest.mark.parametrize(("sql", "code"), FORM_ERRORS)
def test_forms_that_reach_a_column_without_naming_it_are_form_errors(adhoc, sql, code):
    s = adhoc()
    with pytest.raises(QueryFormError) as caught:
        s.sql.prepare(sql)
    assert (caught.value.error, caught.value.code) == ("unsupported_query", code)
    answers, _ = run(s, sql)
    assert (answers[0]["error"], answers[0]["code"]) == ("unsupported_query", code)
    assert set(answers[0]) == {"error", "code", "hint"}
    assert not events(s, "private_sql")
    assert [(e["code"], e["sub_code"]) for e in events(s, "private_sql_rejected")] == [
        ("unsupported_query", code)
    ]
    assert not any(a.get("reason") == "denied" for a in s.audit)


def test_a_column_list_alias_on_a_derived_table_is_not_a_table_alias(adhoc):
    s = adhoc()
    _, result = run(s, "SELECT t.a FROM (SELECT region FROM customers) AS t(a)")
    assert result["status"] == "completed"
    assert result["result"]["columns"] == [{"key": "c1", "label": "region"}]


PIVOT = "SELECT SUM(CASE WHEN region = 'North' THEN id ELSE 0 END), SUM(CASE WHEN region = 'South' THEN id ELSE 0 END), SUM(CASE WHEN region = 'East' THEN id ELSE 0 END) FROM customers"


def test_a_pivot_with_one_label_per_literal_is_rewritten_with_group_by(adhoc):
    s = adhoc()
    answers, result = run(
        s, PIVOT, "SELECT region, SUM(id) FROM customers GROUP BY region ORDER BY region"
    )
    assert answers[0] == {
        "error": "unsupported_result_shape",
        "code": "duplicate_label",
        "hint": "This SQL was NOT executed: two result columns would carry the same label. Use GROUP BY so the key is a data column instead of one column per literal.",
    }
    assert result["status"] == "completed"
    assert result["result"]["columns"] == [
        {"key": "c1", "label": "region"},
        {"key": "c2", "label": "sum_id"},
    ]
    rejected = events(s, "private_sql_rejected")
    assert [(e["code"], e["sub_code"]) for e in rejected] == [
        ("unsupported_result_shape", "duplicate_label")
    ]


def test_every_other_shape_rejection_names_its_code(adhoc):
    s = adhoc()
    answers, _ = run(s, "SELECT 'PRIVATE_SQL' AS metric, SUM(amount) FROM orders")
    assert (answers[0]["error"], answers[0]["code"]) == (
        "unsupported_result_shape",
        "literal_disclosure",
    )
    assert "PRIVATE_SQL" not in json.dumps(answers)


def test_the_three_error_kinds_each_finish_inside_one_task(adhoc):
    s = adhoc()
    engine = "SELECT COUNT(*) FROM orders WHERE NOT is_test AND CAST('abc' AS INTEGER) = 1"
    answers, result = run(
        s,
        "SELECT SUM(amt) FROM orders WHERE NOT is_test",
        engine,
        "SELECT COUNT(*) FROM orders WHERE NOT is_test",
    )
    assert [a.get("error") for a in answers] == [
        "unsupported_query",
        "query_unavailable",
        None,
    ]
    assert answers[1] == {
        "error": "query_unavailable",
        "hint": answers[1]["hint"],
    }
    assert result["status"] == "completed" and result["result"]["rows"] == [{"c1": 12}]
    sequence = [
        e["event"]
        for e in s.audit
        if e.get("event", "").startswith(("private_sql", "task_"))
    ]
    assert sequence == [
        "private_sql_attempt",
        "private_sql_rejected",
        "private_sql_attempt",
        "private_sql_failed",
        "private_sql_attempt",
        "private_sql",
        "task_completed",
    ]
    failed = events(s, "private_sql_failed")[0]
    assert set(failed) == {"t", "event", "request_id", "error_class", "attempt"}
    assert failed["attempt"] == 2 and failed["error_class"] not in ("", None)
    assert "abc" not in json.dumps(failed)


def test_a_cedar_denial_ends_the_task_as_denied(adhoc):
    s = adhoc(
        '\nforbid(principal, action == Service::Action::"execute_query", resource);'
    )
    answers, caught = run(s, "SELECT COUNT(*) FROM orders WHERE NOT is_test")
    assert answers == []
    assert isinstance(caught, PermissionError) and str(caught) == "denied"
    failed = [e for e in s.audit if e.get("event") == "task_failed"]
    assert [(e["reason"], e["detail"]) for e in failed] == [("denied", "denied")]
    assert not events(s, "private_sql")


def test_a_denied_statement_after_a_rewrite_still_ends_the_task(adhoc):
    s = adhoc()
    original = s.ipc.call
    seen = []

    def call(op, **kwargs):
        if op != "invoke":
            return original(op, **kwargs)
        cb = kwargs["callback"]
        seen.append(cb("run_sql", {"sql": "SELECT SUM(amt) FROM orders"})["error"])
        with pytest.raises(PermissionError, match="query_denied:denied_column"):
            cb("run_sql", {"sql": "SELECT email FROM customers"})
        with pytest.raises(PermissionError):
            cb("run_sql", {"sql": "SELECT COUNT(*) FROM customers"})
        return {"evidence": "forged"}

    s.ipc.call = call
    with pytest.raises(PermissionError, match="denied"):
        s.execute(
            Ask(
                session_id=s.open()["session_id"],
                request_id="one",
                expected_revision=0,
                capability="analytics",
                question="analyze data",
            )
        )
    assert seen == ["unsupported_query"]
    assert not events(s, "private_sql")


def test_only_declared_values_of_an_enumerated_column_are_recorded_as_literals():
    from types import SimpleNamespace  # noqa: PLC0415

    from wren.agent_sql import AdHocSQL  # noqa: PLC0415

    catalog = {
        "models": [
            {
                "name": "tickets",
                "columns": [
                    {"name": "id", "type": "INTEGER"},
                    {
                        "name": "status",
                        "type": "VARCHAR",
                        "enum_values": [
                            {"value": "open", "meaning": "Not resolved"},
                            {"value": "closed", "meaning": "Resolved"},
                        ],
                    },
                    {"name": "note", "type": "VARCHAR"},
                ],
            }
        ]
    }
    gate = AdHocSQL(
        SimpleNamespace(
            snapshot=SimpleNamespace(catalog=catalog, denied=frozenset(), declarations=())
        )
    )
    prepared = gate.prepare(
        "SELECT COUNT(*) FROM tickets WHERE status IN ('open', 'PRIVATE SQL') "
        "AND status <> 'closed' AND note = 'open'"
    )
    observed = prepared.observed
    assert observed["status_literals"] == {"tickets.status": ["closed", "open"]}
    assert observed["filters"] == [
        {"column": "tickets.status", "operator": "in"},
        {"column": "tickets.status", "operator": "<>"},
        {"column": "tickets.note", "operator": "="},
    ]
    assert "PRIVATE" not in json.dumps(observed)
    assert prepared.checks == {}


SET_OPERATIONS = {
    "union all": "SELECT id, region FROM customers UNION ALL SELECT id, region FROM customers",
    "union": "SELECT id, region FROM customers UNION SELECT id, region FROM customers",
    "except": "SELECT id, region FROM customers EXCEPT SELECT id, region FROM customers",
    "intersect": "SELECT id, region FROM customers INTERSECT SELECT id, region FROM customers",
}


@pytest.mark.parametrize("sql", SET_OPERATIONS.values(), ids=SET_OPERATIONS.keys())
def test_a_multi_column_set_operation_keeps_the_catalog_column_names(adhoc, sql):
    s = adhoc()
    assert s.sql.prepare(sql).labels == ["id", "region"]
    _, result = run(s, sql)
    assert result["status"] == "completed"
    assert result["result"]["columns"] == [
        {"key": "c1", "label": "id"},
        {"key": "c2", "label": "region"},
    ]


def test_duplicate_labels_are_judged_in_each_select_of_a_set_operation(adhoc):
    s = adhoc()
    for sql in (
        "SELECT id, id FROM customers UNION ALL SELECT id, id FROM customers",
        "SELECT id, region FROM customers UNION ALL SELECT id, id FROM customers",
        PIVOT,
    ):
        with pytest.raises(QueryShapeError, match="duplicate_label"):
            s.sql.prepare(sql)


FUNCTION_MISSES = {
    "now": "SELECT now() FROM orders WHERE NOT is_test",
    "random": "SELECT random() FROM orders WHERE NOT is_test",
    "arg_max": "SELECT arg_max(id, amount) FROM orders WHERE NOT is_test",
    "string_agg": "SELECT string_agg(region, ',') FROM customers",
    "mode": "SELECT mode(region) FROM customers",
    "first": "SELECT first(region) FROM customers",
    "corr": "SELECT corr(id, id) FROM customers",
    "epoch": "SELECT epoch(order_date) FROM orders WHERE NOT is_test",
    "list_value": "SELECT list_value(id, id) FROM customers",
    "unnest": "SELECT unnest(list_value(id, id)) FROM customers",
    "any array": "SELECT COUNT(*) FROM orders WHERE NOT is_test AND id = ANY([1, 2])",
    "parenthesised select": "(SELECT COUNT(*) FROM orders WHERE NOT is_test)",
}


@pytest.mark.parametrize("sql", FUNCTION_MISSES.values(), ids=FUNCTION_MISSES.keys())
def test_a_function_outside_the_allowlist_is_a_rewritable_form_error(adhoc, sql):
    s = adhoc()
    with pytest.raises(QueryFormError) as caught:
        s.sql.prepare(sql)
    assert (caught.value.error, caught.value.code) == (
        "unsupported_query",
        "unsupported_function",
    )


def test_a_function_miss_is_rewritten_inside_the_same_task(adhoc):
    s = adhoc()
    answers, result = run(
        s,
        "SELECT COUNT(*) FROM orders WHERE NOT is_test AND order_date < now()",
        "SELECT COUNT(*) FROM orders WHERE NOT is_test",
    )
    assert (answers[0]["error"], answers[0]["code"]) == (
        "unsupported_query",
        "unsupported_function",
    )
    assert result["status"] == "completed" and result["result"]["rows"] == [{"c1": 12}]
    assert [(e["code"], e["sub_code"]) for e in events(s, "private_sql_rejected")] == [
        ("unsupported_query", "unsupported_function")
    ]
    assert not events(s, "task_failed")


@pytest.mark.parametrize(
    "sql",
    [
        "SELECT email, now() FROM customers",
        "SELECT COUNT(*) FROM read_csv('x') WHERE now() > 1",
        "WITH x AS (DELETE FROM orders RETURNING *) SELECT now() FROM orders",
    ],
)
def test_a_function_miss_does_not_hide_a_denial(adhoc, sql):
    with pytest.raises(PermissionError, match="query_denied"):
        adhoc().sql.prepare(sql)


def test_an_unexpected_planner_error_is_rewritable_never_terminal(adhoc, monkeypatch):
    s = adhoc()
    for error in (RuntimeError("boom"), KeyError("x"), ValueError("anything")):

        def fail(expr, error=error):
            raise error

        monkeypatch.setattr(s.sql, "_projection", fail)
        with pytest.raises(QueryFormError) as caught:
            s.sql.prepare("SELECT COUNT(*) FROM orders WHERE NOT is_test")
        assert (caught.value.error, caught.value.code) == (
            "unsupported_query",
            "unsupported",
        )
    monkeypatch.undo()
    _, result = run(s, "SELECT COUNT(*) FROM orders ANTI JOIN customers c USING (id) WHERE NOT is_test")
    assert result["status"] == "completed"


def test_a_semi_or_anti_join_target_no_column_names_is_still_a_source(adhoc):
    s = adhoc()
    for kind in ("SEMI", "ANTI"):
        prepared = s.sql.prepare(
            f"SELECT COUNT(*) FROM orders o {kind} JOIN customers c ON 1 = 1 WHERE NOT o.is_test"
        )
        assert prepared.sources == {"orders": ["is_test"], "customers": []}
        assert prepared.observed["models"] == ["customers", "orders"]


def test_a_cedar_forbid_on_a_model_only_a_semi_join_reads_ends_the_task(adhoc):
    s = adhoc(
        '\nforbid(principal, action == Service::Action::"execute_query", resource) '
        'when { resource.name == "customers" };'
    )
    ok, _ = run(s, "SELECT COUNT(*) FROM orders WHERE NOT is_test")
    assert ok[0]["evidence"]
    s = adhoc(
        '\nforbid(principal, action == Service::Action::"execute_query", resource) '
        'when { resource.name == "customers" };'
    )
    answers, caught = run(
        s,
        "SELECT COUNT(*) FROM orders o SEMI JOIN customers c ON 1 = 1 WHERE NOT o.is_test",
    )
    assert answers == []
    assert isinstance(caught, PermissionError) and str(caught) == "denied"
    assert not events(s, "private_sql")
    failed = events(s, "task_failed")
    assert [(e["reason"], e["detail"]) for e in failed] == [("denied", "denied")]
