#!/usr/bin/env node
// A scripted stand-in for the private runtime (`warble-private-service/1`), for host tests that
// must observe what the host sends, not what a model does. It speaks the same line-delimited
// JSON protocol on stdin/stdout:
//
//   init       -> {protocol, ir: "0.9", schema: "1"}; the payload is kept (apiKey redacted)
//   authorize  -> true (no policy is evaluated here)
//   cancel     -> true; marks the owner cancelled
//   invoke     -> behaviour chosen by the JSON in `request` (see below)
//   echo_init  -> the stored init payload, so a test can assert `limits` and the rest
//   hang       -> never replies
//   stray      -> replies with an id the host never sent (a protocol violation)
//   ops        -> every op and tool_result received so far, in order (`ops` itself excluded)
//
// `invoke` behaviours (`request` is a JSON string with a "behavior" key):
//   "evidence" (default) reply {evidence: "fake-token"}
//   "echo"               reply the parsed request
//   "hang"               never reply
//   "late_tool_call"     hang until cancelled, then send a tool_call and a late reply for the
//                        cancelled owner, as a real runtime can before it notices the cancel
//   "with_calls"         reply {value, calls}: the usage envelope of a limits-aware runtime
//   "slow"               reply after `delay_ms`
const readline = require("node:readline");

const PROTOCOL = "warble-private-service/1";
let init = null;
const seen = [];
const cancelled = new Set();
const waiting = new Map();
let sequence = 0;

const send = (value) => process.stdout.write(JSON.stringify(value) + "\n");

function redacted(message) {
  const copy = JSON.parse(JSON.stringify(message));
  if (copy.model && copy.model.apiKey) copy.model.apiKey = "<redacted>";
  return copy;
}

function parseRequest(raw) {
  try {
    const value = JSON.parse(raw);
    return value && typeof value === "object" ? value : {};
  } catch {
    return {};
  }
}

function invoke(m) {
  const request = parseRequest(m.request);
  switch (request.behavior || "evidence") {
    case "echo":
      return send({ id: m.id, value: request });
    case "hang":
      return;
    case "with_calls":
      return send({
        id: m.id,
        value: { evidence: "fake-token" },
        calls: [{ turn: 1, elapsedMs: 5, input: 1, output: 2, reasoning: 0, cacheRead: 0, stopReason: "stop", rawStopReason: "stop", toolCalls: 0, status: "ok" }],
      });
    case "late_tool_call":
      waiting.set(m.id, () => {
        send({ type: "tool_call", id: ++sequence, owner: m.id, name: "late", args: {} });
        send({ id: m.id, value: { evidence: "late" } });
      });
      return;
    case "slow":
      return void setTimeout(
        () => !cancelled.has(m.id) && send({ id: m.id, value: { evidence: "fake-token" } }),
        Number(request.delay_ms || 100),
      );
    default:
      return send({ id: m.id, value: { evidence: "fake-token" } });
  }
}

const lines = readline.createInterface({ input: process.stdin });
lines.on("line", (line) => {
  const m = JSON.parse(line);
  if (m.type === "tool_result") {
    seen.push({ type: "tool_result", owner: m.owner, error: m.error || null });
    return;
  }
  if (m.op !== "ops" && m.op !== "echo_init") seen.push({ op: m.op, owner: m.owner || null });
  switch (m.op) {
    case "init":
      if (init || m.protocol !== PROTOCOL) return send({ id: m.id, error: "service_unavailable" });
      init = redacted(m);
      return send({ id: m.id, value: { protocol: PROTOCOL, ir: "0.9", schema: "1" } });
    case "echo_init":
      return send({ id: m.id, value: init });
    case "ops":
      return send({ id: m.id, value: seen });
    case "authorize":
      return send({ id: m.id, value: true });
    case "cancel": {
      cancelled.add(m.owner);
      send({ id: m.id, value: true });
      const release = waiting.get(m.owner);
      if (release) {
        waiting.delete(m.owner);
        release();
      }
      return;
    }
    case "invoke":
      return invoke(m);
    case "hang":
      return;
    case "stray":
      return send({ id: "never-sent", value: 1 });
    default:
      return send({ id: m.id, error: "service_unavailable" });
  }
});
