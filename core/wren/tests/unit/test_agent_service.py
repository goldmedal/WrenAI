"""Service boundary tests use real Cedar IPC, the real context loader and the synthetic Wren database."""

import asyncio
import concurrent.futures
import importlib.util
import json
import os
import threading
from pathlib import Path

import pytest
import yaml
from pydantic import ValidationError

pytest.importorskip("mcp")

from wren.agent_project import Query, discover  # noqa: E402
from wren.agent_service import (  # noqa: E402
    Ask,
    Continue,
    Direct,
    Ref,
    build_mcp,
    create_service,
    execution_from_config,
    read_policy_presets,
    stage_bundle,
)
from wren.context import build_json  # noqa: E402
from wren.context_adapter import ContextLoaderUnavailable, resolve_loader  # noqa: E402

EXAMPLES = Path(__file__).resolve().parents[4] / "examples/serve-agent"
FAKE_RUNTIME = Path(__file__).parent / "fixtures/fake_runtime.js"


@pytest.fixture
def service(tmp_path):
    runtime, compiler = os.getenv("WARBLE_SERVICE"), os.getenv("WARBLE_BIN")
    if not runtime or not compiler:
        pytest.skip("Set WARBLE_SERVICE and WARBLE_BIN for cross-package integration")
    try:
        resolve_loader()
    except ContextLoaderUnavailable:
        pytest.skip("build core/wren-context-loader or set WREN_CONTEXT_LOADER_BIN")
    spec = importlib.util.spec_from_file_location(
        "setup_agent_fixture", EXAMPLES / "setup.py"
    )
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    module.prepare(tmp_path / "fixture")
    root = tmp_path / "fixture/project"
    instances = []

    def make(
        policy="",
        selection=(),
        mode="mcp",
        updates=None,
        preset=None,
        runtime_path=None,
        profile="analysis",
    ):
        config = yaml.safe_load((root / "service.yml").read_text())
        config["metadata_selection"] = list(selection)
        config.update(updates or {})
        config_path = root / f"service-{len(instances)}.yml"
        policy_path = root / f"policy-{len(instances)}.cedar"
        config["policy"] = policy_path.name
        base = "adhoc-policy.cedar" if profile == "adhoc" else "policy.cedar"
        policy_path.write_text((EXAMPLES / base).read_text() + policy)
        config_path.write_text(yaml.safe_dump(config))
        s = create_service(
            root,
            EXAMPLES / "profiles" / profile,
            config_path,
            Path(runtime_path or runtime),
            compiler,
            mode,
            policy_preset=preset,
        )
        instances.append(s)
        return s

    make.root = root
    yield make
    for s in instances:
        s.shutdown()


def request(s, model="orders", **kwargs):
    o = s.open()
    return Direct(
        session_id=o["session_id"],
        request_id="one",
        expected_revision=0,
        capability="orders",
        query=Query(model=model, **kwargs),
    )


def execute(s, r):
    return s.execute(r, direct=r.query.model_dump())


def test_real_count_and_evidence(service):
    s = service()
    r = request(s)
    result = execute(s, r)
    assert result["result"]["rows"] == [{"c1": 12}]
    assert result["result"]["columns"] == [{"key": "c1", "label": "count"}]
    evidence = s.evidence(
        Ref(session_id=r.session_id, evidence_ref=result["evidence_ref"])
    )
    assert evidence["result"] == result["result"]
    assert "sql" not in json.dumps(evidence)
    assert execute(s, request(s, "customers"))["result"]["rows"] == [{"c1": 3}]


def test_planner_documents_come_from_the_project_and_the_worker_reads_them(service):
    s = service()
    documents = s.project.documents
    assert documents["structure"]["kind"] == "schema.structure"
    assert "model orders: One row per customer order" in documents["structure"]["content"]
    assert "exclude-test-orders" in documents["rules"]["content"]
    with pytest.raises(PermissionError):
        s.metadata(None, ["rules"], "planner")
    assert {d["id"] for d in s.metadata(None, ["rules", "structure"], "worker")} == {
        "rules",
        "structure",
    }


@pytest.mark.parametrize(
    "selection", [[], ["structure"], ["structure", "rules"], ["rules"]]
)
def test_metadata_selection_intersection(service, selection):
    s = service(selection=selection)
    for name in ("structure", "rules"):
        if name in selection:
            assert s.metadata(None, [name], "planner")
        else:
            with pytest.raises(PermissionError):
                s.metadata(None, [name], "planner")
    assert s.metadata(None, ["structure", "rules"], "worker")


@pytest.mark.parametrize(
    "action", ["invoke_component", "execute_query", "receive_answer"]
)
def test_denied_capability_query_and_answer(service, action):
    s = service(
        policy=f'forbid(principal, action == Service::Action::"{action}", resource);'
    )
    with pytest.raises(PermissionError):
        execute(s, request(s))


def test_governed_run_sql_accepts_only_the_canonical_count(service):
    s = service()
    assert s.canonical_count('SELECT COUNT(*) FROM "orders"') == {"model": "orders"}
    assert s.canonical_count("select count(*) from customers") == {"model": "customers"}
    for sql in (
        "SELECT * FROM orders",
        "SELECT COUNT(*) FROM missing",
        "DROP TABLE orders",
        "SELECT read_csv('/etc/passwd')",
        "SELECT COUNT(*) FROM orders; SELECT 1",
        "SELECT COUNT(*) FROM orders WHERE id > 1",
        "SELECT",
    ):
        with pytest.raises(PermissionError):
            s.canonical_count(sql)


