"""Service boundary tests use real Cedar IPC and the synthetic Wren database."""

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
)


@pytest.fixture
def service(tmp_path):
    runtime, compiler = os.getenv("WARBLE_SERVICE"), os.getenv("WARBLE_BIN")
    if not runtime or not compiler:
        pytest.skip("Set WARBLE_SERVICE and WARBLE_BIN for cross-package integration")
    examples = Path(__file__).resolve().parents[4] / "examples/serve-agent"
    spec = importlib.util.spec_from_file_location(
        "setup_agent_fixture", examples / "setup.py"
    )
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    module.prepare(tmp_path / "fixture")
    root = tmp_path / "fixture/project"
    instances = []

    def make(policy="", selection=(), mode="mcp", updates=None, preset=None):
        config = yaml.safe_load((root / "service.yml").read_text())
        config["metadata_selection"] = list(selection)
        config.update(updates or {})
        config_path = root / f"service-{len(instances)}.yml"
        policy_path = root / f"policy-{len(instances)}.cedar"
        config["policy"] = policy_path.name
        policy_path.write_text((examples / "policy.cedar").read_text() + policy)
        config_path.write_text(yaml.safe_dump(config))
        s = create_service(
            root,
            examples / "profiles/analysis",
            config_path,
            Path(runtime),
            compiler,
            mode,
            policy_preset=preset,
        )
        instances.append(s)
        return s

    yield make
    for s in instances:
        s.shutdown()


def request(s, grain="week", **kwargs):
    o = s.open()
    return Direct(
        session_id=o["session_id"],
        request_id="one",
        expected_revision=0,
        capability="orders",
        query=Query(grain=grain, **kwargs),
    )


def execute(s, r):
    return s.execute(r, direct=r.query.model_dump())


def test_real_weekly_total_range_and_evidence(service):
    s = service()
    r = request(s)
    result = execute(s, r)
    assert [x["order_count"] for x in result["result"]["rows"]] == [3, 4, 5]
    evidence = s.evidence(
        Ref(session_id=r.session_id, evidence_ref=result["evidence_ref"])
    )
    assert evidence["result"] == result["result"]
    assert "sql" not in json.dumps(evidence)
    assert execute(s, request(s, "total"))["result"]["rows"] == [{"order_count": 12}]
    assert (
        execute(s, request(s, start="2026-01-05", end="2026-01-12"))["result"]["rows"][
            0
        ]["order_count"]
        == 4
    )


def test_private_rule_result_without_rule_disclosure(service):
    s = service()
    r = request(s).model_copy(
        update={
            "capability": "targets",
            "query": Query(grain="week", rule="weekly-target"),
        }
    )
    assert [x["met_target"] for x in execute(s, r)["result"]["rows"]] == [
        False,
        True,
        True,
    ]
    with pytest.raises(PermissionError):
        s.metadata(None, ["rules"], "planner")
    assert s.metadata(None, ["rules"], "worker")


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


def test_scope_intersection_and_sql_rejection(service):
    s = service(updates={"query_scope": {"start": "2026-01-05", "end": "2026-01-12"}})
    assert execute(s, request(s, "total", start="2025-01-01"))["result"]["rows"] == [
        {"order_count": 4}
    ]
    for sql in (
        "SELECT * FROM orders",
        "SELECT * FROM customers",
        "DROP TABLE orders",
        "SELECT read_csv('/etc/passwd')",
        "SELECT COUNT(*) FROM orders; SELECT 1",
    ):
        with pytest.raises(PermissionError):
            s.project.parse_sql(sql)
    _, sql, _ = s.project.plan({"grain": "week"}, {"rules": False})
    assert s.project.parse_sql(sql) == {"grain": "week"}


def test_idempotency_conflict_and_ownership(service):
    s = service()
    r = request(s)
    result = execute(s, r)
    assert execute(s, r) == result
    with pytest.raises(ValueError, match="conflict"):
        execute(s, r.model_copy(update={"query": Query(grain="total")}))
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
    (s.project.root / "metadata/rules.md").write_text("changed")
    with pytest.raises(ValueError, match="context_changed"):
        s.evidence(Ref(session_id=r.session_id, evidence_ref=result["evidence_ref"]))
    assert s.sessions[r.session_id]["closed"]


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
        Query(grain="week", threshold=True)
    with pytest.raises(ValidationError):
        Query(grain="week", sql="select secret")


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
        question="Weekly report",
    )


@pytest.mark.parametrize("corruption", ["extra", "forged", "number"])
def test_worker_output_requires_host_minted_evidence(service, monkeypatch, corruption):
    s = service()

    def invoke(callback):
        token = callback("query", {"grain": "week"})
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
    s = service(updates={"rules": {}})
    install_invoker(
        monkeypatch, s, lambda cb: cb("clarify", {"missing": "weekly_target"})
    )
    r = ask_request(s, "targets")
    response = s.execute(r)
    assert response["status"] == "needs_clarification"
    install_invoker(
        monkeypatch, s, lambda cb: cb("query", {"grain": "week", "threshold": 4})
    )
    c = Continue(
        session_id=r.session_id,
        request_id="answer-1",
        expected_revision=1,
        continuation_ref=response["continuation_ref"],
        answer="4",
    )
    completed = s.continue_task(c)
    assert [row["met_target"] for row in completed["result"]["rows"]] == [
        False,
        True,
        True,
    ]
    assert s.continue_task(c) == completed
    with pytest.raises(ValueError):
        s.continue_task(
            c.model_copy(update={"request_id": "answer-2", "expected_revision": 2})
        )


