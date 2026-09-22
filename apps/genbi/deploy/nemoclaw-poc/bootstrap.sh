#!/bin/bash
# Host-side: turn an onboarded NemoClaw sandbox into the GenBI analyst.
# Uses only NemoClaw / OpenClaw first-party commands (no direct openclaw.json edits).
#
# Usage: ./bootstrap.sh <sandbox-name> [--wheel <wren_core_py-*-aarch64.whl>] [--wrenai <version>]
#
# The sandbox is Debian on the host's architecture. On Apple Silicon that is
# linux/aarch64, for which `wren-core-py` publishes no wheel yet, so a locally
# built wheel must be passed with --wheel (see README "Build the arm64 wheel").
set -euo pipefail
SB="${1:?sandbox name}"; shift
WHEEL=""; WRENAI_VERSION="0.13.0"
while [ $# -gt 0 ]; do case "$1" in --wheel) WHEEL="$2"; shift 2;; --wrenai) WRENAI_VERSION="$2"; shift 2;; *) echo "unknown arg $1" >&2; exit 2;; esac; done
HERE="$(cd "$(dirname "$0")" && pwd)"
AGENT_ID=genbi_answer
WS=/sandbox/.openclaw/workspace-$AGENT_ID
# The venv must NOT live inside a NemoClaw state dir: rebuild's pre-backup audit
# rejects symlinks (venv has bin/python -> …, lib64 -> lib) and aborts. This path
# is outside the declared state dirs, so it is lost on rebuild and re-created here.
VENV=/sandbox/.openclaw/genbi-venv
PROJECT=$WS/project
WREN_HOME_SB=$WS/.wren   # profiles.yml must survive rebuild → inside the preserved workspace
MODEL="inference/nvidia/nemotron-3-super-120b-a12b"

x() { nemoclaw "$SB" exec -- bash -lc "$*"; }
up() { nemoclaw "$SB" upload "$1" "$2" >/dev/null; }   # NOTE: dest is treated as a directory

echo "== 0. filesystem policy: DuckDB needs two cgroup files readable (NemoClaw presets cannot carry"
echo "      filesystem rules, so this goes through OpenShell directly and needs a container restart)"
if ! openshell policy get "$SB" --full -o json 2>/dev/null | grep -q '/sys/fs/cgroup/memory.max'; then
  nemoclaw "$SB" policy get --raw 2>/dev/null | grep -v '^Version:\|^---$' > /tmp/genbi-poc-policy.yaml
  python3 - /tmp/genbi-poc-policy.yaml <<'PY3'
import sys
p=sys.argv[1]; out=[]; in_fs=False
for l in open(p).read().splitlines():
    out.append(l)
    if l.startswith("filesystem_policy:"): in_fs=True
    elif in_fs and l.strip()=="read_only:":
        out+=["    - /sys/fs/cgroup/memory.max","    - /sys/fs/cgroup/cpu.max"]; in_fs=False
open(p,"w").write("\n".join(out)+"\n")
PY3
  openshell policy set --policy /tmp/genbi-poc-policy.yaml "$SB" --wait
  nemoclaw "$SB" stop && nemoclaw "$SB" start
fi

echo "== 0b. remove AppleDouble files a macOS-side rebuild restore may have left behind"
x "find /sandbox/.openclaw -name '._*' -delete 2>/dev/null || true"

echo "== 1. agent roster"
if ! nemoclaw "$SB" agents list 2>/dev/null | grep -q "^- $AGENT_ID"; then
  nemoclaw "$SB" agents add "$AGENT_ID" --workspace "$WS" --model "$MODEL" --non-interactive --json >/dev/null
fi

echo "== 2. workspace files (upload puts files under a directory named after the dest)"
x "mkdir -p $WS/.in"
up "$HERE/blueprint/workspace/AGENTS.md" "$WS/.in/"
up "$HERE/blueprint/workspace/SOUL.md"   "$WS/.in/"
up "$HERE/blueprint/workspace/skills"    "$WS/.in/"
up "$HERE/blueprint/project"       "$WS/.in/"
x "cd $WS && cp .in/AGENTS.md .in/SOUL.md . && rm -rf skills project-src && cp -r .in/skills skills && cp -r .in/project project-src && rm -rf .in && find . -maxdepth 3 -type f -not -path './.venv/*' | sort"

echo "== 3. wren CLI in a venv under the preserved workspace"
x "[ -x $VENV/bin/python ] || python3 -m venv $VENV; $VENV/bin/pip install -q --upgrade pip"
if [ -n "$WHEEL" ]; then
  x "mkdir -p $WS/.wheels"; up "$WHEEL" "$WS/.wheels/"
  # 'mcp<2': wrenai 0.13.0's MCP server uses the v1 FastMCP API and the extra is unpinned.
  x "$VENV/bin/pip install -q $WS/.wheels/$(basename "$WHEEL") 'wrenai[mcp]==$WRENAI_VERSION' 'mcp<2'"
else
  x "$VENV/bin/pip install -q 'wrenai[mcp]==$WRENAI_VERSION' 'mcp<2'"   # needs a published wheel for this arch
fi
x "$VENV/bin/wren --version"

echo "== 4. sample Wren project"
x "WREN_HOME=$WREN_HOME_SB bash $WS/project-src/make-project.sh $PROJECT $VENV/bin/wren $VENV/bin/python"

echo "== 5. register the stdio MCP server (probed before saving)"
x "openclaw mcp unset wren >/dev/null 2>&1 || true; \
   openclaw mcp add wren --command $VENV/bin/wren --arg serve --arg mcp --arg --transport --arg stdio --arg --quiet \
     --arg --project --arg $PROJECT --cwd $PROJECT --env HOME=/sandbox --env WREN_HOME=$WREN_HOME_SB --timeout 120 \
     --exclude 'store_query' && openclaw mcp probe wren | head -40"

echo "== 6. per-agent tool policy (live patch; the baked equivalent is blueprint/agents.yaml via onboard --agents)"
up "$HERE/blueprint/agents-tools.patch.json5" "/tmp/"
x "openclaw config patch --file /tmp/agents-tools.patch.json5"

echo "== 7. reload MCP runtimes"
x "openclaw mcp reload" || nemoclaw "$SB" gateway restart --quiet

echo "== done. ask:"
echo "  nemoclaw $SB agent --agent $AGENT_ID -m 'total completed order amount by region' --json"