def test_idempotency_conflict_and_ownership(service):
    s = service()
    r = request(s)
    result = execute(s, r)
    assert execute(s, r) == result
    with pytest.raises(ValueError, match="conflict"):
        execute(s, r.model_copy(update={"query": Query(model="customers")}))
    with pytest.raises(ValueError, match="conflict"):
        execute(s, r.model_copy(update={"request_id": "two"}))
    other = s.open()["session_id"]
    with pytest.raises(PermissionError):
        s.evidence(Ref(session_id=other, evidence_ref=result["evidence_ref"]))
    with pytest.raises(ValueError, match="session_expired"):
        s.session("made-up")
    s.close(r.session_id)
    with pytest.raises(ValueError, match="session_expired"):
        execute(s, r)


def test_context_version_invalidates_old_evidence(service):
    s = service()
    r = request(s)
    result = execute(s, r)
    rules = s.project.root / "knowledge/rules/conventions.md"
    rules.write_text(rules.read_text() + "\nChanged.\n")
    with pytest.raises(ValueError, match="context_changed"):
        s.evidence(Ref(session_id=r.session_id, evidence_ref=result["evidence_ref"]))
    assert s.sessions[r.session_id]["closed"]


def test_a_model_file_edit_also_invalidates_the_running_context(service):
    s = service()
    r = request(s)
    result = execute(s, r)
    path = s.project.root / "models/customers/metadata.yml"
    path.write_text(path.read_text().replace("Customers and", "All customers and"))
    with pytest.raises(ValueError, match="context_changed"):
        s.evidence(Ref(session_id=r.session_id, evidence_ref=result["evidence_ref"]))


def test_restart_after_a_project_edit_changes_digest_and_documents_without_config_edits(
    service, tmp_path
):
    sink = tmp_path / "first.jsonl"
    first = service(updates={"audit_path": str(sink)})
    before = first.project.documents
    loaded = [
        json.loads(x)
        for x in sink.read_text().splitlines()
        if json.loads(x).get("event") == "context_loaded"
    ]
    assert len(loaded) == 1 and loaded[0]["digest"] == first.project.snapshot.digest
    root = first.project.root
    rules = root / "knowledge/rules/conventions.md"
    rules.write_text(rules.read_text().replace("Dates are UTC", "Dates are in UTC"))
    model = root / "models/customers/metadata.yml"
    model.write_text(model.read_text().replace("Customers and", "Buyers and"))
    sink2 = tmp_path / "second.jsonl"
    second = service(updates={"audit_path": str(sink2)})
    event = next(
        e
        for e in map(json.loads, sink2.read_text().splitlines())
        if e.get("event") == "context_loaded"
    )
    assert event["digest"] != loaded[0]["digest"]
    assert second.project.documents["rules"]["content"] != before["rules"]["content"]
    assert "Dates are in UTC" in second.project.documents["rules"]["content"]
    assert "Buyers and the region" in second.project.documents["structure"]["content"]
    assert "Buyers and" not in before["structure"]["content"]


def test_an_edit_during_startup_refuses_the_service(service, monkeypatch):
    import wren.agent_service as agent_service

    open_engine = agent_service.open_engine

    def edit_then_open(*args, **kwargs):
        engine = open_engine(*args, **kwargs)
        rules = service.root / "knowledge/rules/conventions.md"
        rules.write_text(rules.read_text() + "\nEdited while starting.\n")
        return engine

    monkeypatch.setattr(agent_service, "open_engine", edit_then_open)
    with pytest.raises(ValueError, match="context_changed"):
        service()


def test_context_loaded_reports_budget_paging_and_identity(service, tmp_path):
    sink = tmp_path / "audit.jsonl"
    s = service(updates={"audit_path": str(sink)})
    event = next(
        e
        for e in map(json.loads, sink.read_text().splitlines())
        if e.get("event") == "context_loaded"
    )
    assert event["models"] == 2 and event["pages"] == 1
    assert event["budget_bytes"] == 4096
    assert 0 < event["first_page_bytes"] <= 4096
    assert event["loader_identity"].startswith("sha256:")
    assert event["digest"] == s.project.snapshot.digest


def test_a_large_project_is_paged_at_startup_and_still_starts(service, tmp_path):
    root = service.root
    template = yaml.safe_load((root / "models/customers/metadata.yml").read_text())
    template["columns"] = [c for c in template["columns"] if c["name"] != "email"]
    for i in range(45):
        name = f"extra_{i:02d}"
        directory = root / "models" / name
        directory.mkdir()
        (directory / "metadata.yml").write_text(
            yaml.safe_dump(
                {
                    **template,
                    "name": name,
                    "properties": {"description": f"Extra model number {i} that only exists to make the catalog larger than the context budget."},
                }
            )
        )
        (directory / "ref_sql.sql").write_text(
            "SELECT id, region FROM synthetic.main.raw_customers"
        )
    (root / "target/mdl.json").write_text(json.dumps(build_json(root)))
    sink = tmp_path / "audit.jsonl"
    s = service(updates={"audit_path": str(sink)})
    event = next(
        e
        for e in map(json.loads, sink.read_text().splitlines())
        if e.get("event") == "context_loaded"
    )
    assert event["models"] == 47 and event["pages"] > 1
    assert event["first_page_bytes"] <= 4096
    reader = s.project.reader
    listed = "\n".join(reader.list(n)["text"] for n in range(1, reader.pages + 1))
    assert all(f"model extra_{i:02d}: Extra model number {i} that only exists to make the catalog larger than the context budget." in listed for i in range(45))


