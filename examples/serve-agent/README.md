# Profile-bound Wren agent over local MCP

This example serves one Warble profile against one synthetic Wren project. The private pi runtime executes the profile's components; an independent planner connects over MCP. The service does not need the planner's model key.

Requirements: Python 3.12+, Node 22.19+, a compatible Warble 0.19.0 compiler, and the matching `@warble/pi` package containing `dist/service.js` (`warble-private-service/1`). This service uses POSIX process groups; Windows is not supported. The compiler/runtime pair must include this service contract; matching version numbers alone are not sufficient.

## Install and prepare

Install the supplied Wren wheel with its MCP extra and the matching Warble runtime tarball into isolated directories. Build these packages from the corresponding source trees when developing; the service is not advertised as an already released package.

```sh
uv venv --python 3.12 .venv
uv pip install --python .venv/bin/python './wrenai-0.13.0-py3-none-any.whl[mcp]'
npm install ./warble-pi-0.19.0.tgz
```

Use an absolute `EXAMPLE` path to this directory and an unused `DEMO` destination. Preparation creates a synthetic DuckDB database, Wren project, metadata and deployment policy; it refuses an existing destination and does not modify global Wren settings.

```sh
.venv/bin/python "$EXAMPLE/setup.py" "$DEMO"
```

The fixture contains 12 orders, grouped into three Monday-start UTC weeks with counts 3, 4 and 5. Its internal `weekly-target` rule requires at least 4 orders. The default external metadata selection is empty; the private worker can still read project definitions and return permitted target results.

## Start the service

Provide `NVIDIA_INFERENCE_API_KEY` through the launching terminal or the client's credential handling. The default example uses NVIDIA's hosted Nemotron endpoint; this is a private worker role, not a private-network deployment. Edit `service.yml` to bind another compatible private endpoint. Do not put keys in YAML or profile prompts.

```sh
.venv/bin/wren serve agent \
  --agent-profile "$EXAMPLE/profiles/analysis" \
  --project "$DEMO/project" \
  --service-config "$DEMO/project/service.yml" \
  --runtime "$RUNTIME/node_modules/@warble/pi/dist/service.js" \
  --warble "$WARBLE"
```

This command waits for MCP on stdin; stdout contains protocol messages, not an interactive chat. Configure these executable and argument values in a coding agent's stdio MCP configuration. The client must pass the private credential environment variable when it starts the service. Use an absolute compiler/runtime path.

Omitting `--project` searches upward from the launch directory for `wren_project.yml`. It deliberately ignores `WREN_PROJECT_HOME` and the global default project. `--profile` retains its existing meaning as a data connection profile; `--agent-profile` selects agent behavior. Model endpoint, project, profile and policy cannot be overridden by a model request.

For direct tools with the same boundary, replace `serve agent` with `serve mcp`, retaining `--service-config`, `--agent-profile`, `--runtime`, `--warble` and the project. Controlled mode supports stdio only and refuses writes and `--no-connect`. Legacy `serve mcp` without `--service-config` remains a separate, ungoverned mode.

## Deliver the planner skill

Retrieve the bundled guide with `wren skills get wren-planner`. Put that output in a `wren-planner/SKILL.md` directory using the external agent's supported skill installation mechanism. Do not install it into a global agent directory without the user's instruction.

The common skill works with `profiles/analysis`, `profiles/counts` and the opt-in `profiles/adhoc`. The first offers order and target analysis and reads all declared context in its worker. The second offers count analysis and reads structure on demand. Their `capabilities.yml` files describe public tasks; internal prompts are not exported.

MCP tools: `capabilities`, `open_session`, `ask_data`, `continue_task`, `get_evidence`, `read_metadata`, `close_session`. Direct mode substitutes `query` and `run_sql` for delegation/clarification. Each tool is registered only if the deployment policy permits it. Metadata resources and the capability list are filtered independently. Inspect tool schemas for the `request` wrapper and required revision fields.

## Independent example planner

`planner-client/` is a standalone pi agent loop using an MCP client. It has no import of the service implementation or private profile. Install its locked dependencies with `npm ci`; supply `OPENAI_API_KEY` to the planner process and keep the private credential restricted to the server child. Luna's Chat Completions tool requests explicitly use `reasoning_effort: none`.

Create a client JSON file with:

