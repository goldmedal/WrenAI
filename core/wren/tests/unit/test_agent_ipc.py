"""Host-side IPC behaviour against a scripted runtime (no model, no Warble)."""

import json
import shutil
import time
from pathlib import Path

import pytest

from wren.agent_ipc import PROTOCOL, RuntimeIPC

FAKE_RUNTIME = Path(__file__).parent / "fixtures/fake_runtime.js"

pytestmark = pytest.mark.skipif(shutil.which("node") is None, reason="needs node")


@pytest.fixture
def ipc(monkeypatch):
    monkeypatch.delenv("WREN_IPC_CALL_TIMEOUT_S", raising=False)
    made = []

    def make(init=None, **kwargs):
        runtime = RuntimeIPC(FAKE_RUNTIME, init or {"model": {"apiKey": "secret"}}, **kwargs)
        made.append(runtime)
        return runtime

    yield make
    for runtime in made:
        runtime.close()


def invoke(ipc, behavior, ident, **extra):
    return ipc.call(
        "invoke",
        request=json.dumps({"behavior": behavior, **extra}),
        invocation_id=ident,
        callback=lambda name, args: "ok",
    )


def ops(ipc):
    return ipc.call("ops")


def test_the_handshake_passes_the_init_payload_through_and_redacts_the_key(ipc):
    limits = {"deadlineMs": 120000, "maxTurns": 6}
    runtime = ipc({"model": {"apiKey": "secret", "id": "m"}, "limits": limits})
    echoed = runtime.call("echo_init")
    assert echoed["protocol"] == PROTOCOL
    assert echoed["limits"] == limits
    assert echoed["model"] == {"apiKey": "<redacted>", "id": "m"}


def test_the_call_cap_is_the_given_default_unless_the_environment_overrides_it(ipc, monkeypatch):
    runtime = ipc(call_timeout_s=160)
    assert runtime._timeout() == 160
    assert ipc().call_timeout_s == 100
    monkeypatch.setenv("WREN_IPC_CALL_TIMEOUT_S", "7")
    assert runtime._timeout() == 7


def test_a_host_timeout_sends_cancel_clears_pending_and_keeps_the_runtime(ipc, monkeypatch):
    monkeypatch.setenv("WREN_IPC_CALL_TIMEOUT_S", "0.4")
    runtime = ipc()
    with pytest.raises(RuntimeError, match="runtime_unavailable") as raised:
        invoke(runtime, "hang", "inv-1")
    assert raised.value.detail == "ipc_timeout:host"
    assert "inv-1" not in runtime.pending
    seen = ops(runtime)
    assert {"op": "cancel", "owner": "inv-1"} in [
        {"op": o.get("op"), "owner": o.get("owner")} for o in seen
    ]
    assert runtime.process.poll() is None
    assert runtime.call("authorize", request={}) is True


def test_a_late_tool_call_and_reply_after_the_timeout_do_not_kill_the_runtime(ipc, monkeypatch):
    monkeypatch.setenv("WREN_IPC_CALL_TIMEOUT_S", "0.4")
    runtime = ipc()
    with pytest.raises(RuntimeError):
        invoke(runtime, "late_tool_call", "inv-2")
    deadline = time.monotonic() + 5
    while time.monotonic() < deadline:
        denied = [o for o in ops(runtime) if o.get("type") == "tool_result"]
        if denied:
            break
        time.sleep(0.05)
    assert denied == [{"type": "tool_result", "owner": "inv-2", "error": "tool_denied"}]
    time.sleep(0.2)
    assert runtime.process.poll() is None
    assert runtime.call("authorize", request={}) is True


def test_a_non_invoke_timeout_clears_pending_without_a_cancel(ipc, monkeypatch):
    runtime = ipc()
    monkeypatch.setenv("WREN_IPC_CALL_TIMEOUT_S", "0.3")
    with pytest.raises(RuntimeError) as raised:
        runtime.call("hang", invocation_id="x-1")
    assert raised.value.detail == "ipc_timeout:host"
    assert "x-1" not in runtime.pending
    assert not any(o.get("op") == "cancel" for o in ops(runtime))
    assert runtime.process.poll() is None


def test_an_invocation_id_still_pending_or_abandoned_cannot_be_reused(ipc, monkeypatch):
    monkeypatch.setenv("WREN_IPC_CALL_TIMEOUT_S", "0.3")
    runtime = ipc()
    with pytest.raises(RuntimeError):
        invoke(runtime, "hang", "inv-9")
    assert "inv-9" in runtime.abandoned
    with pytest.raises(ValueError, match="invalid_invocation_id"):
        invoke(runtime, "hang", "inv-9")
    assert "inv-9" not in runtime.pending
    runtime.pending["inv-10"] = object()
    with pytest.raises(ValueError, match="invalid_invocation_id"):
        invoke(runtime, "hang", "inv-10")
    runtime.pending.pop("inv-10")
    assert runtime.process.poll() is None
    assert runtime.call("authorize", request={}) is True


def test_a_reply_for_an_id_the_host_never_sent_is_still_a_protocol_violation(ipc):
    runtime = ipc()
    runtime._send({"id": "s-1", "op": "stray"})
    assert runtime.process.wait(timeout=5) != 0


def test_the_usage_envelope_of_a_limits_aware_runtime_never_reaches_the_caller(ipc):
    runtime = ipc()
    assert invoke(runtime, "with_calls", "inv-3") == {"evidence": "fake-token"}


def test_an_abort_ends_the_wait_now_and_drops_whatever_the_runtime_sends_later(ipc):
    import threading  # noqa: PLC0415

    from wren.agent_ipc import TaskAborted  # noqa: PLC0415

    runtime = ipc()
    outcome = []

    def waiting():
        try:
            outcome.append(invoke(runtime, "late_tool_call", "inv-abort"))
        except Exception as exc:  # noqa: BLE001
            outcome.append(exc)

    thread = threading.Thread(target=waiting)
    thread.start()
    deadline = time.monotonic() + 5
    while "inv-abort" not in runtime.pending and time.monotonic() < deadline:
        time.sleep(0.02)
    runtime.abort("inv-abort")
    thread.join(timeout=5)
    assert not thread.is_alive()
    assert len(outcome) == 1 and isinstance(outcome[0], TaskAborted)
    assert "inv-abort" not in runtime.pending and "inv-abort" in runtime.abandoned
    # The fake answers the cancel with a late tool call and a late reply for the same task:
    # the first is refused, the second is dropped, and the runtime keeps running.
    deadline = time.monotonic() + 5
    while time.monotonic() < deadline:
        seen = ops(runtime)
        if any(o.get("type") == "tool_result" for o in seen):
            break
        time.sleep(0.05)
    assert {"op": "cancel", "owner": "inv-abort"} in [
        {"op": o.get("op"), "owner": o.get("owner")} for o in seen
    ]
    assert [o["error"] for o in seen if o.get("type") == "tool_result"] == ["tool_denied"]
    time.sleep(0.2)
    assert runtime.process.poll() is None
    assert runtime.call("authorize", request={}) is True