def test_idle_ttl_and_restarted_service(service):
    s = service(updates={"idle_seconds": 0})
    r = request(s)
    with pytest.raises(ValueError, match="session_expired"):
        execute(s, r)
    s2 = service()
    with pytest.raises(ValueError, match="session_expired"):
        s2.session(r.session_id)


def test_closed_payloads_and_strict_types():
    with pytest.raises(ValidationError):
        Ask(
            session_id="s",
            request_id="r",
            expected_revision=0,
            capability="orders",
            question="hello",
            role="worker",
        )
    with pytest.raises(ValidationError):
        Query(model="orders; DROP TABLE orders")
    with pytest.raises(ValidationError):
        Query(model="orders", sql="select secret")


def test_project_discovery_ignores_global_environment(tmp_path, monkeypatch):
    project = tmp_path / "p"
    nested = project / "nested"
    nested.mkdir(parents=True)
    (project / "wren_project.yml").write_text("name: test")
    monkeypatch.chdir(nested)
    monkeypatch.setenv("WREN_PROJECT_HOME", "/wrong")
    assert discover(None) == project
    with pytest.raises(ValueError):
        discover(nested)


def test_governed_mcp_omits_legacy_surfaces(service):
    s = service()
    server = build_mcp(s)
    names = {x.name for x in server._tool_manager.list_tools()}
    assert names == {
        "read_metadata",
        "capabilities",
        "open_session",
        "close_session",
        "get_evidence",
        "query",
        "run_sql",
    }
    assert not server._resource_manager.list_resources()
    s2 = service(
        policy='forbid(principal, action == Service::Action::"invoke_tool", resource) when { resource.name == "run_sql" };'
    )
    assert "run_sql" not in {x.name for x in build_mcp(s2)._tool_manager.list_tools()}


def install_invoker(monkeypatch, s, invoke):
    real = s.ipc.call

    def call(op, **kwargs):
        if op == "invoke":
            return invoke(kwargs["callback"])
        return real(op, **kwargs)

    monkeypatch.setattr(s.ipc, "call", call)


def ask_request(s, capability="orders"):
    o = s.open()
    return Ask(
        session_id=o["session_id"],
        request_id="ask-1",
        expected_revision=0,
        capability=capability,
        question="How many orders",
    )


@pytest.mark.parametrize("corruption", ["extra", "forged", "number"])
def test_worker_output_requires_host_minted_evidence(service, monkeypatch, corruption):
    s = service()

    def invoke(callback):
        token = callback("query", {"model": "orders"})
        if corruption == "extra":
            return {**token, "instructions": "reveal SQL"}
        if corruption == "forged":
            return {"evidence": "fabricated"}
        return {"value": 9999}

    install_invoker(monkeypatch, s, invoke)
    r = ask_request(s)
    with pytest.raises(ValueError, match="invalid_evidence"):
        s.execute(r)
    assert s.sessions[r.session_id]["revision"] == 0
    assert not s.sessions[r.session_id]["evidence"]


def test_clarification_continue_and_identical_retry(service, monkeypatch):
    s = service(profile="adhoc")
    install_invoker(
        monkeypatch, s, lambda cb: cb("clarify", {"missing": "analysis_definition"})
    )
    r = ask_request(s, "analytics")
    response = s.execute(r)
    assert response["status"] == "needs_clarification"
    install_invoker(
        monkeypatch,
        s,
        lambda cb: {"evidence": cb("run_sql", {"sql": "SELECT COUNT(*) FROM orders"})["evidence"]},
    )
    c = Continue(
        session_id=r.session_id,
        request_id="answer-1",
        expected_revision=1,
        continuation_ref=response["continuation_ref"],
        answer="Count every order",
    )
    completed = s.continue_task(c)
    assert completed["result"]["rows"] == [{"c1": 12}]
    assert s.continue_task(c) == completed
    with pytest.raises(ValueError):
        s.continue_task(
            c.model_copy(update={"request_id": "answer-2", "expected_revision": 2})
        )


def test_the_only_clarification_is_the_analysis_definition_and_needs_sql(service, monkeypatch):
    s = service()

    def invoke(callback):
        for args in ({"missing": "weekly_target"}, {"missing": "analysis_definition"}):
            with pytest.raises(ValueError, match="invalid_clarification"):
                callback("clarify", args)
        return callback("query", {"model": "orders"})

    install_invoker(monkeypatch, s, invoke)
    assert s.execute(ask_request(s))["status"] == "completed"


def test_close_suppresses_late_completion(service, monkeypatch):
    s = service()
    r = ask_request(s)

    def invoke(callback):
        raw = callback("query", {"model": "orders"})
        s.close(r.session_id)
        return raw

    install_invoker(monkeypatch, s, invoke)
    with pytest.raises(ValueError, match="session_expired"):
        s.execute(r)
    assert not s.sessions[r.session_id]["results"]


