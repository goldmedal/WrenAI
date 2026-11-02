"""Real synthetic queries and Cedar decisions; only private model calls are stubbed."""

import asyncio
import importlib.util
import json
import os
from pathlib import Path

import pytest

pytest.importorskip("mcp")
from wren.agent_service import Ask, Ref, build_mcp, create_service  # noqa: E402


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
        s.test_sql = "SELECT SUM(amount) FROM orders"

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
            "SELECT SUM(amount), AVG(amount), COUNT(*) FROM orders",
            [{"c1": 780.0, "c2": 65.0, "c3": 12}],
        ),
        (
            "SELECT c.region, SUM(o.amount) revenue FROM orders o JOIN customers c ON o.customer_id=c.id GROUP BY c.region ORDER BY revenue DESC",
            [
                {"c1": "East", "c2": 300.0},
                {"c1": "South", "c2": 260.0},
                {"c1": "North", "c2": 220.0},
            ],
        ),
        (
            "WITH totals AS (SELECT customer_id, SUM(amount) AS revenue FROM orders GROUP BY customer_id) SELECT c.region, t.revenue FROM totals t JOIN customers c ON t.customer_id=c.id ORDER BY t.revenue DESC LIMIT 2",
            [{"c1": "East", "c2": 300.0}, {"c1": "South", "c2": 260.0}],
        ),
        (
            "SELECT SUM(CASE WHEN amount >= 50 THEN amount ELSE 0 END) FROM orders",
            [{"c1": 680.0}],
        ),
        (
            "SELECT COUNT(*) FROM orders o JOIN customers c ON o.customer_id=c.id WHERE c.region='North'",
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
        s, 'SELECT SUM(amount) AS "SELECT PRIVATE SQL FROM secret" FROM orders', session
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
        ask(s, "SELECT SUM(amount) FROM orders")
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
    sql = "SELECT SUM(amount) FROM orders"
    first = ask(s, sql, session)
    assert ask(s, sql, session) == first
    second = ask(
        s, "SELECT AVG(amount) FROM orders", session, 1, first["result_ref"], "two"
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
            result = cb("run_sql", {"sql": "SELECT SUM(amount) FROM orders"})
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
        ("SELECT SUM(amt) FROM orders", "unresolved_column"),
        (
            "WITH x AS (SELECT SUM(amount) AS total FROM orders) SELECT grand_total FROM x",
            "unresolved_column",
        ),
        (
            "SELECT SUM(o.amount * (SELECT COUNT(*) FROM customers c WHERE c.id = o.customer_id)) FROM orders o",
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
            result = cb("run_sql", {"sql": "SELECT SUM(amount) FROM orders"})
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
        "SELECT DATE_TRUNC('week', order_date) AS week, SUM(amount), COUNT(*), COUNT(*) >= 4 FROM orders GROUP BY 1 ORDER BY 1",
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
        "SELECT SUM(amount) FROM orders WHERE order_date >= TIMESTAMP '2026-01-05' AND order_date < TIMESTAMP '2026-01-12'",
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
    ask(s, "SELECT AVG(amount) FROM orders", session, 1, first["result_ref"], "two")
