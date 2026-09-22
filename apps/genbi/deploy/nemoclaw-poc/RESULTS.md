# POC evidence — 2026-09-22

Host: macOS Apple Silicon, OrbStack (Docker 29.4). NemoClaw v0.0.124, OpenShell 0.0.116, OpenClaw 2026.7.1.
Sandbox `genbi-poc`: Debian 13 **aarch64**, user `sandbox` (uid 998), `HOME=/sandbox`, Python 3.13, Node, no GPU.
Model: `nvidia/nemotron-3-super-120b-a12b` via NVIDIA endpoints through `inference.local`.

**Headline:** a repo-defined blueprint stood up an OpenClaw agent in a NemoClaw-managed sandbox that answered a GenBI
question with a real `wren` query over a Wren project — no GenBI server involved. The answer matched the golden
numbers exactly. See `evidence-agent-turn.json`.

| # | Question | Result |
| --- | --- | --- |
| 1 | Onboard on macOS with NVIDIA endpoints + Nemotron; time-to-ready | ✅ Non-interactive install + onboard exit 0 in **1818 s** (sandbox creation ≈ 1300 s of that). `status`: Phase Ready, inference healthy (route and upstream). |
| 2 | Custom agent + workspace picked up; survives `rebuild` | ✅ picked up live: `nemoclaw genbi-poc agents add genbi_answer --workspace … --model … --non-interactive --json`; `agents list` shows `main` + `genbi_answer`. **Rebuild #1 aborted** at the pre-backup audit: "symlinks or special files found in state dirs" — the Python venv inside `workspace-genbi_answer` (`.venv/bin/python → /usr/bin/python3`, `lib64 → lib`); NemoClaw refused to back up and stopped to prevent data loss (incomplete snapshot kept under `~/.nemoclaw/rebuild-backups/`). After moving the venv to `/sandbox/.openclaw/genbi-venv` (not a state dir; workspace has 0 symlinks), **rebuild #2 completed in 105 s**: `State restored (13 directories, 1 files)`. Post-rebuild: `genbi_answer` listed; workspace files, project and `target/mdl.json` present; `mcp.servers.wren` and the per-agent `tools` policy still in `openclaw.json`; the OpenShell-direct cgroup rule still effective (`cat /sys/fs/cgroup/memory.max` → `max`); the venv outside the state dir also survived. **Lost:** `~/.wren/profiles.yml` (`/sandbox/.wren` is not a state path) → `wren serve mcp` could not start and the agent failed with `No callable tools remain after resolving explicit tool allowlist`. Fix: `WREN_HOME=<workspace>/.wren` for the project build and in the MCP server env; profiles then live in the preserved workspace. |
| 3 | Per-agent `tools.allow/deny` restricts MCP / exec | ✅ Applied live with `openclaw config patch --file agents-tools.patch.json5` (`agents.list[genbi_answer].tools = {profile: minimal, allow: [12 wren__* names], deny: [write, edit, exec, read, …]}`; "Change will apply without restarting the gateway"). Asked to create a file → reply: "I do not have access to file creation or shell tools. My available tools are limited to the Wren semantic layer tools (wren__*)"; no tool call, no file. Data question still works: `wren__list_models → wren__describe_model → wren__run_sql` → starter 35 / team 42 / enterprise 43 == direct query. Input tokens fell from 52 614 (default tools) to 28 762. MCP tools are named `wren__<tool>`. |
| 4 | `wren` installs and OpenClaw calls it (stdio MCP) | ✅ with two fixes. (a) `wren-core-py 0.8.0` has no linux/aarch64 wheel → built one natively in Docker (`rust:1.94-bookworm` + maturin, `wren_core_py-0.8.0-cp311-abi3-linux_aarch64.whl`, ~7 min) and installed it plus `wrenai[mcp]==0.13.0` into a venv **under the agent workspace**. (b) `wrenai`'s `mcp` extra is unpinned and resolves `mcp` 2.x, which removed `mcp.server.fastmcp` → `pip install 'mcp<2'`. Then `openclaw mcp add wren --command …/.venv/bin/wren --arg serve --arg mcp --arg --transport --arg stdio --arg --quiet --arg --project --arg …/project --cwd …/project --env HOME=/sandbox --timeout 120 --exclude store_query` probed OK: **17 tools**. |
| 5 | `openclaw agent --json` via gateway; envelope contents | ✅ `nemoclaw genbi-poc agent --agent genbi_answer --session-id poc-q1-2 -m "What is the total completed order amount by region? Show the SQL you ran." --json` → `status: ok`, one text payload (summary sentence, Markdown table, SQL), `durationMs 8765`, usage input 52 614 / output 658 (cacheRead 25 344). Envelope has **no per-tool steps**; the tool calls are in the session transcript: `wren__list_models` → `wren__describe_model(orders)` → `wren__describe_model(customers)` → `wren__run_sql(...)`. Two earlier attempts failed upstream with `FailoverError: The AI service is temporarily overloaded` (NVIDIA endpoint 503), succeeded on retry. `--local` is not usable in the sandbox (no raw key there). |
| 6 | `nemoclaw connect` is a PTY a local UI could drive | ✅ It is SSH. `openshell sandbox ssh-config genbi-poc` prints a `Host openshell-genbi-poc.default` block with `ProxyCommand openshell ssh-proxy --gateway-name nemoclaw --name genbi-poc --workspace default`; a `node-pty` host can spawn `ssh -F <config> openshell-genbi-poc.default`. Non-interactive: `nemoclaw <sb> exec -- <cmd>` / `openshell sandbox exec -n <sb> -- <cmd>`; files: `nemoclaw <sb> upload|download`. |
| 7 | Many GenBI sessions against one sandbox / one OpenClaw | ✅ One `openclaw-gateway` process per sandbox serves every agent and session. Session key = `agent:<agentId>:<key>`; `--session-id X` maps to `agent:genbi_answer:explicit:X`, stored as `agents/genbi_answer/sessions/<X>.jsonl` (+ trajectory) with `sessions.json` as index — 24 independent sessions after this POC. Two sessions (`conc-a`, `conc-b`) run concurrently completed in 4 s and 6 s (parallel, not queued); a follow-up in `conc-a` recalled its own prior answer. Limit: `agents.defaults.maxConcurrent: 4` (subagents 8), configurable. See "Many sessions, one sandbox". |
| 8 | Does the agent reach wren only through MCP? | ✅ by policy, not by nature. OpenClaw ships 25 built-in tools incl. `read`, `write`, `edit`, `exec`, `apply_patch`, `web_fetch` (the `tools.profile: minimal` log line enumerates them); an agent without a `tools` block (`main` here) can read project YAML and run the `wren` CLI via `exec` directly. `genbi_answer` is confined to 12 `wren__*` tools; the gateway log confirms the 9 excess wren tools and all built-ins are removed each turn. See finding 6. |