def test_parallel_request_conflicts_and_different_session_survives(
    service, monkeypatch
):
    s = service()
    entered, finish = threading.Event(), threading.Event()
    r = ask_request(s)
    other = s.open()["session_id"]

    def invoke(callback):
        entered.set()
        assert finish.wait(5)
        return callback("query", {"model": "orders"})

    install_invoker(monkeypatch, s, invoke)
    with concurrent.futures.ThreadPoolExecutor() as pool:
        active = pool.submit(s.execute, r)
        assert entered.wait(5)
        with pytest.raises(ValueError, match="conflict"):
            s.execute(r.model_copy(update={"request_id": "parallel"}))
        assert s.session(other)["revision"] == 0
        finish.set()
        assert active.result()["status"] == "completed"


def test_closed_session_slots_are_reclaimed(service):
    s = service()
    for _ in range(70):
        ident = s.open()["session_id"]
        s.close(ident)
    assert len(s.sessions) == 1


def test_caller_project_and_cache_do_not_cross(service):
    first = service()
    r = request(first)
    result = execute(first, r)
    for updates in ({"caller": "second-caller"}, {"project_id": "second-project"}):
        second = service(updates=updates)
        with pytest.raises(ValueError, match="session_expired"):
            second.evidence(
                Ref(session_id=r.session_id, evidence_ref=result["evidence_ref"])
            )
        new = second.open()["session_id"]
        with pytest.raises(PermissionError):
            second.evidence(Ref(session_id=new, evidence_ref=result["evidence_ref"]))
    # Caller is host-owned. Tampering with it cannot re-use any session.
    first.caller = "changed-caller"
    with pytest.raises(ValueError, match="session_expired"):
        execute(first, r)
    first.caller = "local-planner"


def test_profile_and_connection_are_validated_before_serving(service):
    with pytest.raises(ValueError, match="explicit_connection_required"):
        service(updates={"connection": None})


def test_internal_evidence_retained_but_not_projected(service):
    s = service()
    r = request(s)
    result = execute(s, r)
    internal = s.sessions[r.session_id]["evidence"][result["evidence_ref"]]["internal"]
    assert "COUNT(*)" in internal["sql"]
    public = s.evidence(
        Ref(session_id=r.session_id, evidence_ref=result["evidence_ref"])
    )
    assert "internal" not in public and "COUNT" not in json.dumps(public)


def test_private_query_policy_denial_remains_denied(service, monkeypatch):
    s = service(
        policy='forbid(principal, action == Service::Action::"execute_query", resource);'
    )

    def invoke(callback):
        try:
            return callback("query", {"model": "orders"})
        except PermissionError:
            raise RuntimeError("runtime_unavailable") from None

    install_invoker(monkeypatch, s, invoke)
    with pytest.raises(PermissionError, match="denied"):
        s.execute(ask_request(s))


PRESETS = {
    "hidden": {"metadata_selection": []},
    "structure": {"metadata_selection": ["structure"]},
    "rules": {"metadata_selection": ["rules"]},
    "full": {"metadata_selection": ["structure", "rules"]},
}
NO_PLANNER_METADATA = (
    'forbid(principal, action == Service::Action::"receive_metadata", resource)'
    ' when { principal.role == "planner" };'
)


@pytest.mark.parametrize("preset", sorted(PRESETS))
def test_policy_preset_applies_selection_and_is_reported(service, preset):
    s = service(
        selection=["structure", "rules"],
        updates={"policy_presets": PRESETS, "default_preset": "hidden"},
        preset=preset,
    )
    public = s.capabilities_public()
    assert public["policy_preset"] == {
        "name": preset,
        "available": ["full", "hidden", "rules", "structure"],
    }
    visible = {d["id"] for d in public["metadata_documents"]}
    assert visible == set(PRESETS[preset]["metadata_selection"])
    for name in ("structure", "rules"):
        if name in visible:
            assert s.metadata(None, [name], "planner")
        else:
            with pytest.raises(PermissionError):
                s.metadata(None, [name], "planner")
    assert s.metadata(None, ["structure", "rules"], "worker")
    assert "policy_presets" not in s.config and "default_preset" not in s.config


def test_policy_preset_default_unknown_and_invalid(service):
    s = service(selection=["rules"], updates={"policy_presets": PRESETS})
    assert s.capabilities_public()["policy_preset"]["name"] is None
    assert {d["id"] for d in s.capabilities_public()["metadata_documents"]} == {
        "rules"
    }
    s = service(
        selection=["rules"],
        updates={"policy_presets": PRESETS, "default_preset": "structure"},
    )
    assert s.capabilities_public()["policy_preset"]["name"] == "structure"
    assert {d["id"] for d in s.capabilities_public()["metadata_documents"]} == {
        "structure"
    }
    bare = service()
    assert bare.capabilities_public()["policy_preset"] == {
        "name": None,
        "available": [],
    }
    with pytest.raises(ValueError, match="unknown_policy_preset"):
        service(updates={"policy_presets": PRESETS}, preset="nope")
    with pytest.raises(ValueError, match="unknown_policy_preset"):
        service(preset="hidden")
    for bad in (
        {"policy_presets": PRESETS, "default_preset": "nope"},
        {"policy_presets": {"full": {"caller": "other"}}},
        {"policy_presets": {"full": {"private_model": {}}}},
        {"policy_presets": {"Bad Name": {}}},
        {"policy_presets": ["hidden"]},
    ):
        with pytest.raises(ValueError, match="invalid_policy_preset"):
            service(updates=bad)


