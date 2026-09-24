"""Host-owned, bounded query transport. No command, path or credential arguments."""

import base64
import json
import os
import sys
from pathlib import Path

from sqlglot import exp, parse_one

from wren.config import load_config
from wren.context import build_json
from wren.engine import WrenEngine
from wren.mdl.cte_rewriter import get_sqlglot_dialect
from wren.model.data_source import DataSource
from wren.model.error import ErrorCode, ErrorPhase, WrenError
from wren.profile import expand_profile_secrets, resolve_profile_for_project
from wren.query_semantics import query_semantics

MAX_REQUEST = 65_536
MAX_RESULT = 1_048_576
PROTOCOL = "wren-governed/2"

# The closed error vocabulary a host may show a model. Each class carries one
# fixed sentence; nothing from the underlying exception (its text, the SQL, a
# path, a credential, a stack frame) is ever copied into a frame.
ERROR_MESSAGES: dict[str, str] = {
    "invalid_request": "The request did not match the governed operation contract.",
    "model_not_found": (
        "The query references a table that is not a model in the bound semantic "
        "context; query only the models it defines."
    ),
    "policy_rejected": (
        "The read-only analytical policy rejected the query: use one SELECT over "
        "the bound models with standard analytical functions only."
    ),
    "invalid_sql": "The SQL could not be parsed or planned against the semantic context.",
    "execution_failed": (
        "The data source rejected the query at execution time, for example an "
        "unknown column or a type mismatch."
    ),
    "timeout": "The query exceeded the statement time limit.",
    "datasource_unavailable": "The bound data source could not be reached.",
    "result_too_large": "The result exceeded the governed byte limit; narrow the query.",
    "internal": "The governed operation failed for an unclassified reason.",
}

_INVALID_SQL_CODES = frozenset({ErrorCode.INVALID_SQL, ErrorCode.SQLGLOT_ERROR})
_INVALID_SQL_PHASES = frozenset(
    {
        ErrorPhase.SQL_PARSING,
        ErrorPhase.SQL_PLANNING,
        ErrorPhase.SQL_TRANSPILE,
        ErrorPhase.SQL_SUBSTITUTE,
        ErrorPhase.MDL_EXTRACTION,
    }
)
_DATASOURCE_CODES = frozenset(
    {
        ErrorCode.GET_CONNECTION_ERROR,
        ErrorCode.INVALID_CONNECTION_INFO,
        ErrorCode.DUCKDB_FILE_NOT_FOUND,
        ErrorCode.ATTACH_DUCKDB_ERROR,
    }
)


class _RequestError(ValueError):
    """The frame itself violates the contract; the engine was never consulted."""


class _ResultTooLarge(ValueError):
    """A well-formed result that does not fit the byte limit."""


def classify_error(error: BaseException) -> str:
    """Map an exception to one key of ``ERROR_MESSAGES``; never reads its text."""
    if isinstance(error, _RequestError):
        return "invalid_request"
    if isinstance(error, _ResultTooLarge):
        return "result_too_large"
    if isinstance(error, WrenError):
        code, phase = error.error_code, error.phase
        if code is ErrorCode.MODEL_NOT_FOUND:
            return "model_not_found"
        if code is ErrorCode.DATABASE_TIMEOUT:
            return "timeout"
        if code is ErrorCode.BLOCKED_FUNCTION or phase is ErrorPhase.SQL_POLICY_CHECK:
            return "policy_rejected"
        if code in _DATASOURCE_CODES:
            return "datasource_unavailable"
        if code in _INVALID_SQL_CODES or phase in _INVALID_SQL_PHASES:
            return "invalid_sql"
        if phase in (ErrorPhase.SQL_EXECUTION, ErrorPhase.SQL_DRY_RUN):
            return "execution_failed"
        return "internal"
    # sqlglot raises its own ParseError from the definition/semantics parse.
    if type(error).__module__.startswith("sqlglot"):
        return "invalid_sql"
    return "internal"


def serve(project: Path) -> None:
    """Capture one project's manifest, policy and credentials before accepting work."""
    project = project.resolve(strict=True)
    if not (project / "wren_project.yml").is_file():
        raise ValueError("A bound project is required")
    _, profile = resolve_profile_for_project(project, strict=True)
    profile = expand_profile_secrets(profile)
    datasource = profile.pop("datasource")
    manifest = build_json(project)
    encoded = base64.b64encode(json.dumps(manifest).encode()).decode()
    home = Path(os.environ.get("WREN_HOME", Path.home() / ".wren"))
    with WrenEngine(encoded, datasource, profile, config=load_config(home)) as engine:
        _write({"id": 0, "protocol": PROTOCOL})
        expected_id = 1
        while True:
            line = sys.stdin.buffer.readline(MAX_REQUEST + 1)
            if not line:
                return
            if len(line) > MAX_REQUEST or not line.endswith(b"\n"):
                return
            request = json.loads(line)
            if not isinstance(request, dict) or request.get("id") != expected_id:
                return
            expected_id += 1
            try:
                if request.get("operation") == "inspect" and set(request) == {
                    "id",
                    "operation",
                }:
                    value = manifest
                elif request.get("operation") == "query" and set(request) == {
                    "id",
                    "operation",
                    "sql",
                    "limit",
                }:
                    if (
                        not isinstance(request["sql"], str)
                        or type(request["limit"]) is not int
                        or not 1 <= request["limit"] <= 10_000
                    ):
                        raise _RequestError("Invalid query")
                    result = engine.query(
                        request["sql"], limit=request["limit"], read_only=True
                    )
                    ast = parse_one(
                        request["sql"],
                        dialect=get_sqlglot_dialect(DataSource(datasource)),
                    )
                    aliases = {cte.alias_or_name for cte in ast.find_all(exp.CTE)}
                    definition = {
                        "sql": request["sql"],
                        "source_tables": sorted(
                            {
                                table.name
                                for table in ast.find_all(exp.Table)
                                if table.name not in aliases
                            }
                        ),
                        "filters": [
                            clause.this.sql() for clause in ast.find_all(exp.Where)
                        ],
                    }
                    value = {
                        "columns": result.column_names,
                        "rows": result.to_pylist(),
                        "definition": definition,
                    }
                    semantics = query_semantics(ast, request["sql"], manifest)
                    if semantics is not None:
                        value["semantics"] = semantics
                else:
                    raise _RequestError("Unsupported operation")
                _write({"id": request["id"], "result": value})
            except Exception as error:
                kind = classify_error(error)
                _write(
                    {
                        "id": request["id"],
                        "error": {"class": kind, "message": ERROR_MESSAGES[kind]},
                    }
                )


def _write(value: dict) -> None:
    output = json.dumps(value, default=str, allow_nan=False, separators=(",", ":"))
    if len(output.encode()) > MAX_RESULT:
        raise _ResultTooLarge("Result exceeds byte limit")
    print(output, flush=True)