## Post-rebuild turn

After rebuild #2, the `WREN_HOME` fix and removing the AppleDouble files (below):
`nemoclaw genbi-poc agent --agent genbi_answer --session-id post-rebuild-d2 -m "Which region has the highest refunded order amount? Show the SQL." --json`
→ `status: ok`, 12 749 ms, usage in 44 568 / out 747; answer **North 6 389 USD** with the SQL — identical to the direct
`wren query` (North 6389, South 5438, West 4340, East 3092). The first attempt of that pair, and 8 of the 14 turns in
this POC overall, failed upstream with `FailoverError: The AI service is temporarily overloaded` from the NVIDIA
endpoint; every retry within a minute or two succeeded.

## Upstream "overloaded" errors, diagnosed

`FailoverError: The AI service is temporarily overloaded` is OpenClaw's wrapping of an NVIDIA-side **503**
`{"error":{"message":"Service temporarily overloaded","type":"service_unavailable","code":503}}`. In streaming mode
the endpoint returns it as a `data:` event inside an HTTP **200** `text/event-stream`, which is why the gateway log shows
`status=200 elapsedMs≈100`. Reproduced from the host without the sandbox (3 tiny requests: 503, 200, 503), so neither
OpenShell's proxy nor the sandbox is involved. At the same time `nvidia/nemotron-3-ultra-550b-a55b` and
`nvidia/nemotron-3.5-lightning-30b-a3b` answered; `llama-3.3-nemotron-super-49b-v1.5` is 410 (EOL). Switching the route
(`nemoclaw inference set --model nvidia/nemotron-3-ultra-550b-a55b --provider nvidia-prod --sandbox genbi-poc`, then
patching `agents.list[genbi_answer].model`) and asking "show me some customer data" returned a 20-row table plus the
SQL in 38 s (in 29 767 / out 798). Hosted-model availability is a first-class risk for anything built on
`integrate.api.nvidia.com`; a self-hosted NIM removes it.