def test_policy_preset_cannot_expand_deployment_policy(service):
    s = service(
        policy=NO_PLANNER_METADATA,
        updates={"policy_presets": PRESETS},
        preset="full",
    )
    assert s.capabilities_public()["policy_preset"]["name"] == "full"
    assert s.capabilities_public()["metadata_documents"] == []
    for name in ("structure", "rules"):
        with pytest.raises(PermissionError):
            s.metadata(None, [name], "planner")
    assert s.metadata(None, ["structure", "rules"], "worker")


def test_policy_preset_overrides_the_selection_and_policy_file(service):
    s = service(updates={"policy_presets": PRESETS})
    root = s.project.root
    narrow = root / "preset-policy.cedar"
    narrow.write_text((root / s.config["policy"]).read_text() + NO_PLANNER_METADATA)
    presets = {
        **PRESETS,
        "q1": {
            "metadata_selection": ["structure", "rules"],
            "policy": narrow.name,
        },
    }
    s = service(updates={"policy_presets": presets}, preset="q1")
    assert s.capabilities_public()["metadata_documents"] == []
    assert narrow in s.project.paths
    narrow.write_text(narrow.read_text() + "\n")
    with pytest.raises(ValueError, match="context_changed"):
        s.capabilities_public()
    with pytest.raises(Exception):
        service(
            updates={"policy_presets": {"out": {"policy": "../outside.cedar"}}},
            preset="out",
        )


# --- service configuration v2 --------------------------------------------------------------------

LEGACY_VALUES = {
    "dataset": {"model": "orders", "date_column": "order_date"},
    "adhoc": {"models": {"orders": {"columns": ["id"]}}},
    "metadata": [{"id": "structure", "kind": "schema.structure", "path": "m.json"}],
    "rules": {"weekly-target": {"minimum": 4}},
    "query_scope": {"start": "2026-01-05", "end": "2026-01-12"},
}


@pytest.mark.parametrize("key", sorted(LEGACY_VALUES))
def test_legacy_service_config(service, key):
    with pytest.raises(ValueError, match="legacy_service_config") as raised:
        service(updates={key: LEGACY_VALUES[key]})
    message = str(raised.value)
    assert f"{key} (" in message and "config_version: 2" in message


def test_legacy_service_config_names_every_key_and_a_preset_query_scope(service):
    with pytest.raises(ValueError, match="legacy_service_config") as raised:
        service(
            updates={
                **LEGACY_VALUES,
                "policy_presets": {"q1": {"query_scope": {"start": "2026-01-01"}}},
            }
        )
    message = str(raised.value)
    for key in (*LEGACY_VALUES, "policy_presets.q1.query_scope"):
        assert key in message
    with pytest.raises(ValueError, match="legacy_service_config.*policy_presets.q1.query_scope"):
        service(updates={"policy_presets": {"q1": {"query_scope": {}}}})


def test_the_agent_presets_command_refuses_a_legacy_file_too(tmp_path):
    from typer.testing import CliRunner  # noqa: PLC0415

    from wren.serve_cli import serve_app  # noqa: PLC0415

    config = tmp_path / "service.yml"
    config.write_text(
        yaml.safe_dump({"policy_presets": {"q1": {"query_scope": {"start": "2026-01-01"}}}})
    )
    out = CliRunner().invoke(serve_app, ["agent-presets", "--service-config", str(config)])
    assert out.exit_code == 1 and "legacy_service_config" in out.output
    with pytest.raises(ValueError, match="legacy_service_config"):
        read_policy_presets({"query_scope": {}})


@pytest.mark.parametrize(
    ("updates", "message"),
    [
        ({"config_version": None}, "config_version: 2 is required"),
        ({"config_version": 1}, "config_version: 2 is required"),
        ({"config_version": "2"}, "config_version: 2 is required"),
        ({"surprise": True}, "unknown key surprise"),
        ({"execution": {"turbo": 1}}, "invalid_execution_config: turbo"),
    ],
)
def test_invalid_service_config_is_refused(service, updates, message):
    with pytest.raises(ValueError, match=message):
        service(updates=updates)


def test_a_missing_required_key_is_refused(service):
    root = service.root
    config = yaml.safe_load((root / "service.yml").read_text())
    del config["caller"]
    (root / "service.yml").write_text(yaml.safe_dump(config))
    with pytest.raises(ValueError, match="invalid_service_config: missing caller"):
        service()


def test_the_v2_example_config_has_no_legacy_key_and_the_service_starts(service):
    config = yaml.safe_load((service.root / "service.yml").read_text())
    assert config["config_version"] == 2
    assert not set(config) & set(LEGACY_VALUES)
    assert service().capabilities_public()["capabilities"]


# --- execution limits ----------------------------------------------------------------------------


def test_execution_defaults_send_only_a_deadline_and_derive_the_ipc_cap():
    execution = execution_from_config({})
    assert execution.limits == {"deadlineMs": 120000}
    assert execution.call_timeout_s == 160
    assert execution.max_sql_attempts == 6


