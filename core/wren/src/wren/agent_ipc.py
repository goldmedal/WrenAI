"""Versioned private host IPC; no model-controlled executable or environment."""

from __future__ import annotations

import concurrent.futures
import json
import os
import subprocess
import threading
import uuid
from pathlib import Path

PROTOCOL = "warble-private-service/1"


class RuntimeIPC:
    def __init__(self, runtime: Path, init: dict):
        self.pending = {}
        self.callbacks = {}
        self.lock = threading.Lock()
        self.pool = concurrent.futures.ThreadPoolExecutor(max_workers=8)
        self.process = subprocess.Popen(
            ["node", str(runtime)],
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL,
            text=True,
            start_new_session=True,
            env={
                "PATH": os.environ.get("PATH", ""),
                "PI_OFFLINE": "1",
                "PI_TELEMETRY": "0",
            },
        )
        self.reader = threading.Thread(target=self._read, daemon=True)
        self.reader.start()
        try:
            hello = self.call("init", protocol=PROTOCOL, **init)
            if hello != {"protocol": PROTOCOL, "ir": "0.9", "schema": "1"}:
                raise ValueError("incompatible_runtime")
        except BaseException:
            self.close()
            raise

    def _send(self, value):
        raw = json.dumps(value, ensure_ascii=False)
        if len(raw.encode()) > 1048576:
            raise ValueError("ipc_size")
        with self.lock:
            self.process.stdin.write(raw + "\n")
            self.process.stdin.flush()

    def _tool(self, message):
        response = {
            "type": "tool_result",
            "id": message["id"],
            "owner": message["owner"],
        }
        try:
            callback = self.callbacks[message["owner"]]
            response["value"] = callback(message["name"], message["args"])
        except Exception:
            response["error"] = "tool_denied"
        try:
            self._send(response)
        except Exception:
            pass

    def _read(self):
        try:
            while True:
                line = self.process.stdout.readline(1048577)
                if not line:
                    break
                if len(line.encode()) > 1048576 or not line.endswith("\n"):
                    raise ValueError("ipc_size")
                m = json.loads(line)
                if m.get("type") == "tool_call":
                    if m.get("owner") not in self.callbacks:
                        raise ValueError("ipc_order")
                    self.pool.submit(self._tool, m)
                else:
                    future = self.pending.pop(m["id"])
                    if m.get("error"):
                        failure = RuntimeError("runtime_unavailable")
                        # Operator diagnostics only: never forwarded to a caller.
                        failure.detail = str(m["error"])[:200]
                        future.set_exception(failure)
                    else:
                        future.set_result(m["value"])
        except Exception:
            self.process.kill()
        finally:
            for future in list(self.pending.values()):
                if not future.done():
                    future.set_exception(RuntimeError("runtime_unavailable"))
            self.pending.clear()

    def call(self, op, *, callback=None, invocation_id=None, **values):
        ident = invocation_id or str(uuid.uuid4())
        future = concurrent.futures.Future()
        self.pending[ident] = future
        if callback:
            self.callbacks[ident] = callback
        try:
            self._send({"id": ident, "op": op, **values})
            return future.result(timeout=100)
        finally:
            self.callbacks.pop(ident, None)

    def cancel(self, owner):
        return self.call("cancel", **{"owner": owner})

    def close(self):
        try:
            self.process.stdin.close()
            self.process.wait(timeout=5)
        except Exception:
            self.process.kill()
            self.process.wait(timeout=5)
        self.pool.shutdown(wait=True, cancel_futures=True)