## Session hygiene and the "shown above" answer

A turn run **without** `--session-id` lands in the agent's shared default session (`agent:genbi_answer:main`), which
by then held 11 messages from earlier tests, a model change and several failed turns. Effects observed:
- The model answered "First 20 customers (rows 1-20) and next 20 customers (rows 21-40) shown above" — it treated the
  `wren__run_sql` tool result as if the user could see it and never rendered the table itself. The envelope carries
  only the final assistant message, so the user got a sentence and no data. Fix in `AGENTS.md` rule 5: the complete
  answer must be in the final message; never refer to earlier output; treat questions as standalone.
- `replayInvalid: true` is **not** a failure signal. In OpenClaw (`replay-state.ts`) `replaySafe = !replayInvalid &&
  !hadPotentialSideEffects`, and `hadPotentialSideEffects` is true whenever the turn called a tool OpenClaw cannot
  prove read-only — which includes every MCP tool, so every `wren__*` turn is flagged while a tool-free turn
  (`READY`) is not. It means "do not blindly replay this attempt". NemoClaw's `agent` wrapper prints it as "did not
  complete: partial trace", which is misleading; `status: ok` + `toolSummary.failures: 0` is the real completion
  signal. (Upstream: OpenClaw could honour MCP `readOnlyHint` annotations; wren could set them.)
- With a fresh `--session-id` and the updated `AGENTS.md`, the same question returned the full 20-row table in the
  payload (Ultra, 3 tool calls, 68.8 s).
Rule for the thin client (§11 layer 2): one `--session-id` per question (or `nemoclaw <sb> sessions reset`), and read
`toolSummary` / the session transcript rather than trusting the payload alone.

## Many sessions, one sandbox

OpenClaw is natively multi-session, so the GenBI mapping is **one sandbox per project (or tenant), one agent per
behaviour, one OpenClaw session per GenBI session** — never one sandbox per GenBI session.

- `openclaw agent --session-id <genbi-session-id>` gives a 1:1 mapping to a stored transcript that `openclaw sessions
  list|export-trajectory|compact` can address; the GenBI session list, resume and delete map onto that store.
- Sessions isolate **conversation only**. Inside one sandbox they share: the `openclaw-gateway` process; the single
  `wren serve mcp` child (one process, one DuckDB connection, observed alive across many turns — a serialisation point
  and a single point of failure for every session); the agent workspace (`AGENTS.md`, `SOUL.md`, `skills/`, memory);
  the filesystem and the inference credential. Anything a session could write to the workspace would be visible to
  every other session — the `write`/`edit`/`sessions_spawn` denies in the tools policy are what close that path.
- The sandbox, not the session, is the tenancy and data-access boundary: policy, `inference.local` credential, mounted
  project and connection profile are per sandbox. Open a second sandbox for a different data source / credential /
  policy / model configuration, for process-level isolation (an agent allowed to run code), or when `maxConcurrent`
  and CPU are exhausted — each one costs a container, a gateway and an MCP process.
- Throughput knob: `agents.defaults.maxConcurrent` (4 here); the fifth concurrent session queues.

## Golden check

`make-project.sh` seeds the data deterministically. Direct query (host dry run and in-sandbox) and the agent's answer agree:

| region | completed amount (USD) |
| --- | --- |
| East | 86 696 |
| South | 86 567 |
| West | 60 605 |
| North | 58 331 |

## Findings that change the blueprint

00. **NemoClaw's rebuild restore on macOS leaks AppleDouble files into the sandbox.** After rebuild #2, 114 `._*`
    files existed under `/sandbox/.openclaw` (`._agents`, `._poc-q1.jsonl`, …, and `project/data/._poc.duckdb`). The
    host-side backup directory contains none, so they are written during restore. Two consequences: wren's DuckDB
    connector attaches every `*.duckdb` in the data directory and failed on `._poc.duckdb` (`not a valid DuckDB database
    file`) — the connector should skip dotfiles; and any restored tree may carry junk. Workaround:
    `find /sandbox/.openclaw -name '._*' -delete` after a rebuild (in `bootstrap.sh` now).