def test_execution_fields_map_to_the_runtime_contract():
    execution = execution_from_config(
        {
            "execution": {
                "deadline_ms": 90000,
                "max_tokens": 8192,
                "thinking": "off",
                "max_turns": 8,
                "max_tool_calls": 20,
                "provider_max_retries": 2,
                "provider_max_retry_delay_ms": 4000,
                "max_sql_attempts": 3,
            }
        }
    )
    assert execution.limits == {
        "deadlineMs": 90000,
        "maxTokens": 8192,
        "maxTurns": 8,
        "maxToolCalls": 20,
        "providerMaxRetries": 2,
        "providerMaxRetryDelayMs": 4000,
        "enableThinking": False,
    }
    assert execution.call_timeout_s == 130
    assert execution.max_sql_attempts == 3
    assert execution_from_config({"execution": {"thinking": "on"}}).limits["enableThinking"] is True
    # A bare on/off in YAML is a boolean.
    assert execution_from_config({"execution": {"thinking": False}}).limits["enableThinking"] is False
    assert "enableThinking" not in execution_from_config({"execution": {"thinking": "default"}}).limits


@pytest.mark.parametrize(
    "execution",
    [
        {"deadline_ms": 4999},
        {"deadline_ms": 600001},
        {"deadline_ms": "120000"},
        {"deadline_ms": True},
        {"max_tokens": 255},
        {"max_turns": 0},
        {"max_tool_calls": 257},
        {"provider_max_retries": 9},
        {"provider_max_retry_delay_ms": 99},
        {"max_sql_attempts": 0},
        {"thinking": "maybe"},
        {"reasoning_budget_tokens": 100},
        "fast",
    ],
)
def test_invalid_execution_values_are_refused(execution):
    with pytest.raises(ValueError, match="invalid_execution_config"):
        execution_from_config({"execution": execution})


def test_execution_limits_passthrough(service, monkeypatch):
    monkeypatch.delenv("WREN_IPC_CALL_TIMEOUT_S", raising=False)
    s = service(runtime_path=FAKE_RUNTIME)
    init = s.ipc.call("echo_init")
    assert init["limits"] == {"deadlineMs": 120000}
    assert "enableThinking" not in init["limits"]
    assert init["model"]["apiKey"] == "<redacted>"
    assert s.ipc._timeout() == 160
    tuned = service(
        runtime_path=FAKE_RUNTIME,
        updates={
            "execution": {
                "deadline_ms": 60000,
                "max_tokens": 8192,
                "thinking": "off",
                "max_turns": 6,
                "provider_max_retries": 2,
            }
        },
    )
    assert tuned.ipc.call("echo_init")["limits"] == {
        "deadlineMs": 60000,
        "maxTokens": 8192,
        "maxTurns": 6,
        "providerMaxRetries": 2,
        "enableThinking": False,
    }
    assert tuned.ipc._timeout() == 100
    monkeypatch.setenv("WREN_IPC_CALL_TIMEOUT_S", "7")
    assert tuned.ipc._timeout() == 7


def test_a_runtime_accepts_every_execution_field(service):
    full = {
        "deadline_ms": 30000,
        "max_tokens": 2048,
        "thinking": "on",
        "max_turns": 6,
        "max_tool_calls": 12,
        "provider_max_retries": 1,
        "provider_max_retry_delay_ms": 500,
        "max_sql_attempts": 4,
    }
    assert service(updates={"execution": full}).capabilities_public()["capabilities"]


def test_the_worker_tool_declarations_reach_the_runtime(service):
    s = service(runtime_path=FAKE_RUNTIME)
    names = [t["name"] for t in s.ipc.call("echo_init")["tools"]]
    assert names == [
        "list_context",
        "select_context",
        "read_context",
        "query",
        "run_sql",
        "describe_data",
        "clarify",
    ]


def test_the_staged_bundle_carries_the_loader_prepared_document(tmp_path):
    bundle = tmp_path / "bundle"
    shutil_copy = __import__("shutil").copytree
    shutil_copy(EXAMPLES / "profiles/analysis", bundle)
    assert not (bundle / "context.json").exists()
    staged = (tmp_path / "staged").resolve()
    stage_bundle(bundle, staged, {"context_version": 2, "parseable": True, "x": 1})
    assert json.loads((staged / "context.json").read_text())["x"] == 1
    assert not (bundle / "context.json").exists()


# --- denied columns across the service surface ---------------------------------------------------


def test_a_denied_column_is_absent_from_planner_worker_and_description(service, monkeypatch):
    s = service(selection=["structure", "rules"])
    planner = json.dumps(s.metadata(None, ["structure", "rules"], "planner"))
    assert "email" not in planner.lower()
    seen = {}

    def invoke(callback):
        seen["list"] = callback("list_context", {})
        seen["read"] = callback("read_context", {"ids": ["customers", "orders"]})
        seen["rule"] = callback("read_context", {"ids": ["rule:knowledge/rules/conventions.md"]})
        out = callback("describe_data", {})
        seen["describe"] = out["result"]
        return {"evidence": out["evidence"]}

    install_invoker(monkeypatch, s, invoke)
    r = ask_request(s)
    s.execute(r)
    assert "email" not in json.dumps(seen).lower()
    assert [c["name"] for c in seen["read"]["items"][0]["columns"]] == ["id", "region"]
    request_payload = []
    real = s.ipc.call
    monkeypatch.setattr(
        s.ipc,
        "call",
        lambda op, **kw: request_payload.append(kw.get("request")) or real(op, **kw)
        if op != "invoke"
        else (request_payload.append(kw["request"]), {"evidence": "x"})[1],
    )
    with pytest.raises(ValueError, match="invalid_evidence"):
        s.execute(ask_request(s))
    index = json.loads(request_payload[-1])["context_index"]
    assert "model orders" in index and "email" not in index.lower()
    assert "context_documents" not in json.loads(request_payload[-1])