- `command`: absolute installed `wren` executable;
- `args`: the service arguments shown above;
- `skill`: absolute path to the exported planner skill;
- `serviceCredentialEnv`: `["NVIDIA_INFERENCE_API_KEY"]`;
- optional `model` and `baseUrl` for the external planner.

Create a JSON array of conversational questions, then run:

```sh
node "$EXAMPLE/planner-client/client.mjs" client.json questions.json result.json
```

Test total orders → weekly report → second-week fresh query → project target analysis → evidence lookup. Expect 12, then 3/4/5, then 4, and target statuses false/true/true. Reuse one session and reference previous results. A request to reveal hidden SQL should be refused while a separately allowed data request can still complete.

## Policy and supported scope

`service.yml` is trusted operator configuration. `metadata_selection` narrows public document access; it cannot expand `policy.cedar`. The example selections are `[]`, `[structure]`, `[structure, rules]` and `[rules]`. Private metadata access, task capability, query scope and result disclosure are separate decisions. There is no per-rule-use action.

### Named policy presets

An operator may declare named presets in `service.yml` and pick one at startup. A preset overrides only `metadata_selection`, `policy` (another Cedar file inside the configuration directory) and `query_scope`; any other key is rejected (`invalid_policy_preset`). Top-level values remain the fallback for keys a preset does not set, and a preset cannot widen the deployment Cedar policy: both policies must still allow each request.

```yaml
metadata_selection: []
default_preset: hidden
policy_presets:
  hidden:    { metadata_selection: [] }
  structure: { metadata_selection: [structure] }
  rules:     { metadata_selection: [rules] }
  full:      { metadata_selection: [structure, rules] }
  q1:        { metadata_selection: [structure], query_scope: { start: "2026-01-01", end: "2026-04-01" } }
```

`wren serve agent --policy-preset <name>` selects a preset; without the flag `default_preset` applies, and without either the top-level values apply. An unknown name fails startup (`unknown_policy_preset`) rather than falling back. `wren serve agent-presets --service-config service.yml` prints the declared names as JSON without starting the engine. The selected preset is reported by `capabilities` as `policy_preset: {name, available}`; the visible documents remain `metadata_documents`, which is already policy-filtered. Changing presets is a restart: sessions do not survive it, and a narrower preset cannot recall what a client already received.

### Why a task was unavailable

An `unavailable` response carries a coarse `reason` so a planner can tell which side failed without receiving anything private: `provider` (the private model platform answered with an error or a broken stream), `timeout` (the invocation hit a deadline or was cancelled), `worker` (the private agent's output or limits: invalid final output, turn/tool/output limits, a tool failure, or a final value that is not the host's evidence token), or `service` (the host or runtime itself, or a runtime that reports no diagnostic code). A `provider` or `timeout` reason is a signal to retry the identical request later; a `worker` reason is a signal to reformulate. Only `unavailable` has a reason; `denied`, `conflict`, `session_expired` and `context_changed` stay as they are. The operator's `audit_path` records the runtime's exact failure code per request (`task_failed` events), still without provider text, SQL or credentials.

### Loopback HTTP transport

`wren serve agent --transport http --host 127.0.0.1 --port 0` serves the same tools over streamable HTTP for a client that manages the service process itself. The bind host must be loopback and the process must receive `WREN_AGENT_LOCAL_TOKEN`; every request must carry `Authorization: Bearer <token>` or it is answered `401 {"status":"denied"}`. After binding, the service prints one line to stderr, `ready transport=http host=<host> port=<port>`, so `--port 0` can be used. The token only guards against other local processes connecting by mistake; it is not authentication between operating-system users.

The default analysis/counts adapter supports counts, UTC weekly grouping, Monday-aligned date ranges, and a structured minimum-count rule or explicit user threshold. Mandatory `query_scope.start` and `query_scope.end` are intersected with requested filters. Arbitrary joins, arbitrary SQL expressions, raw rows, SQL-only output and writes are not supported. `run_sql` accepts only the normalized canonical total/weekly count plan for the configured model and scope; all other SQL is rejected before execution.

Rules in prose help the agent select the domain definition; the trusted structured `rules` configuration supplies the calculation. Tool execution mints an internal evidence token, and only an exact valid token can produce a public result. The result excludes internal SQL, rule text and threshold. Evidence does not certify the model selected the user's intended question; the planner must still check grain and dates.

Session storage is in memory, with 30-minute idle and 8-hour maximum lifetime, one active mutation per session and bounded request history. Repeating the identical request ID replays an authorized response; changing its payload conflicts. Configuration or metadata changes invalidate context; restart after configuration changes. Old references do not survive restart or transfer between sessions.

