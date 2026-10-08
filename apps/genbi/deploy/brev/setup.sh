#!/bin/bash
# Wren GenBI — NVIDIA Brev Launchable startup script (VM mode).
#
# What this installs on a fresh Ubuntu VM:
#   1. Node.js (pinned major) and the published `@wrenai/genbi` package
#   2. `uv` and the `wren` CLI (the GenBI Wren fork wheel, pinned by URL and
#      sha256) for the service user
#   3. A small synthetic sample dataset (CSV) the setup wizard can bind to
#   4. A systemd service that runs the GenBI BFF on 127.0.0.1:${GENBI_PORT}
#
# The model is Nemotron served by NVIDIA endpoints (OpenAI-compatible API).
# GenBI runs in its `gateway` mode (remote OpenAI-compatible endpoint + key);
# nothing here needs a GPU on the VM.
#
# Usage as the Launchable setup script (pin <ref> to a tag or commit). Brev runs
# the setup script as the instance user with passwordless sudo, so the script
# escalates only where it must:
#   curl -fsSL https://raw.githubusercontent.com/Canner/WrenAI/<ref>/apps/genbi/deploy/brev/setup.sh | bash
#
# Launch parameters (Brev passes them as environment variables):
#   NVIDIA_API_KEY   an `nvapi-...` key from build.nvidia.com. Written to a
#                    root-owned 0640 env file readable by the service user only.
#                    GenBI never persists keys, so it cannot be entered in the
#                    UI later; without it, add it to /etc/genbi/genbi.env and
#                    restart the service.
#   GENBI_MODEL      model id on NVIDIA endpoints (default below)
#   GENBI_VERSION    published @wrenai/genbi version to install (default below)
#   WRENAI_WHEEL_URL     wren CLI wheel to install (default below)
#   WRENAI_WHEEL_SHA256  expected sha256 of that wheel; a mismatch aborts
#
# Idempotent: re-running re-asserts the pinned versions, rewrites the env file
# and restarts the service. It never upgrades past the pins on its own.
set -euo pipefail

GENBI_VERSION="${GENBI_VERSION:-0.0.4}"
# The PyPI `wrenai` lacks APIs the pinned GenBI release calls, so install the
# GenBI-compatible fork wheel, verified by checksum before it is installed.
WRENAI_WHEEL_URL="${WRENAI_WHEEL_URL:-https://github.com/goldmedal/WrenAI/releases/download/wrenai-genbi-v0.15.0-genbi.1/wrenai-0.15.0+genbi.1-py3-none-any.whl}"
WRENAI_WHEEL_SHA256="${WRENAI_WHEEL_SHA256:-5c937bd428cfab9aa5db19f5db73a86ced68c396d11879bbf41f8097b6ccf114}"
NODE_MAJOR="${NODE_MAJOR:-22}"
GENBI_MODEL="${GENBI_MODEL:-nvidia/nemotron-3-super-120b-a12b}"
NVIDIA_API_BASE="${NVIDIA_API_BASE:-https://integrate.api.nvidia.com/v1}"
GENBI_PORT="${GENBI_PORT:-4787}"

LAUNCH_LOG="${LAUNCH_LOG:-/tmp/genbi-launchable.log}"
SENTINEL="/var/run/genbi-launchable-ready"
ENV_DIR="/etc/genbi"
ENV_FILE="${ENV_DIR}/genbi.env"

export DEBIAN_FRONTEND=noninteractive
export NEEDRESTART_MODE=a

mkdir -p "$(dirname "$LAUNCH_LOG")"
exec > >(tee -a "$LAUNCH_LOG") 2>&1

ts() { date '+%H:%M:%S'; }
info() { printf '[%s genbi] %s\n' "$(ts)" "$1"; }
fail() { printf '[%s genbi] ERROR: %s\n' "$(ts)" "$1" >&2; exit 1; }
retry() { # retry <attempts> <sleep-seconds> <label> <command...>
  local attempts="$1" pause="$2" label="$3"; shift 3
  local n=1
  until "$@"; do
    [ "$n" -lt "$attempts" ] || fail "${label} failed after ${attempts} attempts"
    info "${label} failed (attempt ${n}/${attempts}); retrying in ${pause}s"
    sleep "$pause"; n=$((n + 1))
  done
}

