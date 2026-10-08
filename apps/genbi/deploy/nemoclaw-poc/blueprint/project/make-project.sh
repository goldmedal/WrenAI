#!/bin/bash
# Runs INSIDE the sandbox. Builds a small Wren project over synthetic CSVs (DuckDB).
# Usage: make-project.sh <project-dir> <wren-binary> [python-with-duckdb]
set -euo pipefail
PROJECT="$1"; WREN="$2"; PY="${3:-$(dirname "$WREN")/python}"
[ -x "$PY" ] || PY=python3
# wren keeps connection profiles in $WREN_HOME (default ~/.wren). Inside a NemoClaw
# sandbox ~/.wren is not a preserved state path and vanishes on rebuild, so callers
# set WREN_HOME to a directory next to the project (bootstrap.sh does).
export WREN_HOME="${WREN_HOME:-$(dirname "$PROJECT")/.wren}"; mkdir -p "$WREN_HOME"
DATA="$PROJECT/data"
mkdir -p "$DATA"
python3 - "$DATA" <<'PY'
import csv, random, sys, pathlib, datetime as dt
out = pathlib.Path(sys.argv[1]); random.seed(20260921)
regions = ["East", "West", "North", "South"]; plans = ["starter", "team", "enterprise"]
customers = [(i, f"Customer {i:03d}", random.choice(regions), random.choice(plans),
              (dt.date(2025, 1, 1) + dt.timedelta(days=random.randint(0, 540))).isoformat()) for i in range(1, 121)]
with (out / "customers.csv").open("w", newline="") as f:
    w = csv.writer(f); w.writerow(["customer_id", "name", "region", "plan", "signup_date"]); w.writerows(customers)
orders, oid = [], 1
for cid, _, region, plan, signup in customers:
    for _ in range(random.randint(1, 12)):
        day = dt.date.fromisoformat(signup) + dt.timedelta(days=random.randint(0, 400))
        if day > dt.date(2026, 9, 1): continue
        amount = {"starter": 49, "team": 199, "enterprise": 899}[plan] * random.choice([1, 1, 1, 2, 3])
        status = random.choices(["completed", "refunded", "pending"], weights=[86, 6, 8])[0]
        orders.append((oid, cid, day.isoformat(), amount, status)); oid += 1
with (out / "orders.csv").open("w", newline="") as f:
    w = csv.writer(f); w.writerow(["order_id", "customer_id", "order_date", "amount", "status"]); w.writerows(orders)
with (out / "payments.csv").open("w", newline="") as f:
    w = csv.writer(f); w.writerow(["payment_id", "order_id", "method", "amount"])
    for o, _, _, amount, status in orders:
        if status == "completed":
            w.writerow((o, o, random.choice(["card", "bank_transfer", "invoice"]), amount))
print(f"{len(customers)} customers, {len(orders)} orders -> {out}")
PY
# Load the CSVs into one DuckDB file. The engine addresses a DuckDB source as
# <catalog = file stem>.<schema>.<table>, which the model YAML relies on
# (catalog: poc, schema: main).
"$PY" - "$DATA" <<'PY2'
import duckdb, sys, pathlib
data = pathlib.Path(sys.argv[1]); db = data / "poc.duckdb"
if db.exists(): db.unlink()
con = duckdb.connect(str(db))
for t in ("customers", "orders", "payments"):
    con.execute(f"CREATE TABLE {t} AS SELECT * FROM read_csv_auto('{data / (t + '.csv')}', header=true)")
print({t: con.execute(f"SELECT count(*) FROM {t}").fetchone()[0] for t in ("customers", "orders", "payments")})
con.close()
PY2
cd "$PROJECT"
SRC="$(cd "$(dirname "$0")" && pwd)"
[ -f wren_project.yml ] || "$WREN" context init --data-source duckdb --empty
# Hand-written semantic model for the three CSVs (no deterministic schema import for DuckDB).
rm -rf models && cp -r "$SRC/models" models && cp "$SRC/relationships.yml" relationships.yml
cat > conn.profile.yml <<YML
datasource: duckdb
url: $DATA
format: duckdb
YML
"$WREN" profile add poc --from-file conn.profile.yml --activate
"$WREN" context set-profile poc
mkdir -p knowledge/rules
cat > knowledge/rules/revenue.md <<'MD'
- "Revenue" means the sum of `orders.amount` where `orders.status = 'completed'`. Exclude refunded and pending orders unless the question asks about them explicitly.
- Amounts are in USD.
MD
"$WREN" context validate
"$WREN" context build
"$WREN" query -q -o json -s "SELECT c.region, SUM(o.amount) AS revenue FROM orders o JOIN customers c ON o.customer_id = c.customer_id WHERE o.status = 'completed' GROUP BY c.region ORDER BY c.region"