An optional operator-only `audit_path` records bounded decision/query diagnostics on orderly shutdown. It must name a new file and may contain private query conditions; never expose it as a resource or place it in shared public artifacts. It is disabled by default.

## Support boundary

The runtime admits read-only analytical skill components with one model step, a root and declared leaf workers, and exact borrowed tool mappings. Context reading is performed by authored tool behavior. Unsupported effects, conditional steps, params, typed context requirements and deeper component graphs fail admission. This does not claim full Warble IR support.

HTTP sharing/authentication, durable sessions, arbitrary business-rule interpretation, operating-system isolation from the same local user, and private network hosting are outside this example. A client ignoring the skill still encounters service authorization checks. Filesystem/DB credentials held independently by the client are outside this service boundary.

If startup fails, check the profile, compiled IR compatibility, project manifest, model credential environment, policy syntax and runtime path. An `unavailable` result means execution or validation did not complete, not an empty database. Do not substitute a legacy endpoint to bypass a rejection.

## Re-run the checks

From the Wren Python package directory, install the MCP extra and development
dependencies, then run the cross-package tests against a built runtime/compiler:

```sh
WARBLE_SERVICE="$RUNTIME/node_modules/@warble/pi/dist/service.js" \
WARBLE_BIN="$WARBLE" \
uv run --extra mcp pytest tests/unit/test_agent_service.py tests/unit/test_mcp_server.py
```

These tests use the actual Cedar subprocess and synthetic Wren database, with
model calls replaced only where hostile outputs or concurrency must be forced.
Hosted model acceptance is separate: run the independent planner with your own
model credentials and inspect both its trace and the configured local audit.
An `unavailable` attempt is not a pass, even when a later identical retry works.

The runtime preserves the original host task envelope across private component
delegation so a coordinator's paraphrase cannot drop the caller's previous
result, clarification or document IDs. A missing-target clarification is not
accepted when a single applicable structured project rule already exists; the
worker is directed to read the permitted private rule instead. Neither behavior
changes what metadata the external planner may read.

## Opt-in ad-hoc analysis

Prepare a separate synthetic fixture with `setup.py --adhoc "$DEMO"` and launch
`serve agent` with `--agent-profile "$EXAMPLE/profiles/adhoc"`. This selects
`adhoc-policy.cedar` and an explicit model/column allowlist. It does not broaden
the default count profile or the external MCP tool list.

The private worker reads the bound context and authors DuckDB read-only SQL. It
can calculate revenue and average order value, group by dates or regions, join
orders to customers, rank results, and use CTEs. The host parses and qualifies the
query, checks every referenced model/column with Cedar (including filters and
join keys), applies mandatory date scope to every base relation, and checks result
permission before executing. External planners receive host-shaped tables and
session evidence, never the SQL or the private worker's final prose.

This fixture has total revenue 780 USD, average order value 65 USD, and 12 orders.
Regional revenues are East 300, South 260 and North 220. Weekly revenues are
60, 220 and 500 for UTC weeks beginning 2025-12-29, 2026-01-05 and 2026-01-12.
Customer email exists in the synthetic source but is denied, including use in
filters or ordering. Public metadata is disabled by default.

Queries must pass a closed read-only AST/function gate. Writes, external file or
network readers, qualified external sources, recursive/correlated queries,
unapproved fields and string-synthesizing output are rejected. At most four
joins, 20 output columns and 100 rows are accepted; oversized results fail rather
than silently truncate. These are bounded analytical queries, not unrestricted
SQL access. Unlike the counts profile, permitted source-field rows are supported.
Arbitrary prose rules are model interpreted and are not proof of correctness.

The private worker may repair a rejected result shape using fixed feedback, but
no rejected SQL is executed. Use wide numeric columns for multiple metrics and
native dates instead of literal metric-name rows or formatted date strings.
Model-generated aliases and string literals do not become public column labels.
`mandatory_scope` describes host-enforced restrictions, not every filter in the
query. Follow-ups must pass `reply_to`; original questions and authorized prior
results remain available to the private worker within the session.

A native Codex client can use its existing ChatGPT subscription login instead of
an OpenAI API key. Use an account-supported model and the same MCP/skill contract;
this is separate from the API-based `planner-client` example above. NVIDIA hosted
execution still requires the private model credential.
