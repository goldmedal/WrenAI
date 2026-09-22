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
| Setup script | **Paste Script** with the full contents of `setup.sh` (Brev requires the first line to be `#!/bin/bash`; limit 16 KiB, the script is ~10.6 KiB). Alternative once the ref is public: `curl -fsSL https://raw.githubusercontent.com/Canner/WrenAI/<REF>/apps/genbi/deploy/brev/setup.sh \| bash` |
| Secure Link | name `genbi`, port `4787`, shown as the call-to-action on the deployment page |
| TCP/UDP ports | none |
| Launch parameters | `NVIDIA_API_KEY` (secret, optional), `GENBI_MODEL` (default `nvidia/nemotron-3-super-120b-a12b`), `GENBI_VERSION` (default from `setup.sh`), `WRENAI_VERSION` (default from `setup.sh`) |
| Visibility | **Everyone (published)** so it appears in Brev's Community Explore |
| Description | "Open-source GenBI over your data with Nemotron. Ask questions, get verified tables, charts and KPIs. Runs the web app on this VM; the model runs on NVIDIA endpoints. CPU-only." |

## Why VM mode

The BFF binds `127.0.0.1`; the Secure Link proxy on the instance forwards to that
local port, so no container port mapping or bind-address change is needed. Container
mode would require the BFF to bind `0.0.0.0` inside the container.

## Verification before publishing

1. Deploy the Launchable yourself on the chosen SKU. Record time-to-ready.
2. Open the Secure Link; the GenBI UI loads (no "Invalid Host header" — the proxy
   forwards the external hostname, which the BFF accepts).
3. Run the setup wizard against the bundled sample data and ask one question; a
   verified answer comes back from Nemotron.
4. Stop and start the instance; the service comes back and the workspace persists.
5. Delete the test instance.

## Keeping it fresh

The Launchable pins `<REF>`. When a new `@wrenai/genbi` or `wrenai` is released:

1. Bump the defaults in `setup.sh` on a branch, run the verification above.
2. Merge, then edit the Launchable's setup-script line to the new ref.
3. Re-deploy once from the public link to confirm.
