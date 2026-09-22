# Wren GenBI on NVIDIA Brev

One click on the Launchable gives you a Linux VM running the open-source Wren GenBI
app — the web UI plus its backend — with **Nemotron** as the model, served by
NVIDIA endpoints. No GPU on the VM is needed; the model runs on NVIDIA's side and
GenBI talks to it over the OpenAI-compatible API.

> **Deploy:** [Launch on NVIDIA Brev](https://brev.nvidia.com/launchable/deploy/now?launchableID=env-3Jfc4rrZYPcuVcqrmDsacEE2zSi)
>
> _Preview build. Visibility is link-only until the first verified run; it moves to Brev's Community Explore after that._

## What you get

| Piece | Where |
| --- | --- |
| GenBI UI + BFF (`@wrenai/genbi`, pinned) | `http://127.0.0.1:4787` on the VM, reached through the **`genbi` Secure Link** |
| `wren` CLI (pinned `wrenai` release) | `~/.local/bin/wren` for the `ubuntu` user |
| Synthetic sample data (customers, orders, payments) | `~/genbi/sample-data/jaffle/*.csv` |
| Service | `systemd` unit `genbi.service`; logs via `journalctl -u genbi` |
| Install log | `/tmp/genbi-launchable.log`; readiness marker `/var/run/genbi-launchable-ready` |

The Secure Link is a public URL fronted by NVIDIA sign-in. Share it with the people
you want to try the app; everyone who opens it shares the **same** GenBI workspace
(GenBI is a single-workspace app, not a multi-tenant service).

## Before you deploy

1. **A Brev account** — the VM runs under your account and consumes your credits
   while it is running. Stop the instance when you are done.
2. **An NVIDIA API key** (`nvapi-…`) from <https://build.nvidia.com/settings/api-keys>.
   Paste it as the `NVIDIA_API_KEY` launch parameter. GenBI never stores keys, so
   there is no place to enter it in the UI later; if you skip it, add it to
   `/etc/genbi/genbi.env` on the VM and restart the service (see below).

### Launch parameters

| Parameter | Default | Meaning |
| --- | --- | --- |
| `NVIDIA_API_KEY` | _(empty)_ | Key for NVIDIA endpoints. Effectively required. Stored root-owned, mode 0640, readable by the service user only. Never printed. |
| `GENBI_MODEL` | `nvidia/nemotron-3-super-120b-a12b` | Any chat model id on NVIDIA endpoints with tool calling. |
| `GENBI_VERSION` | see `setup.sh` | Published `@wrenai/genbi` version. |
| `WRENAI_VERSION` | see `setup.sh` | `wren` CLI release. |

## First run

1. Deploy the Launchable and wait for the instance to report ready (the setup log
   ends with `=== Ready ===`; on a fresh VM this takes a few minutes).
2. Open the **`genbi`** Secure Link from the instance page.
3. In the setup wizard, connect a data source. To use the bundled sample data:
   - data source: **DuckDB**
   - `url`: `/home/ubuntu/genbi/sample-data/jaffle`
   - `format`: `csv`
4. Let the wizard build the semantic model, then ask a question, for example
   *"total completed order amount by region"*.

Bring your own database instead of the sample: the wizard supports the same
sources as the `wren` CLI. Network egress from the VM to your database is your
responsibility.

## Operating the instance

```bash
# on the VM (Brev "Open terminal" or `brev shell <instance>`)
systemctl status genbi          # service state
journalctl -u genbi -f          # live logs
sudo systemctl restart genbi    # after editing /etc/genbi/genbi.env
tail -f /tmp/genbi-launchable.log
```

To change the model or key later, edit `/etc/genbi/genbi.env` (root; set both
`WREN_HARNESS_API_KEY` and `OPENAI_API_KEY` to the same value) and restart the
service. The model and endpoint can also be changed in the app's runtime settings;
the key cannot.

## Cost and lifecycle

- The VM bills while running. **Stop** it from the Brev console when idle; the disk
  (and your GenBI workspace) persists across stop/start. **Delete** removes everything.
- The model is billed by NVIDIA endpoints under your API key, not by Brev.

## Security notes

- The BFF listens on `127.0.0.1` only. Do **not** add a public TCP port for 4787;
  use the Secure Link, which requires NVIDIA sign-in.
- Database credentials you enter in the wizard live in the GenBI workspace on the
  VM's disk. Treat the instance as you would any machine holding those secrets.

## Updating

Re-run `setup.sh` with a newer `GENBI_VERSION` / `WRENAI_VERSION`; it re-asserts
the pins, rewrites the env file and restarts the service. The Launchable itself
pins a git ref of this script — publishing a new GenBI release means updating that
ref in the Launchable definition.

## Files

- `setup.sh` — the Launchable startup script (VM mode).
- `launchable.md` — the exact Brev console inputs used to create the Launchable.
