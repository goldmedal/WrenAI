# linux/arm64 only. Public immutable Node base; no Wren/project/admin assets, no host HOME.
FROM node:24.20.0-slim@sha256:ba849c60be29959425b8734d57b8b4b7d56f98edd9504c9af091d5281095a71e
# ca-certificates: Landlock hard_requirement needs /etc/ssl; iproute2 + nftables: the sandbox network namespace and bypass reject.
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates iproute2 nftables \
 && rm -rf /var/lib/apt/lists/*
WORKDIR /opt/pi
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts --no-audit --no-fund && npm cache clean --force \
 && test "$(node -p 'require("./node_modules/@earendil-works/pi-coding-agent/package.json").version')" = "1.0.4"
COPY pi-worker.mjs pi-worker-core.mjs pi-mcp-shim.mjs pi-proc-check.mjs pi-session-step.mjs pi-step-control.mjs pi-pins.mjs claude-worker-ca.mjs /opt/genbi/
RUN node --input-type=module -e 'import fs from "node:fs";import {computePins} from "/opt/genbi/pi-pins.mjs";fs.writeFileSync("/opt/genbi/pins.json",JSON.stringify(computePins()));' \
 && rm -rf /usr/local/lib/node_modules /usr/local/bin/npm /usr/local/bin/npx /opt/yarn* /usr/local/bin/yarn* \
 && groupadd -g 1500 sandbox && useradd -u 1500 -g 1500 -d /sandbox sandbox \
 && mkdir /sandbox && chown 1500:1500 /sandbox && chmod 700 /sandbox
USER 1500:1500
WORKDIR /sandbox
CMD ["/bin/sleep", "1800"]