def test_close_suppresses_late_completion(service, monkeypatch):
    s = service()
    r = ask_request(s)

    def invoke(callback):
        raw = callback("query", {"grain": "week"})
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
        return callback("query", {"grain": "week"})

    install_invoker(monkeypatch, s, invoke)
    with concurrent.futures.ThreadPoolExecutor() as pool:
        active = pool.submit(s.execute, r)
        assert entered.wait(5)
        with pytest.raises(ValueError, match="conflict"):
            s.execute(r.model_copy(update={"request_id": "parallel"}))
        assert s.session(other)["revision"] == 0
        finish.set()
        assert active.result()["status"] == "completed"


def test_weekly_range_rejects_partial_sunday(service):
    s = service()
    with pytest.raises(ValueError, match="weekly_bounds_must_be_mondays"):
        execute(s, request(s, start="2026-01-05", end="2026-01-11"))


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
    r = request(s).model_copy(
        update={
            "capability": "targets",
            "query": Query(grain="week", rule="weekly-target"),
        }
    )
    result = execute(s, r)
    internal = s.sessions[r.session_id]["evidence"][result["evidence_ref"]]["internal"]
    assert internal["rule_version"] == s.project.version
    assert "COUNT(*)" in internal["sql"]
    public = s.evidence(
        Ref(session_id=r.session_id, evidence_ref=result["evidence_ref"])
    )
    assert "internal" not in public and "weekly-target" not in json.dumps(public)


def test_private_query_policy_denial_remains_denied(service, monkeypatch):
    s = service(
        policy='forbid(principal, action == Service::Action::"execute_query", resource);'
    )

    def invoke(callback):
        try:
            return callback("query", {"grain": "week"})
        except PermissionError:
            raise RuntimeError("runtime_unavailable") from None

    install_invoker(monkeypatch, s, invoke)
    with pytest.raises(PermissionError, match="denied"):
        s.execute(ask_request(s))


def test_existing_private_rule_prevents_false_missing_rule_clarification(
    service, monkeypatch
):
    s = service()

    def invoke(callback):
        hint = callback("clarify", {"missing": "weekly_target"})
        assert hint["error"] == "project_rule_available"
        assert "evidence" not in hint
        docs = callback("read_context", {"documents": ["rules"]})
        assert docs
        return callback("query", {"grain": "week", "rule": "weekly-target"})

    install_invoker(monkeypatch, s, invoke)
    result = s.execute(ask_request(s, "targets"))
    assert result["status"] == "completed"
    assert [x["met_target"] for x in result["result"]["rows"]] == [False, True, True]


def test_count_report_recovers_from_inapplicable_target_clarification(
    service, monkeypatch
):
    s = service()

    def invoke(callback):
        rejected = callback("clarify", {"missing": "weekly_target"})
        assert rejected["error"] == "clarification_not_applicable"
        assert "evidence" not in rejected
        # No permission to run target calculations was added by the correction.
        with pytest.raises(PermissionError):
            s.project.plan({"grain": "week", "rule": "weekly-target"}, {"rules": False})
        return callback("query", {"grain": "week"})

    install_invoker(monkeypatch, s, invoke)
    result = s.execute(ask_request(s))
    assert result["status"] == "completed"
    assert [x["order_count"] for x in result["result"]["rows"]] == [3, 4, 5]


def test_result_and_evidence_disclose_effective_scope_not_unbounded_request(service):
    s = service(updates={"query_scope": {"start": "2026-01-05", "end": "2026-01-12"}})
    r = request(s, "total", start="2025-01-01")
    result = execute(s, r)
    expected = {"start": "2026-01-05", "end": "2026-01-12"}
    assert result["result"]["scope"] == expected
    evidence = s.evidence(
        Ref(session_id=r.session_id, evidence_ref=result["evidence_ref"])
    )
    assert evidence["conditions"] == expected
    assert result["result"]["rows"] == [{"order_count": 4}]


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


def test_policy_preset_overrides_scope_and_policy_file(service):
    s = service(updates={"policy_presets": PRESETS})
    root = s.project.root
    narrow = root / "preset-policy.cedar"
    narrow.write_text(
        (root / s.config["policy"]).read_text() + NO_PLANNER_METADATA
    )
    presets = {
        **PRESETS,
        "q1": {
            "metadata_selection": ["structure", "rules"],
            "policy": narrow.name,
            "query_scope": {"start": "2026-01-05", "end": "2026-01-12"},
        },
    }
    s = service(updates={"policy_presets": presets}, preset="q1")
    assert s.project.effective_range(Query(grain="total")) == {
        "start": "2026-01-05",
        "end": "2026-01-12",
    }
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
    assert any(e.get("event") == "metadata_read" for e in lines)
    assert any(e.get("action") == "receive_metadata" and e.get("allowed") is True for e in lines)
    with pytest.raises(FileExistsError):
        service(updates={"audit_path": str(sink)})
    s.shutdown()
    assert s.audit_sink is None
    assert [json.loads(x) for x in sink.read_text().splitlines()] == lines
