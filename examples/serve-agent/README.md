# Profile-bound Wren agent over local MCP

This example serves one Warble profile against one synthetic Wren project. The private pi runtime executes the profile's components; an independent planner connects over MCP. The service does not need the planner's model key.

The service holds no copy of the project's structure, rules or data connection. Everything the agent knows about the data comes from the Wren project itself, read through the Rust `wren-context-loader`; `service.yml` carries only the model, the policy and the execution limits.

Requirements: Python 3.12+, Node 22.19+, a compatible Warble 0.19.0 compiler, the matching `@warble/pi` package containing `dist/service.js` (`warble-private-service/1`), and the context loader binary (below). This service uses POSIX process groups; Windows is not supported. The compiler/runtime pair must include this service contract; matching version numbers alone are not sufficient.

## Install and prepare

Install the supplied Wren wheel with its MCP extra and the matching Warble runtime tarball into isolated directories. Build these packages from the corresponding source trees when developing; the service is not advertised as an already released package.

```sh
uv venv --python 3.12 .venv
uv pip install --python .venv/bin/python './wrenai-0.13.0-py3-none-any.whl[mcp]'
npm install ./warble-pi-0.19.0.tgz
```

Build the context loader once, or point `WREN_CONTEXT_LOADER_BIN` at a built binary. The service looks there first, then at `core/wren-context-loader/target/{release,debug}` of the repository the `wren` package sits in, and otherwise refuses to start (`context_loader_unavailable`); it never falls back to a hand-written metadata copy.

```sh
cargo build --release --manifest-path core/wren-context-loader/Cargo.toml
```

Use an absolute `EXAMPLE` path to this directory and an unused `DEMO` destination. Preparation creates a synthetic DuckDB database, a standard Wren project (`wren_project.yml`, `models/orders`, `models/customers`, `relationships.yml`, `knowledge/rules/conventions.md`, a built `target/mdl.json`) and a v2 `service.yml`; it refuses an existing destination and does not modify global Wren settings.

```sh
.venv/bin/python "$EXAMPLE/setup.py" "$DEMO"
```

