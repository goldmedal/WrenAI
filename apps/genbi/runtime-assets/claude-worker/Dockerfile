# linux/arm64 only. Public immutable Node base; no Wren/project/admin assets.
FROM node:24.20.0-slim@sha256:ba849c60be29959425b8734d57b8b4b7d56f98edd9504c9af091d5281095a71e AS fetch
RUN npm install --prefix /build --no-audit --no-fund --ignore-scripts @anthropic-ai/claude-code-linux-arm64@2.1.259 \
 && echo "c6ff03c389ccdeae0f19e9dc32488eeba61fbef4796f531dbfba6c00f45040d0  /build/node_modules/@anthropic-ai/claude-code-linux-arm64/claude" | sha256sum --check
FROM node:24.20.0-slim@sha256:ba849c60be29959425b8734d57b8b4b7d56f98edd9504c9af091d5281095a71e
COPY --from=fetch /build/node_modules/@anthropic-ai/claude-code-linux-arm64/claude /opt/genbi/claude
COPY claude-worker.mjs /opt/genbi/claude-worker.mjs
COPY claude-worker-ca.mjs /opt/genbi/claude-worker-ca.mjs
COPY claude-session-step.mjs /opt/genbi/claude-session-step.mjs
COPY claude-step-control.mjs /opt/genbi/claude-step-control.mjs
RUN node --input-type=module -e 'import fs from "node:fs";import crypto from "node:crypto";const hash=p=>crypto.createHash("sha256").update(fs.readFileSync(p)).digest("hex");fs.writeFileSync("/opt/genbi/pins.json",JSON.stringify({nodeVersion:process.version,node:hash("/usr/local/bin/node"),claude:hash("/opt/genbi/claude"),wrapper:hash("/opt/genbi/claude-worker.mjs"),sessionStep:hash("/opt/genbi/claude-session-step.mjs"),stepControl:hash("/opt/genbi/claude-step-control.mjs"),caTrust:hash("/opt/genbi/claude-worker-ca.mjs")}));' \
 && rm -rf /usr/local/lib/node_modules /usr/local/bin/npm /usr/local/bin/npx /opt/yarn* /usr/local/bin/yarn* \
 && groupadd -g 1500 sandbox && useradd -u 1500 -g 1500 -d /sandbox sandbox \
 && mkdir /sandbox && chown 1500:1500 /sandbox && chmod 700 /sandbox && chmod 555 /opt/genbi/claude
USER 1500:1500
WORKDIR /sandbox
CMD ["/bin/sleep", "1800"]