def test_worker_context_tools_authorize_and_audit_the_selection(service, monkeypatch, tmp_path):
    sink = tmp_path / "audit.jsonl"
    s = service(updates={"audit_path": str(sink)})

    def invoke(callback):
        assert callback("select_context", {"ids": ["orders"]}) == {"selected": ["orders"]}
        assert callback("select_context", {"ids": ["nope"]})["error"] == "unknown_context_id"
        assert callback("list_context", {"page": 9})["error"] == "page_out_of_range"
        assert callback("read_context", {"ids": "orders"})["error"] == "invalid_ids"
        for bad in ({"documents": ["structure"]}, {}):
            with pytest.raises(ValueError, match="invalid_request"):
                callback("read_context", bad)
        return callback("query", {"model": "orders"})

    install_invoker(monkeypatch, s, invoke)
    assert s.execute(ask_request(s))["status"] == "completed"
    events = [json.loads(x) for x in sink.read_text().splitlines()]
    assert any(e.get("event") == "context_select" and e["ids"] == ["orders"] for e in events)


def test_a_policy_can_deny_the_worker_the_rules_category(service, monkeypatch):
    s = service(
        policy='forbid(principal, action == Service::Action::"receive_metadata", resource) when { principal.role == "worker" && resource.kind == "knowledge.rules" };'
    )
    install_invoker(monkeypatch, s, lambda cb: cb("query", {"model": "orders"}))
    with pytest.raises(PermissionError):
        s.execute(ask_request(s))


def test_http_transport_requires_loopback_and_local_token(service):
    from wren.agent_service import http_server  # noqa: PLC0415

    s = service(updates={"policy_presets": PRESETS}, preset="structure")
    with pytest.raises(ValueError, match="local_token_required"):
        http_server(build_mcp(s), "127.0.0.1", 0, "")
    with pytest.raises(ValueError, match="loopback_only"):
        http_server(build_mcp(s), "0.0.0.0", 0, "secret")


def test_http_transport_serves_capabilities_behind_token(service):
    import threading  # noqa: PLC0415

    import httpx  # noqa: PLC0415
    from mcp import ClientSession  # noqa: PLC0415
    from mcp.client.streamable_http import streamablehttp_client  # noqa: PLC0415

    from wren.agent_service import http_server  # noqa: PLC0415

    s = service(
        selection=["structure", "rules"],
        updates={"policy_presets": PRESETS, "default_preset": "hidden"},
        preset="structure",
    )
    server, sock = http_server(build_mcp(s), "127.0.0.1", 0, "local-secret")
    port = sock.getsockname()[1]
    thread = threading.Thread(target=server.run, kwargs={"sockets": [sock]})
    thread.start()
    url = f"http://127.0.0.1:{port}/mcp"
    try:
        probe = {"jsonrpc": "2.0", "id": 1, "method": "tools/list"}
        headers = {"Accept": "application/json, text/event-stream"}
        assert httpx.post(url, json=probe, headers=headers).status_code == 401
        wrong = {**headers, "Authorization": "Bearer other"}
        assert httpx.post(url, json=probe, headers=wrong).status_code == 401

        async def call():
            auth = {"Authorization": "Bearer local-secret"}
            async with streamablehttp_client(url, headers=auth) as (r, w, _):
                async with ClientSession(r, w) as session:
                    await session.initialize()
                    names = {t.name for t in (await session.list_tools()).tools}
                    out = await session.call_tool("capabilities", {})
                    return names, json.loads(out.content[0].text)

        names, public = asyncio.run(call())
        assert "capabilities" in names and "ask_data" not in names
        assert public["policy_preset"] == {
            "name": "structure",
            "available": ["full", "hidden", "rules", "structure"],
        }
        assert [d["id"] for d in public["metadata_documents"]] == ["structure"]
    finally:
        server.should_exit = True
        thread.join(timeout=10)
    assert not thread.is_alive()


def test_audit_path_streams_json_lines_before_shutdown(service, tmp_path):
    sink = tmp_path / "audit.jsonl"
    s = service(selection=["structure"], updates={"audit_path": str(sink)})
    assert s.metadata(None, ["structure"], "planner")
    lines = [json.loads(x) for x in sink.read_text().splitlines()]
    assert lines[0]["event"] == "context_loaded"
    assert any(e.get("event") == "metadata_read" for e in lines)
    assert any(e.get("action") == "receive_metadata" and e.get("allowed") is True for e in lines)
    with pytest.raises(FileExistsError):
        service(updates={"audit_path": str(sink)})
    s.shutdown()
    assert s.audit_sink is None
    assert [json.loads(x) for x in sink.read_text().splitlines()] == lines