# The service user is whoever Brev runs this script as (normally `ubuntu`);
# when run directly as root, fall back to the invoking sudo user. Two helpers
# keep every privileged / user-scoped command correct under both identities.
if [ "$(id -u)" -eq 0 ]; then
  RUN_USER="${GENBI_RUN_USER:-${SUDO_USER:-ubuntu}}"
  run_root() { "$@"; }
  run_user() { runuser -u "$RUN_USER" -- "$@"; }
else
  RUN_USER="${GENBI_RUN_USER:-$(id -un)}"
  sudo -n true 2>/dev/null || fail "passwordless sudo is required"
  run_root() { sudo -E "$@"; }
  run_user() { "$@"; }
fi
id "$RUN_USER" >/dev/null 2>&1 || fail "service user '$RUN_USER' does not exist; set GENBI_RUN_USER"
RUN_HOME="$(getent passwd "$RUN_USER" | cut -d: -f6)"
[ -d "$RUN_HOME" ] || fail "home directory for '$RUN_USER' not found"

GENBI_ROOT="${RUN_HOME}/genbi"
WORKSPACE_ROOT="${GENBI_ROOT}/workspace"
OUT_DIR="${GENBI_ROOT}/out"
SAMPLE_DIR="${GENBI_ROOT}/sample-data/jaffle"
SAMPLE_DUCKDB_DIR="${GENBI_ROOT}/sample-data/jaffle-duckdb"

run_root rm -f "$SENTINEL"
info "GenBI ${GENBI_VERSION} · wren $(basename "$WRENAI_WHEEL_URL") · Node ${NODE_MAJOR} · model ${GENBI_MODEL} · user ${RUN_USER}"

# ── 1. OS packages ───────────────────────────────────────────────────────────
info "installing OS packages"
run_root systemctl stop unattended-upgrades 2>/dev/null || true
# `apt-get update` exits non-zero when ANY configured repository fails, including
# third-party ones the image ships (a mirror mid-sync is enough). The Ubuntu
# indexes we need are still refreshed, so report and continue.
run_root apt-get -o DPkg::Lock::Timeout=600 update -qq \
  || info "apt-get update reported errors for some repositories; continuing with the indexes that did refresh"
retry 5 20 "apt-get install" run_root apt-get -o DPkg::Lock::Timeout=600 install -y -qq --no-install-recommends \
  ca-certificates curl git python3 build-essential

# ── 2. Node.js (pinned major) ────────────────────────────────────────────────
if ! command -v node >/dev/null 2>&1 || [ "$(node -p 'process.versions.node.split(".")[0]')" != "$NODE_MAJOR" ]; then
  info "installing Node.js ${NODE_MAJOR}.x"
  curl -fsSL "https://deb.nodesource.com/setup_${NODE_MAJOR}.x" | run_root bash - >/dev/null
  retry 5 20 "apt-get install nodejs" run_root apt-get -o DPkg::Lock::Timeout=600 install -y -qq nodejs
fi
info "node $(node -v), npm $(npm -v)"

# ── 3. @wrenai/genbi (published package; postinstall fetches pinned Warble) ──
# `npm ls` exits 1 when the package is absent; under `pipefail` that would abort
# the script, so neutralise its status and let the JSON parse decide.
installed_genbi="$( (npm ls -g @wrenai/genbi --depth=0 --json 2>/dev/null || true) \
  | node -p 'try{JSON.parse(require("fs").readFileSync(0,"utf8")).dependencies["@wrenai/genbi"].version}catch{""}')"
if [ "$installed_genbi" != "$GENBI_VERSION" ]; then
  info "installing @wrenai/genbi@${GENBI_VERSION}"
  retry 2 15 "npm install @wrenai/genbi" run_root npm install -g --no-fund --no-audit "@wrenai/genbi@${GENBI_VERSION}"
fi
GENBI_BIN="$(command -v genbi || true)"
[ -n "$GENBI_BIN" ] || fail "genbi binary not on PATH after install"
info "genbi at ${GENBI_BIN}"