The fixture contains 12 orders in three Monday-start UTC weeks (counts 3, 4 and 5), three customers, five invoices in USD, EUR and GBP and an `fx_rates` table that holds EUR and GBP only (no USD row). The rule file declares three defaults, a project-level denylist, `denied_columns: [customers.email]`, and two `semantics` entries in its front-matter: `exclude-test-orders` (rows where `orders.is_test` is true are not business orders), `convert-invoices-to-usd` (a `require_rate_join` with `base_currency: USD` and `match: single`) and `count-paid-and-shipped` (a `sale_statuses` rule over `orders.status`, whose domain comes from the column's `enum_values`). The project also has one view, `usd_line_value`, whose `guarantees` list names `convert-invoices-to-usd`. Every aggregate over `orders` must therefore exclude test orders and keep exactly the paid and shipped orders, and every aggregate over `invoices.amount` must convert through `fx_rates` the way the rule describes (see [Declared default rules](#declared-default-rules)). The default external metadata selection is empty; the private worker can still read the project's context and return permitted results.

Editing a model file or a rule file changes the loader's content digest. A running service then refuses its old sessions (`context_changed`); restart it and the structure and rules documents, the worker's context index and the `context_loaded` audit event all follow the project, with no change to `service.yml`.

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

The common skill works with `profiles/analysis`, `profiles/counts` and the opt-in `profiles/adhoc`. The first two describe a row count of one model and the third open-ended analysis, but all three let the private worker author read-only SQL through `run_sql`, and the host gates every statement the same way; "counts only" is the capability text and the worker's prompt, not something the host can enforce on a SQL statement. Their `capabilities.yml` files describe public tasks; internal prompts are not exported. A profile's `context_budget_bytes` (default 4096, at most 8192 because one runtime request is capped at 16 KiB) bounds the context index in the worker's first request.

The private worker reads context in three steps: the first page of the index (one line per model, cube and view with its description and any declared default rules, plus a summary of the rule files) is already in its request; `list_context` pages through the rest, `select_context` names what it needs, and `read_context` returns those items in full with the rule files that concern them. A project larger than the budget is paged, never truncated or refused. A bundle's `binding.yml` of `kind: prepared` is bound at startup to the loader's prepared context, so the static `context.json` it names is not shipped.

MCP tools: `capabilities`, `open_session`, `ask_data`, `continue_task`, `get_evidence`, `read_metadata`, `close_session`. Direct mode (`serve mcp`) substitutes `run_sql` for delegation/clarification: the caller's statement goes through exactly the planning gate, audit events and authorization the private worker's `run_sql` does, and a statement rejected before execution comes back as the `{error, code, hint}` answer described under [Why a `run_sql` statement is refused](#why-a-run_sql-statement-is-refused). Each direct call is its own task, so the per-task budgets below never carry from one call to the next. Each tool is registered only if the deployment policy permits it. Metadata resources and the capability list are filtered independently. Inspect tool schemas for the `request` wrapper and required revision fields.

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

Test total orders → evidence lookup → a request to reveal hidden SQL. Expect 12 for the total. Reuse one session and reference previous results. A request to reveal hidden SQL should be refused while a separately allowed data request can still complete. The weekly and target questions in `questions.json` belong to the `adhoc` profile.

## Policy and supported scope

`service.yml` is trusted operator configuration, version 2:

```yaml
config_version: 2
caller: local-planner
project_id: synthetic-orders
policy: policy.cedar
connection: {datasource: local_file, url: ../data, format: duckdb}   # optional; see below
metadata_selection: []
private_model: {id: nvidia/nemotron-3.5-lightning-30b-a3b, base_url: https://integrate.api.nvidia.com/v1, credential_env: NVIDIA_INFERENCE_API_KEY}
execution: {deadline_ms: 120000}
```

Other optional keys: `default_preset`, `policy_presets`, `audit_path`, `idle_seconds`. The connection is, in order, `--profile` (a Wren connection profile), then `connection` in `service.yml`, then the connection profile the Wren project is pinned to; with none of them startup fails (`explicit_connection_required`). `metadata_selection` narrows public document access; it cannot expand `policy.cedar`. The example selections are `[]`, `[structure]`, `[structure, rules]` and `[rules]`. The external planner's documents have the fixed ids `structure` (kind `schema.structure`: models, columns, relationships) and `rules` (kind `knowledge.rules`: the rule files; `knowledge/sql` is never carried), generated from the project. Private metadata access, task capability and result disclosure are separate decisions. There is no per-rule-use action, and `policy.cedar` no longer lists models or columns: which columns are off limits is the project's `denied_columns`.

### Migrating a version 1 service.yml

A service configuration that still carries `dataset`, `adhoc`, `metadata`, `rules` or `query_scope` (also inside a preset) is refused at startup with `legacy_service_config` and a message naming each key; nothing is ignored silently. One without `config_version: 2`, or with a key outside the version 2 set, is refused with `invalid_service_config`.

| Version 1 key | Now |
| --- | --- |
| `dataset`, `adhoc` | The models, columns and relationships come from the Wren project. Deny a column with `denied_columns: [model.column]` in the front-matter of a `knowledge/rules/*.md` file |
| `metadata` | The `structure` and `rules` documents are generated from the project |
| `rules` | Business rules are project knowledge (`knowledge/rules/*.md`); enforceable defaults are declared in the same front-matter |
| `query_scope` | Removed. There is no date-range hard limit in this version; the project-level `denied_columns` and declared default rules replace it |

### Denied columns

`denied_columns` entries must read `model.column` (lower-case) and name a column the project has; a scalar value counts as a one-entry list. A malformed entry, an unknown column, a near-miss key (`Denied_Columns`, `denied-columns`, `denied_column`), or a rule file that mentions the key but has no readable front-matter, or has front-matter without a top-level key of exactly that name (a merge key, a nested mapping, a top-level list, a comment, a misspelling) makes the loader mark the catalog invalid and the service refuse to start (`denied_columns_invalid`). A denied column is removed from every metadata projection (the structure document, the worker's index and reads, the business summary of `describe_data`), together with its enum meanings, any cube member of that name, and any relationship or description sentence that names it (a bare column name in a view description is treated as that column, since a view has no resolvable owner). The `denied_columns` key is removed from the rule text the service serves: the front-matter is parsed as YAML, so every spelling the loader accepts is dropped, and if a denied `model.column` still appears in the remaining front-matter (for example in a `defaults` entry, in any rule file, and also when it is written with a YAML escape such as `"customers\x2eemail"`) the service refuses to start (`denied_columns_invalid`) rather than show it. Private SQL that references one, directly or through a CTE, a subquery or a `SELECT *` expansion, is an authorization failure: the task ends as `denied` and nothing runs. This is a project-level denylist, not a per-caller access-control system.

### Execution limits

`execution` holds the limits the host passes to the runtime as `init.limits`: `deadline_ms` (5000-600000, default 120000), `max_tokens`, `thinking` (`on`, `off` or `default`; `default` sends nothing so the provider's own setting applies), `max_turns`, `max_tool_calls`, `provider_max_retries` and `provider_max_retry_delay_ms`; `max_sql_attempts` (default 6, the cap on a task's SQL statements; see [Why a `run_sql` statement is refused](#why-a-run_sql-statement-is-refused)) is a host-side budget. All are optional. Unless `WREN_IPC_CALL_TIMEOUT_S` is set, the host waits `deadline_ms / 1000 + 40` seconds for one runtime call. If that wait ends first, the host sends `cancel` for the task, answers any late tool call with a refusal, keeps the runtime running and reports `unavailable` with reason `timeout`. A runtime that predates `init.limits` ignores them, so on such a runtime the deadline and thinking settings have no effect.

### Named policy presets

An operator may declare named presets in `service.yml` and pick one at startup. A preset overrides only `metadata_selection` and `policy` (another Cedar file inside the configuration directory); any other key is rejected (`invalid_policy_preset`), and a preset `query_scope` is a legacy key (`legacy_service_config`). Top-level values remain the fallback for keys a preset does not set, and a preset cannot widen the deployment Cedar policy: both policies must still allow each request.

```yaml
metadata_selection: []
default_preset: hidden
policy_presets:
  hidden:    { metadata_selection: [] }
  structure: { metadata_selection: [structure] }
  rules:     { metadata_selection: [rules] }
  full:      { metadata_selection: [structure, rules] }
  q1:        { metadata_selection: [structure], policy: q1-policy.cedar }
```

`wren serve agent --policy-preset <name>` selects a preset; without the flag `default_preset` applies, and without either the top-level values apply. An unknown name fails startup (`unknown_policy_preset`) rather than falling back. `wren serve agent-presets --service-config service.yml` prints the declared names as JSON without starting the engine. The selected preset is reported by `capabilities` as `policy_preset: {name, available}`; the visible documents remain `metadata_documents`, which is already policy-filtered. Changing presets is a restart: sessions do not survive it, and a narrower preset cannot recall what a client already received.

### Why a task was unavailable

An `unavailable` response carries a coarse `reason` so a planner can tell which side failed without receiving anything private: `provider` (the private model platform answered with an error or a broken stream), `timeout` (the invocation hit a deadline, was cancelled, or the host's own wait for the runtime ran out), `worker` (the private agent's output or limits: invalid final output, turn/tool/output limits, a tool failure, or a final value that is not the host's evidence token), or `service` (the host or runtime itself, or a runtime that reports no diagnostic code). A `provider` or `timeout` reason is a signal to retry the identical request later; a `worker` reason is a signal to reformulate. Only `unavailable` has a reason; `denied`, `conflict`, `session_expired` and `context_changed` stay as they are. The operator's `audit_path` records the runtime's exact failure code per request (`task_failed` events), still without provider text, SQL or credentials.

### Declared default rules

A rule file may declare defaults in its front-matter (`defaults:`); the host checks every statement against them before it can run. `exclude_rows` requires the statement to exclude the flagged rows of every model it covers. `require_rate_join` requires an aggregate over a listed amount column to join the rate model on the amount's currency and on-or-before the amount's date; two optional keys tighten it: `match: single` requires the rate source to yield one row per amount row (an `ASOF JOIN`, or a derived source that keeps the newest row per amount through `ROW_NUMBER() ... ORDER BY date DESC` = 1; an ordinary `date <=` join is refused as `rate_multi_match`), and `base_currency: USD` names the currency whose amounts need no rate. With a base currency, an inner join of the rate model is refused (`base_currency_dropped`: the base-currency rows have no rate row and would vanish), and so is any literal default of a rate column outside a branch that only the base currency reaches (`rate_default_literal`: `COALESCE(rate, 1)` would turn a missing EUR rate into 1). A LEFT join that takes the base currency from the amount itself (`CASE WHEN currency = 'USD' THEN amount ELSE amount * rate END`) satisfies the rule; a LEFT join with neither guard nor default also passes, and the host records `observed.fx_missing_rate_handling = "unguarded_left_join"` so a later stage can say that the missing-rate behaviour was not verified.

`sale_statuses` (`column: <model>.<column>`, `values: [...]`, optional `domain: [...]`, `overridable_by_caller: true|false`, `when: aggregated`) requires the statement to keep exactly the declared status values. The host does not look for a filter; it computes which of the column's `domain` values the statement's filters still return (`=`, `<>`, `!=`, `IN`, `NOT IN`, `IS [NOT] NULL`, combined with `AND` / `OR` / `NOT`, with `LOWER`, `UPPER` or `TRIM` around the column; case is ignored), so `status NOT IN ('cancelled', 'pending')` keeps whatever else the domain lists. The `domain` is the declaration's own list, or else the `enum_values` the project lists for the column; with neither the declaration is invalid. Each read of the model is judged on its own. A kept set that is a proper subset is refused as `<id>:subset`, one that holds a value it should not as `<id>:superset`, and no status predicate at all as `<id>:missing`. A predicate on the column that the host does not evaluate (a comparison with another column, a function, a subquery, `LIKE`, a `CASE`) gets no verdict: `declared_default_undetermined` with the rule id.

When a rule is `overridable_by_caller: true` and a worker's statement broke it, the worker may call `clarify` with `missing: status_scope` (any other rule, or no violation in the task, answers `{"error": "clarification_not_applicable"}`). The task ends as `needs_clarification`; the host keeps two wordings of the question (one that lists the declared set, one that does not) and sends the plain one, `請指定要分析的訂單狀態`. The `answer` of `continue_task` is read as a comma-separated list of statuses (`、` `;` and line breaks also separate); it must fall inside the rule's domain, or the question is asked once more, and a second unusable answer ends the task as `unavailable` with reason `worker` (`detail: status_scope_unresolved`). The confirmed set (`caller_scope_confirmed {request_id, rule, scope}` in the audit) replaces the declared values as the comparison target for that one rule and nothing else: the other rules, the denylist, the read-only check and the join limit are unchanged. It belongs to the task and to follow-ups that name its result in `reply_to` (`caller_scope_inherited`); a follow-up whose statement keeps a different set is a violation again and asks again, and a new task starts with no scope.

`checks` in the internal evidence record each declared rule as `{applicable, result}` with `satisfied`, `not_applicable`, `satisfied_by_definition` (every read of the models the rule concerns lies inside a view whose `guarantees` names the rule) or `satisfied_by_caller_scope` (which also carries `scope`). A view is expanded in place, so the models it reads are authorized, tracked and checked like any other source; its guarantee excuses only the rules it names, and only for the reads inside it. A cube is not a table and a cube measure is not a column: reading either by name is refused as `unsupported_query` with code `cube_not_a_table`.

Some meanings are beyond what any check can read. Front-matter may list them under `semantics:` as `{id, models, note}` (a model or view name in `models`); a statement that touches one of the models gets the id in `unverified` in its internal evidence, next to the ids the host adds itself: `fx_missing_rate_handling` (an unguarded LEFT join), `fx_default_shape_unverified` (a `COALESCE` / `IF` / `CASE` over a rate whose default is not a plain number or NULL, or whose test is not `IS [NOT] NULL`: `COALESCE(rate, 2 - 1)` passes the rate checks and is reported here) and `duplicate_aggregation` (an aggregate over a view's value in a select that joins the view to a model on a column that is not the model's key). The loader refuses a `semantics` block it cannot read in full, and the service refuses an entry that names an unknown model or view or a denied column.

A statement that breaks a rule is rejected before execution as `declared_default_missing` with the rule ids (`<id>`, or `<id>:<sub>` for the checks above). A statement the checker cannot judge is rejected as `declared_default_undetermined`. A project with no declared rule at all starts with a `declared_defaults_missing_in_project` audit event and enforces nothing: no statement is ever refused for a rule the project did not declare.

### Why a `run_sql` statement is refused

A statement fails in one of three ways, and the worker (or the direct caller) is told which.

1. **Rejected before execution**: nothing ran, nothing was authorized, and the answer is `{"error": <error>, "code": <code>, "rules"?: [...], "hint": <one sentence>}`. `error` is `unsupported_query` (the statement cannot be planned against the bound models: an alias the worker never defined, a correlated subquery or LATERAL join, more than four joins, a recursive CTE, no source table, a parse error, a column-list alias on a table such as `customers AS c(a, b)`, a `NATURAL JOIN`, a positional `#N` reference, a cube read as a table: `cube_not_a_table`), `unsupported_result_shape` (literal strings, text casts or concatenation in a result column, or two result columns with the same label: use `GROUP BY` so a key is a data column instead of one column per literal), `declared_default_missing` (`code: rule_violation`, `rules` lists the rule ids) or `declared_default_undetermined` (`code: no_verdict`). Each is recorded as `private_sql_rejected {request_id, code, sub_code, rules?, attempt}`.
2. **Executed without a deliverable result**: the engine raised, so the statement did run. The answer is `{"error": "query_unavailable", "hint": ...}`; the audit event is `private_sql_failed {request_id, error_class, attempt}` (the exception class name only, never its message).
3. **Refused by authorization**: a denied column, a model that does not exist, an external source, a statement that is not a single read-only query, or a Cedar `deny`. The task ends at once as `denied`: the audit event is `task_failed {reason: "denied", detail: "query_denied:<sub>" | "denied"}`, the runtime is sent `cancel`, and anything it still hands back (a tool call, an evidence token) is refused or dropped. A rewrite cannot make it allowed.

The host counts the worker's attempts per task and a `continue_task` carries the count on. At most two statements may be rejected before execution (only one of them `declared_default_undetermined`), at most one retry follows an engine failure, and `execution.max_sql_attempts` (default 6) caps the task. The statement that goes over a budget ends the task: the host records `private_sql_budget_exhausted {request_id, kind, attempts}` (`kind` is `rejected`, `undetermined`, `query_unavailable` or `sql_attempts`), sends `cancel`, and the task is `unavailable` with reason `worker` (`detail: budget_exhausted:<kind>` in the audit).

### Loopback HTTP transport

`wren serve agent --transport http --host 127.0.0.1 --port 0` serves the same tools over streamable HTTP for a client that manages the service process itself. The bind host must be loopback and the process must receive `WREN_AGENT_LOCAL_TOKEN`; every request must carry `Authorization: Bearer <token>` or it is answered `401 {"status":"denied"}`. After binding, the service prints one line to stderr, `ready transport=http host=<host> port=<port>`, so `--port 0` can be used. The token only guards against other local processes connecting by mistake; it is not authentication between operating-system users.

The default analysis/counts offer is described as a row count of one model; raw rows, SQL-only output and writes are not supported, and every statement the worker or a direct caller sends goes through the gate above before it can run.

Rules in prose help the agent select the domain definition. Tool execution mints an internal evidence token, and only an exact valid token can produce a public result. The result excludes internal SQL and rule text. Evidence does not certify the model selected the user's intended question; the planner must still check what was counted.

Session storage is in memory, with 30-minute idle and 8-hour maximum lifetime, one active mutation per session and bounded request history. Repeating the identical request ID replays an authorized response; changing its payload conflicts. Configuration or metadata changes invalidate context; restart after configuration changes. Old references do not survive restart or transfer between sessions.

An optional operator-only `audit_path` records bounded decision and query diagnostics, one JSON line per event, written and flushed as each event happens, so a killed process still leaves its trail. The first event is `context_loaded` (`digest`, `loader_identity`, `models`, `pages`, `budget_bytes`, `first_page_bytes`). It must name a new file and may contain private query conditions; never expose it as a resource or place it in shared public artifacts. It is disabled by default.

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
uv run --extra mcp pytest tests/unit/test_agent_service.py tests/unit/test_agent_sql.py \
  tests/unit/test_context_adapter.py tests/unit/test_agent_ipc.py tests/unit/test_mcp_server.py
```

The tests that start a real service need the context loader built (see above).

These tests use the actual Cedar subprocess and synthetic Wren database, with
model calls replaced only where hostile outputs or concurrency must be forced.
Hosted model acceptance is separate: run the independent planner with your own
model credentials and inspect both its trace and the configured local audit.
An `unavailable` attempt is not a pass, even when a later identical retry works.

The runtime preserves the original host task envelope (including the worker's
context index) across private component delegation so a coordinator's
paraphrase cannot drop the caller's previous result or clarification. This
does not change what metadata the external planner may read.

## Opt-in ad-hoc analysis

Prepare the same fixture with `setup.py --adhoc "$DEMO"` and launch
`serve agent` with `--agent-profile "$EXAMPLE/profiles/adhoc"`. This selects
`adhoc-policy.cedar`, which lets the private worker author SQL and names no model
or column. It does not broaden the count profiles or the external MCP tool list.

The private worker reads the project's context and authors DuckDB read-only SQL.
It can calculate revenue and average order value, group by dates or regions, join
orders to customers, rank results, and use CTEs. The host parses and qualifies the
query against the loader catalog's models and columns, refuses any reference to a
denied column, checks each referenced model and its columns with Cedar (including
filters and join keys), and checks result permission before executing. External
planners receive host-shaped tables and session evidence, never the SQL or the
private worker's final prose.

This fixture has total revenue 780 USD, average order value 65 USD, and 12 orders.
Regional revenues are East 300, South 260 and North 220. Weekly revenues are
60, 220 and 500 for UTC weeks beginning 2025-12-29, 2026-01-05 and 2026-01-12.
Customer email exists in the synthetic source but is denied by the project,
including use in filters or ordering. Public metadata is disabled by default.

Queries must pass a closed read-only AST/function gate. Writes, external file or
network readers, qualified external sources, recursive/correlated queries,
denied fields and string-synthesizing output are rejected. At most four
joins, 20 output columns and 100 rows are accepted; oversized results fail rather
than silently truncate. These are bounded analytical queries, not unrestricted
SQL access. Arbitrary prose rules are model interpreted and are not proof of
correctness; the declared default in the fixture is read and reported at startup
but not yet enforced on the query.

The private worker may repair a rejected result shape using fixed feedback, but
no rejected SQL is executed. Use wide numeric columns for multiple metrics and
native dates instead of literal metric-name rows or formatted date strings.
Model-generated aliases and string literals do not become public column labels.
`mandatory_scope` is empty now that the service no longer injects a date range.
Follow-ups must pass `reply_to`; original questions and authorized prior
results remain available to the private worker within the session.

A native Codex client can use its existing ChatGPT subscription login instead of
an OpenAI API key. Use an account-supported model and the same MCP/skill contract;
this is separate from the API-based `planner-client` example above. NVIDIA hosted
execution still requires the private model credential.