def test_audit_records_task_outcomes(service, monkeypatch, tmp_path):
    sink = tmp_path / "outcomes.jsonl"
    s = service(updates={"audit_path": str(sink)})
    r = request(s)
    execute(s, r)
    events = [json.loads(x) for x in sink.read_text().splitlines()]
    done = [e for e in events if e.get("event") == "task_completed"]
    assert done and done[-1]["status"] == "completed"

    install_invoker(monkeypatch, s, lambda callback: {"value": 9999, "text": "x"})
    bad = ask_request(s)
    with pytest.raises(ValueError, match="invalid_evidence"):
        s.execute(bad)
    events = [json.loads(x) for x in sink.read_text().splitlines()]
    failed = [e for e in events if e.get("event") == "task_failed"]
    assert failed[-1]["reason"] == "invalid_evidence"
    assert failed[-1]["raw_keys"] == ["text", "value"]
    assert "9999" not in sink.read_text()

    def boom(callback):
        err = RuntimeError("runtime_unavailable")
        err.detail = "provider_http 429"
        raise err

    install_invoker(monkeypatch, s, boom)
    with pytest.raises(RuntimeError, match="runtime_unavailable"):
        s.execute(ask_request(s))
    events = [json.loads(x) for x in sink.read_text().splitlines()]
    failed = [e for e in events if e.get("event") == "task_failed"]
    assert failed[-1]["reason"] == "runtime_unavailable"
    assert failed[-1]["detail"] == "provider_http 429"


@pytest.mark.parametrize(
    ("detail", "reason"),
    [
        ("service_unavailable:provider_http", "provider"),
        ("service_unavailable:provider_stream", "provider"),
        ("service_unavailable:cancelled", "timeout"),
        ("service_unavailable:deadline", "timeout"),
        ("ipc_timeout:host", "timeout"),
        ("service_unavailable:invalid_json", "worker"),
        ("service_unavailable:turn_limit", "worker"),
        ("service_unavailable", "service"),
        (None, "service"),
    ],
)
def test_unavailable_carries_a_coarse_reason(service, monkeypatch, detail, reason):
    from wren.agent_service import safe  # noqa: PLC0415

    s = service()

    def boom(callback):
        err = RuntimeError("runtime_unavailable")
        if detail is not None:
            err.detail = detail
        raise err

    install_invoker(monkeypatch, s, boom)
    out = asyncio.run(safe(s.execute, ask_request(s)))
    assert out == {"status": "unavailable", "reason": reason}


def test_invalid_evidence_is_a_worker_reason_and_denied_stays_bare(service, monkeypatch):
    from wren.agent_service import safe  # noqa: PLC0415

    s = service()
    install_invoker(monkeypatch, s, lambda callback: {"value": 1})
    assert asyncio.run(safe(s.execute, ask_request(s))) == {
        "status": "unavailable",
        "reason": "worker",
    }
    denied = asyncio.run(safe(s.metadata, None, ["rules"], "planner"))
    assert denied == {"status": "denied"}


def test_describe_data_discloses_a_host_generated_summary(service, monkeypatch):
    root = service.root
    model = root / "models/orders/metadata.yml"
    config = yaml.safe_load(model.read_text())
    config["properties"]["description"] = (
        "Customer orders. One row per order header. Migrated copies carry legacy_ord_id."
    )
    model.write_text(yaml.safe_dump(config, sort_keys=False))
    customers = root / "models/customers/metadata.yml"
    config = yaml.safe_load(customers.read_text())
    config["properties"] = {}
    customers.write_text(yaml.safe_dump(config, sort_keys=False))
    (root / "target/mdl.json").write_text(json.dumps(build_json(root)))
    s = service()
    seen = {}

    def invoke(callback):
        out = callback("describe_data", {})
        seen.update(out)
        return {"evidence": out["evidence"]}

    install_invoker(monkeypatch, s, invoke)
    r = ask_request(s)
    done = s.execute(r)
    assert done["status"] == "completed"
    text = done["result"]["text"]
    assert done["result"]["kind"] == "text" and seen["result"] == done["result"]
    assert "orders: Customer orders. One row per order header." in text
    assert "legacy_ord_id" not in text and "- customers" in text
    ev = s.evidence(Ref(session_id=r.session_id, evidence_ref=done["evidence_ref"]))
    assert ev["result"]["kind"] == "text"
    with pytest.raises(ValueError, match="invalid_request"):
        install_invoker(monkeypatch, s, lambda cb: cb("describe_data", {"x": 1}))
        s.execute(
            Ask(
                session_id=r.session_id,
                request_id="d2",
                expected_revision=done["revision"],
                capability="orders",
                question="what data",
            )
        )


def test_describe_data_has_its_own_disclosure_gate(service, monkeypatch):
    s = service(
        policy='forbid(principal, action == Service::Action::"receive_answer", resource) when { resource.kind == "answer.description" };'
    )
    install_invoker(monkeypatch, s, lambda cb: {"evidence": cb("describe_data", {})["evidence"]})
    with pytest.raises(PermissionError):
        s.execute(ask_request(s))
    s2 = service(policy='forbid(principal, action == Service::Action::"invoke_tool", resource) when { resource.name == "describe_data" };')
    install_invoker(monkeypatch, s2, lambda cb: {"evidence": cb("describe_data", {})["evidence"]})
    with pytest.raises(PermissionError):
        s2.execute(ask_request(s2))