# ── 4. wren CLI for the service user (uv tool, wheel pinned by sha256) ───────
info "installing wren CLI $(basename "$WRENAI_WHEEL_URL") for ${RUN_USER}"
run_user env HOME="$RUN_HOME" WRENAI_WHEEL_URL="$WRENAI_WHEEL_URL" WRENAI_WHEEL_SHA256="$WRENAI_WHEEL_SHA256" bash -c '
  set -euo pipefail
  if [ ! -x "$HOME/.local/bin/uv" ]; then
    curl -LsSf https://astral.sh/uv/install.sh | sh >/dev/null
  fi
  wheel_dir="$(mktemp -d)"
  trap '"'"'rm -rf "$wheel_dir"'"'"' EXIT
  wheel="$wheel_dir/$(basename "$WRENAI_WHEEL_URL")"
  curl -fsSL --retry 3 --retry-delay 5 -o "$wheel" "$WRENAI_WHEEL_URL"
  echo "${WRENAI_WHEEL_SHA256}  ${wheel}" | sha256sum -c - >/dev/null \
    || { echo "ERROR: sha256 mismatch for ${WRENAI_WHEEL_URL}; refusing to install" >&2; exit 1; }
  "$HOME/.local/bin/uv" tool install --force "$wheel" >/dev/null
  "$HOME/.local/bin/wren" --version
'

# ── 5. Directories and synthetic sample data ─────────────────────────────────
info "preparing workspace and sample data"
run_user mkdir -p "$WORKSPACE_ROOT" "$OUT_DIR" "$SAMPLE_DIR"
run_user python3 - "$SAMPLE_DIR" <<'PY'
import csv, random, sys, pathlib, datetime as dt
out = pathlib.Path(sys.argv[1]); random.seed(20260921)
regions = ["East", "West", "North", "South"]
plans = ["starter", "team", "enterprise"]
customers = [(i, f"Customer {i:03d}", random.choice(regions), random.choice(plans),
              (dt.date(2025, 1, 1) + dt.timedelta(days=random.randint(0, 540))).isoformat())
             for i in range(1, 121)]
with (out / "customers.csv").open("w", newline="") as f:
    w = csv.writer(f); w.writerow(["customer_id", "name", "region", "plan", "signup_date"]); w.writerows(customers)
orders, order_id = [], 1
for cid, _, region, plan, signup in customers:
    for _ in range(random.randint(1, 12)):
        day = dt.date.fromisoformat(signup) + dt.timedelta(days=random.randint(0, 400))
        if day > dt.date(2026, 9, 1):
            continue
        amount = {"starter": 49, "team": 199, "enterprise": 899}[plan] * random.choice([1, 1, 1, 2, 3])
        status = random.choices(["completed", "refunded", "pending"], weights=[86, 6, 8])[0]
        orders.append((order_id, cid, day.isoformat(), amount, status)); order_id += 1
with (out / "orders.csv").open("w", newline="") as f:
    w = csv.writer(f); w.writerow(["order_id", "customer_id", "order_date", "amount", "status"]); w.writerows(orders)
with (out / "payments.csv").open("w", newline="") as f:
    w = csv.writer(f); w.writerow(["payment_id", "order_id", "method", "amount"])
    for oid, _, _, amount, status in orders:
        if status == "completed":
            w.writerow((oid, oid, random.choice(["card", "bank_transfer", "invoice"]), amount))
print(f"sample data: {len(customers)} customers, {len(orders)} orders -> {out}")
PY
# wren's DuckDB connector only enumerates tables for `format: duckdb`; with
# `format: csv` the files are queryable via read_csv_auto() but invisible to
# information_schema, which is what GenBI's schema discovery reads. So also
# load the CSVs into one DuckDB file and point the wizard at that directory.
run_user mkdir -p "$SAMPLE_DUCKDB_DIR"
run_user tee "$SAMPLE_DUCKDB_DIR/.build-duckdb.py" >/dev/null <<'PY2'
import duckdb, sys, pathlib
src = pathlib.Path(sys.argv[1]); db = pathlib.Path(sys.argv[2])
if db.exists(): db.unlink()
con = duckdb.connect(str(db))
for f in sorted(src.glob("*.csv")):
    con.execute(f"CREATE TABLE {f.stem} AS SELECT * FROM read_csv_auto('{f}', header=true)")
print({r[0]: con.execute(f"SELECT count(*) FROM {r[0]}").fetchone()[0] for r in con.execute("SHOW TABLES").fetchall()})
con.close()
PY2
# wren's uv tool venv ships duckdb; run the loader with that interpreter.
run_user env HOME="$RUN_HOME" bash -c '"$(sed -n "1s/^#!//p" "$HOME/.local/bin/wren")" "$@"' _ \
  "$SAMPLE_DUCKDB_DIR/.build-duckdb.py" "$SAMPLE_DIR" "$SAMPLE_DUCKDB_DIR/jaffle.duckdb"