0. **Nothing with symlinks may live in a NemoClaw state dir** (`workspace-*`, `agents`, …) or `rebuild` refuses to back up and aborts. Venvs go to `/sandbox/.openclaw/<name>` outside the declared state dirs; it turned out to survive rebuild anyway, but `bootstrap.sh` re-creates it idempotently. **Anything wren keeps under `$HOME/.wren` is lost on rebuild** — set `WREN_HOME` inside the workspace.

1. **DuckDB needs two cgroup files readable.** `import duckdb` (1.5.5) aborts with `Attempted to dereference unique_ptr that is NULL!` when `/sys/fs/cgroup/memory.max` and `cpu.max` are denied — the same defect the earlier OpenShell spike hit. **NemoClaw custom presets carry only `network_policies`; a `filesystem_policy` section is silently dropped** (and a preset with an empty network section is rejected). Workaround: `openshell policy set --policy <full-policy-with-the-two-paths> genbi-poc --wait`, then `nemoclaw genbi-poc stop && start` — filesystem rules apply on container restart, no rebuild needed. This bypasses NemoClaw's policy ownership and will likely be reverted by a rebuild; it is an upstream ask (filesystem entries in presets or in `policy-additions`).
2. **`nemoclaw upload <file> <dest>` treats `dest` as a directory** (uploading `AGENTS.md` to `…/AGENTS.md` created `AGENTS.md/AGENTS.md`). Upload into a staging dir and move.
3. **OpenClaw 2026.7.1 config is `agents.list[]`**, not the `agents.entries` shown in current OpenClaw docs; `openclaw config schema` is the source of truth.
4. **Prompt cost:** the first turn carried 52 k input tokens (17 MCP tools + bootstrap files); the trivial `READY` turn cost 12 k. Tool filtering via `--include` and per-agent `tools.allow` matter for cost as much as for safety.
5. Upstream bugs filed from this POC: `wren-core-py` missing linux aarch64 (and x64 for the genbi dependency) wheels; `wrenai` `mcp` extra unpinned.

6. **Blueprint invariant — `genbi_answer` reaches data only through the `wren` MCP server.** Tools policy must stay
   `profile: minimal` + an explicit `wren__*` allow-list + `deny: [read, write, edit, exec, apply_patch, …]`; any change
   that grants `exec` or `read` is a break of the data-access boundary, not a tuning. Rationale: (a) one audit surface —
   every data access is a structured `wren__run_sql`/`query_cube` call through one process that can be logged,
   filtered (`--exclude`) and rate-limited, versus arbitrary shell strings whose stdout has to be parsed; (b) the MDL
   stays the only entry point — without `read` the agent sees the compiled semantic layer via `list_models` /
   `describe_model`, never `conn.profile.yml` or raw table names; (c) the `dispatcher/openclaw` target needs an
   enumerable tool surface for capability realisation, which MCP tool names give and shell commands do not. Context is
   **pulled, not pushed**: the wren MCP server compiles the MDL and reads `knowledge/rules/*.md` on each call
   (`get_instructions`, `get_context`, `list_models`), and the model decides per turn whether to call them — the
   `wren-query` skill fixes the order, but a model that skips `get_instructions` misses the business rules. If that
   proves flaky across models, inject the rules at turn start (hook / generated `AGENTS.md`) rather than loosen the
   policy. The OpenClaw tools policy is agent-level self-restraint (one config line re-enables `exec`); the OpenShell
   sandbox policy (network: `inference.local` only; filesystem: baseline + the two cgroup files) is the boundary that
   holds even if the tools policy is changed. An MDL-editing setup agent, if wanted, is a second agent with its own
   policy (likely its own sandbox), never a relaxation of `genbi_answer`.

## Open

- Q3 baked variant: `nemoclaw onboard --agents blueprint/agents.yaml --recreate-sandbox` not yet exercised (live patch verified instead).
- Cost/latency of a second question in the same session (cache read was already 25 k on the first); the `conc-a`
  follow-up was timed only, not token-counted.
- `get_context` runs in full-schema fallback (no `wrenai[memory]`, no `wren memory index`); on a real schema the
  per-turn input will grow accordingly — measure with the index installed before sizing the Launchable model.
