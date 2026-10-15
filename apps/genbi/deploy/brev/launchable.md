# Creating the Launchable (console inputs)

Reference for whoever owns the Brev Launchable. These are the exact inputs; keep
this file in sync when the Launchable changes.

Current Launchable (created 2026-09-22, name `Wren AI GenBI App Test`, visibility
_Anyone with the link_): <https://brev.nvidia.com/launchable/deploy/now?launchableID=env-3Jfc4rrZYPcuVcqrmDsacEE2zSi>

| Field | Value |
| --- | --- |
| Name | `Wren GenBI (Nemotron via NVIDIA endpoints)` |
| Compute | CPU, x86_64, ≥ 4 vCPU / 8 GB RAM, ≥ 40 GB disk (pick the cheapest stoppable SKU; no GPU) |
| Runtime mode | **VM mode** (no container, no Jupyter) |
| Setup script | **Paste Script** with the full contents of `setup.sh` (Brev requires the first line to be `#!/bin/bash`; limit 16 KiB, the script is ~14.4 KiB). Alternative once the ref is public: `curl -fsSL https://raw.githubusercontent.com/Canner/WrenAI/<REF>/apps/genbi/deploy/brev/setup.sh \| bash` |
| Secure Link | name `genbi`, port `4787`, shown as the call-to-action on the deployment page |
| TCP/UDP ports | none |
| Launch parameters | `NVIDIA_API_KEY` (secret, optional), `GENBI_MODEL` (default `nvidia/nemotron-3-super-120b-a12b`), `GENBI_VERSION` (default from `setup.sh`), `GENBI_COMPONENT_TIMEOUT_MS` (default `300000`), `WRENAI_WHEEL_URL` and `WRENAI_WHEEL_SHA256` (defaults from `setup.sh`) |
| Visibility | **Everyone (published)** so it appears in Brev's Community Explore |
| Description | "Open-source GenBI over your data with Nemotron. Ask questions, get verified tables, charts and KPIs. Runs the web app on this VM; the model runs on NVIDIA endpoints. CPU-only." |

## Why VM mode, and why the BFF binds `0.0.0.0`

VM mode runs the BFF directly as a systemd service, with no container port mapping.
The Secure Link proxy does not connect over loopback: it reaches the VM through Brev's
overlay network interface, so a BFF bound to `127.0.0.1` answers the Secure Link with
`503 … Connection refused`. The setup script therefore sets `GENBI_HOST=0.0.0.0`. Do not
open port `4787` in the cloud firewall or as a TCP/UDP port: the BFF has no login of its
own, and the Secure Link's NVIDIA sign-in is what protects it.

## Verification before publishing

1. Deploy the Launchable yourself on the chosen SKU. Record time-to-ready.
2. Open the Secure Link; the GenBI UI loads (no "Invalid Host header" — the proxy
   forwards the external hostname, which the BFF accepts).
3. Run the setup wizard against the bundled sample data and ask one question; a
   verified answer comes back from Nemotron.
4. Stop and start the instance; the service comes back and the workspace persists.
5. Delete the test instance.

## Observed on the first live deploy (2026-10-08)

- GCP `n2-standard-4`-class CPU VM (4 vCPU / 16 GiB / 43 GB) in asia-south1: **Provisioning 31 s, Building 3 min 21 s**
  to `Running`; the setup script then needs about 1 more minute on a warm image (first run installs ~250 MB of apt
  packages plus Node and `@wrenai/genbi`, so budget 3–5 minutes).
- Brev runs the pasted script as a transient systemd unit (`oncreate-lifecycle-script-<id>.service`, user `ubuntu`
  with passwordless sudo, launch parameters via `PassEnvironment`), and in parallel runs its own bootstrap
  (NetBird, metrics stack, Docker) which also calls `apt`. Two consequences the script now handles:
  `apt-get update` exits non-zero when any of Brev's third-party repositories is mid-sync, so it is non-fatal; and
  apt calls wait for the dpkg lock (`DPkg::Lock::Timeout`).
- `npm ls -g <pkg>` exits 1 when the package is absent; under `set -o pipefail` that aborted the first run silently.
- Brev's console "Startup script logs" panel can stay on *Loading…*; the authoritative log is
  `~/.lifecycle-script-<id>.log` on the VM, plus the script's own `/tmp/genbi-launchable.log`. SSH:
  `brev org set <org>` then `brev shell <instance>`, or `ssh -F ~/.brev/ssh_config <instance>`.
- The Secure Link redirects to NVIDIA SSO before proxying to port 4787 (expected: it is login-protected by default).

## Known limits for a fully unattended run (as of @wrenai/genbi 0.0.8)

The published `@wrenai/genbi` calls `resolve_profile_for_project(..., strict=True)`, a wren API that no PyPI
`wrenai` release has (0.13.x–0.15.0); `setup.sh` therefore installs the GenBI Wren fork wheel, which has it. Without
that wheel the wizard's "Build data model" step fails until a genbi release stops depending on it.

Fixed in 0.0.5 and no longer worked around: `GET /api/config/runtime` reports the boot gateway env until the user
saves, the gateway runtime can be saved when `GENBI_GATEWAY_API_KEY` is set (so `setup.sh` pre-binds it with the model
on both tiers and the key never in the request), and the connect gate reads `data_source:` without the scaffold's
inline comment.

Fixed in 0.0.6: a `relationships.yml` that is a bare `relationships:` (which the wren CLI accepts as "no
relationships") no longer makes the project unparseable, and Build context is judged from the recorded command
results (discovery, `wren context validate`, `wren context build`, then a parseable project) rather than from how
the agent spelled the commands or whether it printed a `SETUP_STATUS` line.

Fixed in 0.0.7: dashboards. Component failures now carry a code and a server-side log line instead of "connection
lost"; the SQL-writing model is told the project's dialect; render blocks are shown to the model as flat templates;
and a layout that still misses the render contract is repaired once (Warble 0.19.0 `repair_layout`). With Nemotron
Super on a local BFF, "build dashboard" returns a verified dashboard.

Fixed in 0.0.8: the Secure Link. On a 0.0.7 Launchable the wizard and a verified Ask completed, but only through a
manual forward: the Secure Link proxy connects over the VM's overlay network and the BFF listened on loopback only,
so the link answered `503 Connection refused`. The BFF now binds `GENBI_HOST`, which `setup.sh` sets to `0.0.0.0`.

Still open: "build dashboard" on the Launchable can be cancelled by the 120 s budget a component run has in total.
A dashboard runs its per-panel queries one after another, and each one makes several calls to the hosted model, so
on hosted Nemotron Super the whole run can take longer than the budget. A configurable budget is planned. Model-led
steps can still need a retry.

## Keeping it fresh

The Launchable pins `<REF>`. When a new `@wrenai/genbi` or a new `wren` wheel is released (update the wheel URL and sha256 together):

1. Bump the defaults in `setup.sh` on a branch, run the verification above.
2. Merge, then edit the Launchable's setup-script line to the new ref.
3. Re-deploy once from the public link to confirm.