# ── 6. Environment file (the key is never printed) ──────────────────────────
info "writing ${ENV_FILE}"
run_root install -d -m 0750 -o root -g "$RUN_USER" "$ENV_DIR"
{
  echo "PORT=${GENBI_PORT}"
  echo "WREN_HARNESS_WORKSPACE_ROOT=${WORKSPACE_ROOT}"
  echo "WREN_HARNESS_OUT=${OUT_DIR}"
  # `gateway` = a remote OpenAI-compatible endpoint with a key. (`api-key` mode
  # passes only key+model to the adapter and would ignore the endpoint.)
  echo "WREN_HARNESS_MODE=gateway"
  echo "WREN_HARNESS_ENDPOINT=${NVIDIA_API_BASE}"
  echo "WREN_HARNESS_MODEL=${GENBI_MODEL}"
  if [ -n "${NVIDIA_API_KEY:-}" ]; then
    echo "WREN_HARNESS_API_KEY=${NVIDIA_API_KEY}"
    # The in-app runtime settings re-read the key for the openai-compatible
    # adapter from OPENAI_API_KEY; the key itself is never persisted by GenBI.
    echo "OPENAI_API_KEY=${NVIDIA_API_KEY}"
  fi
  echo "NODE_ENV=production"
} | run_root install -m 0640 -o root -g "$RUN_USER" /dev/stdin "$ENV_FILE"
if [ -z "${NVIDIA_API_KEY:-}" ]; then
  info "NVIDIA_API_KEY not provided; add WREN_HARNESS_API_KEY and OPENAI_API_KEY to ${ENV_FILE}, then: sudo systemctl restart genbi"
fi

# ── 7. systemd service ───────────────────────────────────────────────────────
info "installing systemd unit"
run_root tee /etc/systemd/system/genbi.service >/dev/null <<UNIT
[Unit]
Description=Wren GenBI (BFF + UI)
After=network-online.target
Wants=network-online.target

[Service]
User=${RUN_USER}
WorkingDirectory=${GENBI_ROOT}
EnvironmentFile=${ENV_FILE}
Environment=HOME=${RUN_HOME}
Environment=PATH=${RUN_HOME}/.local/bin:/usr/local/bin:/usr/bin:/bin
ExecStart=${GENBI_BIN}
Restart=on-failure
RestartSec=3

[Install]
WantedBy=multi-user.target
UNIT
run_root systemctl daemon-reload
run_root systemctl enable genbi.service >/dev/null
run_root systemctl restart genbi.service

# ── 8. Readiness ─────────────────────────────────────────────────────────────
info "waiting for GenBI on 127.0.0.1:${GENBI_PORT}"
for _ in $(seq 1 60); do
  if curl -fsS -o /dev/null "http://127.0.0.1:${GENBI_PORT}/"; then
    # The setup wizard reads the persisted runtime settings, not the boot env, so
    # bind the NVIDIA endpoint there too: the "API key (BYO)" mode with the
    # OpenAI-compatible adapter, both compiled tiers on ${GENBI_MODEL}. The key
    # itself stays in the env file (OPENAI_API_KEY); nothing here persists it.
    if [ -n "${NVIDIA_API_KEY:-}" ]; then
      runtime_json=$(printf '{"authMode":"byo","apiKeyAdapter":"openai-compatible","apiKeyBaseURL":"%s","apiKeyModel":"%s","tierModels":[{"tier":"cheap","model":"%s"},{"tier":"strong","model":"%s"}]}' \
        "$NVIDIA_API_BASE" "$GENBI_MODEL" "$GENBI_MODEL" "$GENBI_MODEL")
      if curl -fsS -o /dev/null -X PUT -H 'content-type: application/json' \
           "http://127.0.0.1:${GENBI_PORT}/api/config/runtime" -d "$runtime_json"; then
        info "runtime bound: OpenAI-compatible adapter → ${NVIDIA_API_BASE}, model ${GENBI_MODEL} (both tiers)"
      else
        info "could not pre-bind the runtime settings; pick 'API key (BYO)' → OpenAI-compatible in the setup wizard"
      fi
    fi
    run_root touch "$SENTINEL"
    info "=== Ready === open the 'genbi' Secure Link (port ${GENBI_PORT})"
    info "sample data for the setup wizard: URL=${SAMPLE_DUCKDB_DIR} FORMAT=duckdb (Local file → DuckDB); raw CSVs in ${SAMPLE_DIR}"
    exit 0
  fi
  sleep 2
done
run_root journalctl -u genbi.service --no-pager -n 40 || true
fail "GenBI did not answer on port ${GENBI_PORT} within 120s (see: journalctl -u genbi)"
