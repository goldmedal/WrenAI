---
name: wren-query
description: Answer a business question with a verified SQL query through the Wren semantic layer (MCP tools run_sql / list_models / describe_model / get_context).
---

# wren-query

Use when the user asks for a number, a breakdown, a trend, a top-N or a comparison over the
connected data.

## Procedure
1. `get_instructions` → business rules to respect.
2. `list_models`; then `describe_model` for the models the question touches, or `get_context`
   with the question text.
3. Write standard SQL over model names as tables. Prefer explicit `GROUP BY`, name every
   aggregate, filter statuses the rules require.
4. `run_sql` with a `LIMIT` of at most 50 unless the user asks for more.
5. Report: summary line, table, SQL, filters/units. On error: fix once, retry once.

## Do not
- Do not call any tool outside the `wren` server.
- Do not present a number that did not come from `run_sql` / `query_cube` output.
