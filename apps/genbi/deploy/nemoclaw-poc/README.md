# NemoClaw Blueprint POC — GenBI behaviour on a NemoClaw-managed OpenClaw agent

Experimental, opt-in spike. Nothing here is wired into the GenBI app.

## Question

Can a **repo-defined blueprint** stand up an OpenClaw agent inside a NemoClaw-managed
OpenShell sandbox that answers GenBI questions over a Wren project with **Nemotron**
(NVIDIA endpoints) — with **no GenBI server running**? And can a local GenBI UI later
attach to that sandbox over a PTY?

## What is in this directory

| Path | Purpose |
| --- | --- |
| `blueprint/agents.yaml` | NemoClaw declarative agents manifest (`nemoclaw onboard --agents`): the `genbi_answer` agent with a Wren-only tool policy |
| `blueprint/workspace/` | Workspace files for the agent: `AGENTS.md`, `SOUL.md`, `skills/wren-query/SKILL.md` |
| `blueprint/project/make-project.sh` | Builds a small Wren project over synthetic CSVs (DuckDB) **inside the sandbox** |
| `bootstrap.sh` | Host-side, first-party commands only: `nemoclaw agents add`, `upload`, `exec`, `openclaw mcp add` (stdio `wren serve mcp`), `mcp reload` |
| `RESULTS.md` | Evidence for the questions below (filled in as the POC runs) |

Hand-written for now. The intended long-term producer of `blueprint/` is a Warble
back-end (`dispatcher/openclaw`) emitting the same files from the compiled GenBI profile.

## Facts this design relies on (from the NemoClaw OpenClaw agent manifest)

- OpenClaw config: `/sandbox/.openclaw/openclaw.json`; workspace: `/sandbox/.openclaw/workspace`;
  multi-agent workspaces `workspace-<agent>` are declared state dirs (prefix `workspace-`).
- `openclaw.json` is a declared state file restored with `merge: openclaw-config` on rebuild —
  custom agents and MCP servers in it are meant to survive `nemoclaw <sb> rebuild`.
- "Runtime changes outside the manifest-defined state paths, such as packages installed
  manually in the running container, are not preserved." → `wren` is installed into a venv at
  `/sandbox/.openclaw/genbi-venv`, deliberately **outside** the state dirs: a venv inside the
  agent workspace made `rebuild` abort (its pre-backup audit rejects symlinks). `bootstrap.sh`
  is idempotent and re-creates the venv after a rebuild.
- Default agent id is `main`; interactive entry is `openclaw tui`; gateway on 18789.
- MCP support is `bridge` via the `openclaw-config` adapter (stdio servers are plain
  `mcp.servers` entries; OpenClaw spawns them itself, so the host-reachability limit does
  not apply).

## Prerequisites (macOS Apple Silicon)

- Docker via OrbStack, Docker Desktop or Colima (current context must be a local Unix socket).
- Node ≥ 22.19, npm ≥ 10, Python 3, `git`.
- An NVIDIA API key (`nvapi-…`). It is only ever placed in your shell for `nemoclaw onboard`.

## Steps

### 1. Install NemoClaw and onboard (run yourself; the key stays in your shell)

```bash
export NVIDIA_INFERENCE_API_KEY='nvapi-...'          # your key
NEMOCLAW_NON_INTERACTIVE=1 \
NEMOCLAW_ACCEPT_THIRD_PARTY_SOFTWARE=1 \
NEMOCLAW_AGENT=openclaw \
NEMOCLAW_PROVIDER=build \
NEMOCLAW_MODEL='nvidia/nemotron-3-super-120b-a12b' \
NEMOCLAW_SANDBOX_NAME=genbi-poc \
bash -c 'curl -fsSL https://www.nvidia.com/nemoclaw.sh | bash'
```

Record time-to-ready. Then:

```bash
nemoclaw genbi-poc status
nemoclaw genbi-poc connect        # SSH into the sandbox; `exit` to leave
```

### 2. Inject the blueprint

```bash
./bootstrap.sh genbi-poc
```

`bootstrap.sh` applies the DuckDB cgroup filesystem rule (OpenShell-direct, then a container
restart), adds the agent through `nemoclaw agents add`, uploads the workspace files, creates a
Python venv at `/sandbox/.openclaw/genbi-venv` with the pinned `wrenai[mcp]` (+ `mcp<2`), builds
the sample Wren project, registers `wren serve mcp` as an OpenClaw stdio MCP server with
`openclaw mcp add` (probed before saving), applies the per-agent tool policy, and reloads MCP
runtimes.

The sandbox runs on the host's architecture; on Apple Silicon that is **linux/aarch64**, for
which `wren-core-py` has no published wheel. Build one once and pass it in:

```bash
docker run --rm --platform linux/arm64 -v "$PWD/wheels:/out" rust:1.94-bookworm bash -c '
  apt-get update -qq && apt-get install -y -qq python3 python3-pip python3-venv >/dev/null &&
  python3 -m venv /b && /b/bin/pip install -q maturin==1.9.4 &&
  PATH=/b/bin:$PATH /b/bin/pip wheel -q --no-deps --no-build-isolation wren-core-py==0.8.0 --wheel-dir /out'
./bootstrap.sh genbi-poc --wheel wheels/wren_core_py-0.8.0-cp311-abi3-manylinux_2_34_aarch64.whl
```

### 3. Ask one question

```bash
nemoclaw genbi-poc agent --agent genbi_answer -m "total completed order amount by region" --json
```

(`nemoclaw <sb> agent` forwards to `openclaw agent` inside the sandbox; the turn runs through
the OpenClaw gateway, which holds the proxy-managed inference route. `--local` is not usable
inside the sandbox because the raw provider key is never present there.)

Expected: a JSON envelope whose `final` names four regions with amounts that match
`wren query` run directly on the sample project.

### 4. Layer-1 check (PTY)

`nemoclaw genbi-poc connect` opens an SSH session. `openshell sandbox ssh-config genbi-poc`
prints a plain `Host` block whose `ProxyCommand` is `openshell ssh-proxy …`, so any PTY host
can spawn `ssh -F <that config> openshell-genbi-poc.default`.

## The questions

See `RESULTS.md`. Each answer needs the command run and the observed output.

1. Onboard on macOS with NVIDIA endpoints + Nemotron: works? time-to-ready?
2. Custom `agents.entries` + workspace injected: picked up? survives `rebuild`?
3. Per-agent `tools.allow/deny`: does it restrict MCP / exec tools?
4. `wren` in the sandbox: installs? OpenClaw can call it (stdio MCP or exec)?
5. `openclaw agent --local --json` with the gateway running: works? envelope contents?
6. `nemoclaw connect`: a PTY a local GenBI could drive?
7. Many GenBI sessions against one sandbox: does OpenClaw hold independent, concurrent sessions?
8. Does the agent reach wren only through MCP, or can it read files / run the CLI? What enforces that?

## Cleanup

```bash
nemoclaw genbi-poc stop      # keeps workspace and policies
nemoclaw genbi-poc destroy   # removes everything
```
