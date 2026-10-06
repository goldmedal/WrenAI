"""Conservative SQL admission for host-governed analytical queries.

This is an opt-in boundary, independent of the ordinary CLI query policy. Only
one query statement and known analytical functions are admitted. Unknown UDFs,
reader functions, commands, nested writes, locks and SELECT INTO fail closed.
Database credentials and trusted model definitions remain host responsibilities.
"""

from sqlglot import exp, parse

from wren.model.error import ErrorCode, ErrorPhase, WrenError

# Keys are sqlglot ``Expression.key`` values (the lower-cased class name), not
# SQL spellings: ``COUNT_IF`` is ``countif``, ``DATE_TRUNC`` is ``datetrunc``.
_FUNCTIONS = frozenset(
    "abs avg sum count min max round ceil floor coalesce nullif if case cast "
    "trycast extract date dateadd datesub datediff datetrunc timestamptrunc "
    "timetostr strtodate strtotime currentdate currenttimestamp "
    "lower upper trim ltrim rtrim length substring concat concatws replace "
    "row_number rownumber rank denserank lag lead firstvalue lastvalue "
    "stddev stddevpop stddevsamp variance variancepop percentilecont "
    "percentiledisc greatest least power sqrt year month day dayofmonth "
    "dayofweek dayofyear week quarter hour minute second "
    # sqlglot models the boolean connectors and the EXISTS predicate as
    # ``Func`` nodes. They are syntax, not callable functions: without them
    # every ``WHERE a AND b`` is rejected.
    "and or xor exists "
    # Read-only aggregates and predicates analytical SQL commonly uses.
    "countif anyvalue median approxdistinct regexplike".split()
)


def validate_read_only_query(sql: str, dialect: str | None) -> None:
    """Raise before planning or connector creation for unsupported SQL."""
    try:
        statements = parse(sql, dialect=dialect)
        if len(statements) != 1 or not isinstance(
            statements[0], (exp.Select, exp.Union, exp.Intersect, exp.Except)
        ):
            raise ValueError("Expected one analytical query")
        for node in statements[0].walk():
            if isinstance(node, (exp.DML, exp.DDL, exp.Command, exp.Into, exp.Lock)):
                raise ValueError("Query contains an operation with side effects")
            if isinstance(node, exp.Func) and (
                isinstance(node, exp.Anonymous) or node.key not in _FUNCTIONS
            ):
                raise ValueError("Query uses an unsupported function")
            # Qualified calls can resolve to a user-defined function even when
            # their unqualified spelling looks like a built-in aggregate.
            if isinstance(node, exp.Dot) and isinstance(node.expression, exp.Func):
                raise ValueError("Qualified functions are not supported")
    except Exception as error:
        raise WrenError(
            ErrorCode.INVALID_SQL,
            "SQL is not supported by the read-only analytical query policy.",
            phase=ErrorPhase.SQL_POLICY_CHECK,
        ) from error


def require_source_tables(ast: exp.Expression) -> list[str]:
    """Return the tables a parsed query reads, refusing one that reads none.

    A query's own CTE names are not sources. They are compared
    case-insensitively: a reference that differs from a CTE alias only in case
    or quoting may resolve to that CTE (DuckDB does so), and excluding it can
    only refuse more queries, never admit one. A table function such as
    ``generate_series(1, 12)`` parses as a table with an empty name and reads
    no stored data, so it is not a source either.

    Callers check this before execution: a SELECT over literals alone returns
    numbers the caller typed, never values read from a model.
    """
    aliases = {cte.alias_or_name.casefold() for cte in ast.find_all(exp.CTE)}
    tables = sorted(
        {
            table.name
            for table in ast.find_all(exp.Table)
            if table.name and table.name.casefold() not in aliases
        }
    )
    if not tables:
        raise WrenError(
            ErrorCode.INVALID_SQL,
            "The query reads no table, so its values cannot come from the data; "
            "query at least one model.",
            phase=ErrorPhase.SQL_POLICY_CHECK,
        )
    return tables
