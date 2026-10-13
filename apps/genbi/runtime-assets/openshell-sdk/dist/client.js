// SPDX-FileCopyrightText: Copyright (c) 2025-2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
import * as net from 'node:net';
import { durationFromMs } from '@bufbuild/protobuf/wkt';
import { createClient } from '@connectrpc/connect';
import { errorCode, fromConnect, SdkError } from './errors.js';
import { OpenShell, SandboxPhase, ServiceStatus, } from './gen/openshell_pb.js';
import { PolicySource, SettingScope } from './gen/sandbox_pb.js';
import { validateSshResponse } from './ssh-validate.js';
import { buildTransport } from './transport.js';
function durationFromSeconds(seconds) {
    if (!Number.isFinite(seconds) || seconds < 0) {
        throw new RangeError('timeoutSecs must be a finite, non-negative number');
    }
    return seconds === 0 ? undefined : durationFromMs(seconds * 1000);
}
function timestampMillis(timestamp) {
    if (!timestamp)
        return undefined;
    const millis = timestamp.seconds * 1000n + BigInt(Math.trunc(timestamp.nanos / 1_000_000));
    return millis === 0n ? undefined : millis.toString();
}
export { errorCode };
function deletionResult(response) {
    const names = {
        0: 'unspecified',
        1: 'completed',
        2: 'accepted',
        3: 'already_absent',
    };
    return {
        outcome: names[response.outcome] ?? 'unknown',
        rawOutcome: response.outcome,
        ...(response.sandboxId ? { sandboxId: response.sandboxId } : {}),
    };
}
// ---- enum → lowercase string -----------------------------------------------
// Exported for the enum-name drift test only; not re-exported from index.ts, so
// they are not part of the public package API.
export const PHASE_NAMES = {
    [SandboxPhase.UNSPECIFIED]: 'unspecified',
    [SandboxPhase.PROVISIONING]: 'provisioning',
    [SandboxPhase.READY]: 'ready',
    [SandboxPhase.ERROR]: 'error',
    [SandboxPhase.DELETING]: 'deleting',
    [SandboxPhase.UNKNOWN]: 'unknown',
    [SandboxPhase.STOPPING]: 'stopping',
    [SandboxPhase.STOPPED]: 'stopped',
    [SandboxPhase.STARTING]: 'starting',
    [SandboxPhase.COMPLETED]: 'completed',
};
export const STATUS_NAMES = {
    [ServiceStatus.UNSPECIFIED]: 'unspecified',
    [ServiceStatus.HEALTHY]: 'healthy',
    [ServiceStatus.DEGRADED]: 'degraded',
    [ServiceStatus.UNHEALTHY]: 'unhealthy',
};
export const SCOPE_NAMES = {
    [SettingScope.UNSPECIFIED]: 'unspecified',
    [SettingScope.SANDBOX]: 'sandbox',
    [SettingScope.GLOBAL]: 'global',
};
export const POLICY_SOURCE_NAMES = {
    [PolicySource.UNSPECIFIED]: 'unspecified',
    [PolicySource.SANDBOX]: 'sandbox',
    [PolicySource.GLOBAL]: 'global',
};
function phaseName(p) {
    return PHASE_NAMES[p] ?? 'unspecified';
}
function statusName(s) {
    return STATUS_NAMES[s] ?? 'unspecified';
}
function scopeName(s) {
    return SCOPE_NAMES[s] ?? 'unspecified';
}
function policySourceName(s) {
    return POLICY_SOURCE_NAMES[s] ?? 'unspecified';
}
function sandboxRef(sandbox) {
    if (!sandbox)
        throw new SdkError('invalid_config', 'sandbox missing from gateway response');
    const meta = sandbox.metadata;
    if (!meta?.id || !meta.name) {
        throw new SdkError('invalid_config', 'sandbox metadata.id and metadata.name are required in gateway responses');
    }
    return {
        id: meta.id,
        name: meta.name,
        workspace: meta.workspace,
        phase: phaseName(sandbox.status?.phase ?? SandboxPhase.UNSPECIFIED),
        labels: meta?.labels ?? {},
        resourceVersion: (meta?.resourceVersion ?? 0n).toString(),
        mainProcessInstanceId: sandbox.status?.mainProcessInstanceId || undefined,
        exitCode: sandbox.status?.exitCode,
        createdFromWorkloadTemplate: sandbox.createdFromWorkloadTemplate
            ? {
                name: sandbox.createdFromWorkloadTemplate.name,
                resourceVersion: sandbox.createdFromWorkloadTemplate.resourceVersion,
            }
            : undefined,
    };
}
function sandboxTemplate(template) {
    if (!template)
        throw new SdkError('invalid_config', 'sandbox template missing from gateway response');
    return template;
}
function providerRef(provider) {
    const meta = provider.metadata;
    return {
        id: meta?.id ?? '',
        name: meta?.name ?? '',
        type: provider.type,
        labels: meta?.labels ?? {},
        resourceVersion: (meta?.resourceVersion ?? 0n).toString(),
    };
}
function sandboxConfig(resp) {
    const settings = {};
    for (const [key, setting] of Object.entries(resp.settings)) {
        settings[key] = effectiveSetting(setting);
    }
    return {
        ...(resp.policy ? { policy: resp.policy } : {}),
        version: resp.version,
        policyHash: resp.policyHash,
        settings,
        configRevision: resp.configRevision.toString(),
        policySource: policySourceName(resp.policySource),
        globalPolicyVersion: resp.globalPolicyVersion,
        providerEnvRevision: resp.providerEnvRevision.toString(),
    };
}
function effectiveSetting(setting) {
    return {
        ...(setting.value ? { value: setting.value } : {}),
        scope: scopeName(setting.scope),
    };
}
function updateConfigResult(resp) {
    return {
        version: resp.version,
        policyHash: resp.policyHash,
        settingsRevision: resp.settingsRevision.toString(),
        deleted: resp.deleted,
    };
}
// Optimistic-concurrency version pin: absent/empty means 0n (server uses the
// current version, backward-compatible). A mismatch surfaces as Aborted →
// SdkError code 'aborted'.
function versionPin(value) {
    if (!value)
        return 0n;
    let pin;
    try {
        pin = BigInt(value);
    }
    catch {
        // BigInt() throws a raw SyntaxError on non-integer input; keep the SdkError
        // taxonomy intact so callers' errorCode() checks still match.
        throw new SdkError('invalid_config', `expectedResourceVersion is not a u64: '${value}'`);
    }
    if (pin < 0n) {
        throw new SdkError('invalid_config', `expectedResourceVersion is not a u64: '${value}'`);
    }
    return pin;
}
const FORWARD_CHUNK = 64 * 1024;
function workspaceName(options) {
    const workspace = options?.workspace ?? 'default';
    if (workspace.trim() === '')
        throw new SdkError('invalid_config', 'workspace must be non-empty');
    return workspace;
}
function workspaceScope(options) {
    return { selection: { case: 'workspace', value: workspaceName(options) } };
}
function listWorkspaceScope(options) {
    return options?.allWorkspaces ? { selection: { case: 'allWorkspaces', value: {} } } : workspaceScope(options);
}
function requestCallOptions(options) {
    if (!options)
        return undefined;
    const { workspace: _workspace, ...callOptions } = options;
    return callOptions;
}
// Build CallOptions that bound one poll RPC by the remaining wall-clock budget
// and honor caller cancellation, so a stalled RPC cannot outlive the deadline.
function deadlineOptions(remainingMs, signal) {
    const timeout = AbortSignal.timeout(Math.max(0, remainingMs));
    return {
        signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
    };
}
// Translate a poll failure at the wait boundary: caller cancellation and the
// poll's deadline signal both become explicit SdkErrors; anything else propagates.
function mapWaitError(err, name, deadline, signal, pollSignal) {
    if (signal?.aborted)
        return new SdkError('connect', `wait for sandbox '${name}' aborted`);
    if (pollSignal?.aborted || Date.now() >= deadline)
        return new SdkError('connect', `timed out waiting for sandbox '${name}'`);
    return err instanceof SdkError ? err : fromConnect(err);
}
// Sleep between polls, bounded by the remaining deadline and interruptible by
// the caller signal so the returned promise stays within its timeout budget.
function waitSleep(delayMs, deadline, signal) {
    const bounded = Math.min(delayMs, Math.max(0, deadline - Date.now()));
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
            signal?.removeEventListener('abort', onAbort);
            resolve();
        }, bounded);
        const onAbort = () => {
            clearTimeout(timer);
            reject(new SdkError('connect', 'wait aborted'));
        };
        if (signal)
            signal.addEventListener('abort', onAbort, { once: true });
    });
}
// Wait for a socket to drain before writing more. Resolves on 'drain', and
// also on 'close'/'error' so a pending await never leaks when the socket is
// torn down mid-backpressure; short-circuits if it is already gone.
function waitForDrain(socket) {
    if (socket.writableEnded || socket.destroyed)
        return Promise.resolve();
    return new Promise((resolve) => {
        const done = () => {
            socket.removeListener('drain', done);
            socket.removeListener('close', done);
            socket.removeListener('error', done);
            resolve();
        };
        socket.once('drain', done);
        socket.once('close', done);
        socket.once('error', done);
    });
}
// An async-iterable queue for the client-send half of bidi streams. Producers
// `push()` frames; the connect transport consumes them as it drains the send
// side. `end()` closes the stream (optionally with an error). `onDrain` fires
// when the buffered queue empties via consumption, so callers can relieve TCP
// backpressure.
export class Pushable {
    queue = [];
    waiting = [];
    ended = false;
    error;
    onDrain;
    get size() {
        return this.queue.length;
    }
    push(value) {
        if (this.ended)
            return;
        const waiter = this.waiting.shift();
        if (waiter) {
            waiter.resolve({ value, done: false });
        }
        else {
            this.queue.push(value);
        }
    }
    end(error) {
        if (this.ended)
            return;
        this.ended = true;
        this.error = error;
        let waiter = this.waiting.shift();
        while (waiter) {
            if (error !== undefined)
                waiter.reject(error);
            else
                waiter.resolve({ value: undefined, done: true });
            waiter = this.waiting.shift();
        }
    }
    async *[Symbol.asyncIterator]() {
        for (;;) {
            if (this.queue.length > 0) {
                const value = this.queue.shift();
                if (this.queue.length === 0)
                    this.onDrain?.();
                yield value;
                continue;
            }
            if (this.ended) {
                if (this.error !== undefined)
                    throw this.error;
                return;
            }
            const next = await new Promise((resolve, reject) => {
                this.waiting.push({ resolve, reject });
            });
            if (next.done) {
                if (this.error !== undefined)
                    throw this.error;
                return;
            }
            yield next.value;
        }
    }
}
/** Lazy, single-pass iterator that fetches one RPC page per advance. */
export class Pager {
    fetch;
    nextToken;
    constructor(fetch, pageToken = '') {
        this.fetch = fetch;
        this.nextToken = pageToken;
    }
    /** Fetch the next page, or return undefined after the final page. */
    async nextPage() {
        if (this.nextToken === undefined)
            return undefined;
        const page = await this.fetch(this.nextToken);
        this.nextToken = page.nextPageToken === '' ? undefined : page.nextPageToken;
        return page;
    }
    /** Consume the pager and collect every remaining item. */
    async all() {
        const items = [];
        for await (const page of this)
            items.push(...page.items);
        return items;
    }
    async *[Symbol.asyncIterator]() {
        for (;;) {
            const page = await this.nextPage();
            if (page === undefined)
                return;
            yield page;
        }
    }
}
// ---- sandbox template client ----------------------------------------------
// Reusable sandbox workload template lifecycle. Templates intentionally return
// generated proto messages because the resource owns portable workload fields
// plus driver-specific config that should not be lossy in the curated layer.
export class SandboxTemplateClient {
    grpc;
    raw;
    transport;
    constructor(transport, grpc = createClient(OpenShell, transport)) {
        this.transport = transport;
        this.grpc = grpc;
        this.raw = this.grpc;
    }
    static async connect(options) {
        return new SandboxTemplateClient(buildTransport(options));
    }
    async create(template, options) {
        try {
            const resp = await this.grpc.createSandboxTemplate({
                template,
                workspaceScope: workspaceScope(options),
            });
            return sandboxTemplate(resp.template);
        }
        catch (e) {
            throw e instanceof SdkError ? e : fromConnect(e);
        }
    }
    async get(name, options) {
        if (name.trim() === '')
            throw new SdkError('invalid_config', 'template name is required');
        try {
            const resp = await this.grpc.getSandboxTemplate({
                name,
                workspaceScope: workspaceScope(options),
            });
            return sandboxTemplate(resp.template);
        }
        catch (e) {
            throw e instanceof SdkError ? e : fromConnect(e);
        }
    }
    list(options) {
        return new Pager(async (pageToken) => {
            try {
                const resp = await this.grpc.listSandboxTemplates({
                    pageSize: options?.pageSize ?? 0,
                    pageToken,
                    labelSelector: options?.labelSelector ?? '',
                    workspaceScope: listWorkspaceScope(options),
                });
                return { items: resp.templates, nextPageToken: resp.nextPageToken };
            }
            catch (e) {
                throw fromConnect(e);
            }
        }, options?.pageToken ?? '');
    }
    /** List and collect every sandbox template in this scope. */
    async listAll(options) {
        return this.list(options).all();
    }
    async delete(name, options) {
        if (name.trim() === '')
            throw new SdkError('invalid_config', 'template name is required');
        try {
            const resp = await this.grpc.deleteSandboxTemplate({
                allowMissing: options?.allowMissing ?? false,
                name,
                workspaceScope: workspaceScope(options),
            });
            return deletionResult(resp);
        }
        catch (e) {
            throw fromConnect(e);
        }
    }
}
// ---- sandbox client --------------------------------------------------------
// Sandbox lifecycle + exec. Usable standalone via `SandboxClient.connect()`,
// or reached as `client.sandbox` on an OpenShellClient, which shares one
// transport (one connection) across all of its scoped clients.
export class SandboxClient {
    grpc;
    /**
     * Advanced escape hatch: a generated client for every gateway RPC, including
     * surface the curated methods do not wrap yet. Request/response types are the
     * generated wire messages (import them from '@nvidia/openshell-sdk/raw').
     */
    raw;
    /** The shared Connect transport, for building extra clients over the same connection. */
    transport;
    // Takes a transport rather than options so OpenShellClient can compose
    // several scoped clients over a single connection. For standalone use,
    // prefer the SandboxClient.connect() factory below.
    constructor(transport, grpc = createClient(OpenShell, transport)) {
        this.transport = transport;
        this.grpc = grpc;
        this.raw = this.grpc;
    }
    /**
     * Constructs a lazy Connect client. No network request is made until the
     * first RPC; call get() or another operation to verify reachability.
     */
    static async connect(options) {
        return new SandboxClient(buildTransport(options));
    }
    async create(spec) {
        try {
            // Curated fields build the base spec; rawSpec then shallow-overrides at
            // the top spec level (Object.assign, so any field it sets wins). The
            // runtime assign avoids the generated $typeName upgrading the literal and
            // rejecting the curated `template: { image }` init shorthand.
            const specInit = {
                environment: spec.environment ?? {},
                providers: spec.providers ?? [],
                template: spec.image ? { image: spec.image } : undefined,
                resourceRequirements: spec.gpu ? { gpu: {} } : undefined,
                policy: spec.policy,
                command: spec.command ?? [],
                tty: spec.tty ?? false,
            };
            if (spec.rawSpec)
                Object.assign(specInit, spec.rawSpec);
            const resp = await this.grpc.createSandbox({
                name: spec.name ?? '',
                labels: spec.labels ?? {},
                workspaceScope: workspaceScope(spec),
                spec: specInit,
            });
            return sandboxRef(resp.sandbox);
        }
        catch (e) {
            throw fromConnect(e);
        }
    }
    async createFromTemplate(spec) {
        if (spec.templateName.trim() === '')
            throw new SdkError('invalid_config', 'templateName is required');
        try {
            const resp = await this.grpc.createSandbox({
                name: spec.name ?? '',
                labels: spec.labels ?? {},
                workspaceScope: workspaceScope(spec),
                spec: {
                    providers: spec.providers ?? [],
                    command: spec.command ?? [],
                    tty: spec.tty ?? false,
                    policy: spec.policy,
                },
                workloadTemplateName: spec.templateName,
            });
            return sandboxRef(resp.sandbox);
        }
        catch (e) {
            throw fromConnect(e);
        }
    }
    async get(name, options) {
        try {
            const resp = await this.grpc.getSandbox({ name, workspaceScope: workspaceScope(options) }, requestCallOptions(options));
            return sandboxRef(resp.sandbox);
        }
        catch (e) {
            throw fromConnect(e);
        }
    }
    list(options) {
        return new Pager(async (pageToken) => {
            try {
                const resp = await this.grpc.listSandboxes({
                    pageSize: options?.pageSize ?? 0,
                    pageToken,
                    labelSelector: options?.labelSelector ?? '',
                    workspaceScope: listWorkspaceScope(options),
                });
                return {
                    items: resp.sandboxes.map((sandbox) => sandboxRef(sandbox)),
                    nextPageToken: resp.nextPageToken,
                };
            }
            catch (e) {
                throw fromConnect(e);
            }
        }, options?.pageToken ?? '');
    }
    /** List and collect every sandbox in this scope. */
    async listAll(options) {
        return this.list(options).all();
    }
    async delete(name, options) {
        try {
            const resp = await this.grpc.deleteSandbox({
                name,
                workspaceScope: workspaceScope(options),
                allowMissing: options?.allowMissing ?? false,
            });
            return deletionResult(resp);
        }
        catch (e) {
            throw fromConnect(e);
        }
    }
    // Poll until the sandbox is ready. The timeout bounds the returned promise,
    // not just the sleep loop: each poll RPC carries the remaining deadline (and
    // any caller signal), so a stalled get() is aborted rather than hanging.
    async waitReady(name, timeoutSecs, options) {
        const deadline = Date.now() + timeoutSecs * 1000;
        const signal = options?.signal;
        let delay = 250;
        for (;;) {
            if (signal?.aborted)
                throw new SdkError('connect', `wait for sandbox '${name}' aborted`);
            if (Date.now() >= deadline)
                throw new SdkError('connect', `timed out waiting for sandbox '${name}'`);
            let ref;
            const pollOptions = deadlineOptions(deadline - Date.now(), signal);
            try {
                ref = await this.get(name, {
                    ...pollOptions,
                    workspace: options?.workspace,
                });
            }
            catch (e) {
                throw mapWaitError(e, name, deadline, signal, pollOptions.signal);
            }
            if (ref.phase === 'ready' || ref.phase === 'completed')
                return ref;
            if (ref.phase === 'stopped')
                throw new SdkError('connect', `sandbox '${name}' stopped before becoming ready`);
            if (ref.phase === 'error')
                throw new SdkError('connect', `sandbox '${name}' entered error phase`);
            if (Date.now() >= deadline)
                throw new SdkError('connect', `timed out waiting for sandbox '${name}'`);
            await waitSleep(delay, deadline, signal);
            delay = Math.min(delay * 2, 2000);
        }
    }
    // Poll until the sandbox is gone, or its name resolves to a different ID when
    // expectedSandboxId is supplied. Timeout and cancellation work as in waitReady.
    async waitDeleted(name, timeoutSecs, options) {
        const deadline = Date.now() + timeoutSecs * 1000;
        const signal = options?.signal;
        let delay = 250;
        for (;;) {
            if (signal?.aborted)
                throw new SdkError('connect', `wait for sandbox '${name}' aborted`);
            if (Date.now() >= deadline)
                throw new SdkError('connect', `timed out waiting for sandbox '${name}' to delete`);
            const pollOptions = deadlineOptions(deadline - Date.now(), signal);
            try {
                const ref = await this.get(name, { ...pollOptions, workspace: options?.workspace });
                if (options?.expectedSandboxId !== undefined && ref.id !== options.expectedSandboxId)
                    return;
            }
            catch (e) {
                if (e instanceof SdkError && e.code === 'not_found')
                    return;
                throw mapWaitError(e, name, deadline, signal, pollOptions.signal);
            }
            if (Date.now() >= deadline)
                throw new SdkError('connect', `timed out waiting for sandbox '${name}' to delete`);
            await waitSleep(delay, deadline, signal);
            delay = Math.min(delay * 2, 2000);
        }
    }
    // Stream stdout/stderr as they arrive, then a terminal exit event. The exit
    // is yielded in-band (not returned) so `for await` consumers cannot silently
    // discard it: a failing command is impossible to miss. If the gateway closes
    // the stream without an exit event, this throws. `exec()` drains this same
    // path to reconstruct the buffered result.
    async *execStream(name, command, options) {
        try {
            // Resolve the sandbox id first, exactly like the gateway client.
            const sandbox = await this.get(name, {
                workspace: options?.workspace,
                ...(options?.signal ? { signal: options.signal } : {}),
            });
            const stream = this.grpc.execSandbox({
                sandboxId: sandbox.id,
                command,
                workdir: options?.workdir ?? '',
                environment: options?.environment ?? {},
                executionTimeout: durationFromSeconds(options?.timeoutSecs ?? 0),
                stdin: options?.stdin ? new Uint8Array(options.stdin) : new Uint8Array(),
                tty: false,
                noLoginShell: options?.noLoginShell ?? false,
            }, { signal: options?.signal });
            let sawExit = false;
            for await (const event of stream) {
                switch (event.payload.case) {
                    case 'stdout':
                        yield {
                            stream: 'stdout',
                            data: Buffer.from(event.payload.value.data),
                        };
                        break;
                    case 'stderr':
                        yield {
                            stream: 'stderr',
                            data: Buffer.from(event.payload.value.data),
                        };
                        break;
                    case 'exit':
                        sawExit = true;
                        yield { type: 'exit', exitCode: event.payload.value.exitCode };
                        break;
                }
            }
            if (!sawExit)
                throw new SdkError('rpc', 'ExecSandbox stream ended without an exit event');
        }
        catch (e) {
            throw e instanceof SdkError ? e : fromConnect(e);
        }
    }
    async exec(name, command, options) {
        const stdout = [];
        const stderr = [];
        let exitCode;
        for await (const event of this.execStream(name, command, options)) {
            if ('type' in event) {
                exitCode = event.exitCode;
            }
            else if (event.stream === 'stdout') {
                stdout.push(event.data);
            }
            else {
                stderr.push(event.data);
            }
        }
        if (exitCode === undefined)
            throw new SdkError('rpc', 'ExecSandbox stream ended without an exit event');
        return {
            exitCode,
            stdout: Buffer.concat(stdout),
            stderr: Buffer.concat(stderr),
        };
    }
    // TTY + stdin transport half of an interactive exec. The first client frame
    // is the `start` variant carrying the exec request; subsequent frames are
    // `stdin`/`resize`. No terminal glue: raw mode, signal forwarding, and
    // SIGWINCH stay with the caller.
    async execInteractive(name, command, options) {
        let sandboxId;
        try {
            sandboxId = (await this.get(name, { workspace: options?.workspace, ...(options?.signal ? { signal: options.signal } : {}) })).id;
        }
        catch (e) {
            throw e instanceof SdkError ? e : fromConnect(e);
        }
        const input = new Pushable();
        input.push({
            payload: {
                case: 'start',
                value: {
                    sandboxId,
                    command,
                    workdir: options?.workdir ?? '',
                    environment: options?.environment ?? {},
                    executionTimeout: durationFromSeconds(options?.timeoutSecs ?? 0),
                    stdin: new Uint8Array(),
                    tty: options?.tty ?? true,
                    cols: options?.cols ?? 0,
                    rows: options?.rows ?? 0,
                    noLoginShell: options?.noLoginShell ?? false,
                },
            },
        });
        const stream = this.grpc.execSandboxInteractive(input, { signal: options?.signal });
        let resolveDone;
        let rejectDone;
        const done = new Promise((resolve, reject) => {
            resolveDone = resolve;
            rejectDone = reject;
        });
        // `done` may settle before (or without) anyone awaiting it. A lone handler
        // keeps an unobserved rejection from surfacing as an unhandledRejection;
        // real awaiters still receive it through their own handler.
        void done.catch(() => { });
        // Settle exactly once. The exit code wins; error/abandonment only apply
        // when no exit was observed.
        let settled = false;
        const settleExit = (code) => {
            if (settled)
                return;
            settled = true;
            resolveDone(code);
        };
        const settleError = (err) => {
            if (settled)
                return;
            settled = true;
            rejectDone(err);
        };
        async function* output() {
            let sawExit = false;
            try {
                for await (const event of stream) {
                    switch (event.payload.case) {
                        case 'stdout':
                            yield {
                                stream: 'stdout',
                                data: Buffer.from(event.payload.value.data),
                            };
                            break;
                        case 'stderr':
                            yield {
                                stream: 'stderr',
                                data: Buffer.from(event.payload.value.data),
                            };
                            break;
                        case 'exit':
                            sawExit = true;
                            // Settle `done` before yielding: a consumer that breaks on the
                            // exit event abandons the generator at the yield, so anything
                            // after it would never run.
                            settleExit(event.payload.value.exitCode);
                            yield { type: 'exit', exitCode: event.payload.value.exitCode };
                            break;
                    }
                }
                if (!sawExit) {
                    throw new SdkError('rpc', 'ExecSandboxInteractive stream ended without an exit event');
                }
            }
            catch (e) {
                const err = e instanceof SdkError ? e : fromConnect(e);
                settleError(err);
                throw err;
            }
            finally {
                input.end();
                // Consumer abandoned the stream before an exit event (early break or
                // return): settle `done` so it can never hang.
                settleError(new SdkError('rpc', 'exec output abandoned before exit'));
            }
        }
        return {
            output: output(),
            write(data) {
                input.push({ payload: { case: 'stdin', value: new Uint8Array(data) } });
            },
            resize(cols, rows) {
                input.push({ payload: { case: 'resize', value: { cols, rows } } });
            },
            close() {
                input.end();
            },
            done,
        };
    }
    // Bind a local TCP listener that tunnels each accepted connection into the
    // sandbox. Mirrors the CLI service forward: READY check, then per socket mint
    // a short-lived SSH session token, open a forwardTcp bidi whose first frame is
    // the `init` (TCP target + token), relay bytes both ways in ~64 KiB chunks,
    // and revoke the token on close. Process-lifetime only.
    async forward(name, opts) {
        const targetHost = opts.targetHost ?? '127.0.0.1';
        const targetPort = opts.targetPort;
        const localHost = opts.localHost ?? '127.0.0.1';
        const localPort = opts.localPort ?? 0;
        let sandboxId;
        try {
            const ref = await this.get(name, { workspace: opts.workspace, ...(opts.signal ? { signal: opts.signal } : {}) });
            if (ref.phase !== 'ready') {
                throw new SdkError('connect', `sandbox '${name}' is not ready (phase: ${ref.phase})`);
            }
            sandboxId = ref.id;
        }
        catch (e) {
            throw e instanceof SdkError ? e : fromConnect(e);
        }
        const sockets = new Set();
        const controllers = new Set();
        const connectionTasks = new Set();
        let closing = false;
        const server = net.createServer((socket) => {
            sockets.add(socket);
            socket.on('close', () => sockets.delete(socket));
            // Guard the window before forwardConnection attaches its own handlers
            // (it first awaits createSshSession). Without a synchronous 'error'
            // listener a peer reset here emits an unhandled 'error' and crashes the
            // process; forwardConnection's catch still tears the socket down.
            socket.on('error', () => { });
            const controller = new AbortController();
            controllers.add(controller);
            const task = this.forwardConnection(socket, sandboxId, name, targetHost, targetPort, controller.signal)
                .catch((error) => {
                if (!closing) {
                    try {
                        opts.onConnectionError?.(error instanceof SdkError ? error : fromConnect(error));
                    }
                    catch {
                        // Consumer callbacks must not turn a handled connection failure
                        // into an unhandled rejection or prevent forward cleanup.
                    }
                }
            })
                .finally(() => {
                controllers.delete(controller);
                connectionTasks.delete(task);
            });
            connectionTasks.add(task);
        });
        let resolveClosed;
        const closed = new Promise((resolve) => {
            resolveClosed = resolve;
        });
        await new Promise((resolve, reject) => {
            const onError = (err) => {
                reject(new SdkError('io', `failed to bind local forward on ${localHost}:${localPort}: ${err instanceof Error ? err.message : String(err)}`));
            };
            server.once('error', onError);
            server.listen(localPort, localHost, () => {
                server.removeListener('error', onError);
                resolve();
            });
        });
        let teardownPromise;
        const onAbort = () => {
            void teardown();
        };
        const teardown = () => {
            if (teardownPromise)
                return teardownPromise;
            closing = true;
            opts.signal?.removeEventListener('abort', onAbort);
            teardownPromise = (async () => {
                for (const controller of controllers)
                    controller.abort();
                for (const socket of sockets)
                    socket.destroy();
                if (server.listening) {
                    await new Promise((resolve) => server.close(() => resolve()));
                }
                await Promise.allSettled([...connectionTasks]);
                resolveClosed();
            })();
            return teardownPromise;
        };
        // Caller cancellation tears the local listener down the same way close() does.
        if (opts.signal) {
            if (opts.signal.aborted)
                void teardown();
            else
                opts.signal.addEventListener('abort', onAbort, { once: true });
        }
        const addr = server.address();
        return {
            localHost,
            localPort: addr ? addr.port : localPort,
            targetHost,
            targetPort,
            close: teardown,
            closed,
        };
    }
    async forwardConnection(socket, sandboxId, name, targetHost, targetPort, signal) {
        let token;
        const input = new Pushable();
        input.onDrain = () => socket.resume();
        try {
            const session = await this.grpc.createSshSession({ sandboxId }, { signal });
            // Defense-in-depth: the token feeds forwardTcp authorization, so hold it
            // to the same trust-boundary contract as createSshSession. A violation
            // tears down this one socket via the catch below.
            validateSshResponse(session, sandboxId);
            token = session.token;
            input.push({
                payload: {
                    case: 'init',
                    value: {
                        sandboxId,
                        serviceId: `service-forward:${name}:${targetHost}:${targetPort}`,
                        target: {
                            case: 'tcp',
                            value: { host: targetHost, port: targetPort },
                        },
                        authorizationToken: token,
                    },
                },
            });
            socket.on('data', (chunk) => {
                for (let off = 0; off < chunk.length; off += FORWARD_CHUNK) {
                    const slice = chunk.subarray(off, Math.min(off + FORWARD_CHUNK, chunk.length));
                    input.push({
                        payload: { case: 'data', value: new Uint8Array(slice) },
                    });
                }
                if (input.size >= 64)
                    socket.pause();
            });
            socket.on('end', () => input.end());
            socket.on('error', (error) => input.end(error));
            socket.on('close', () => input.end());
            const onAbort = () => {
                input.end(new SdkError('canceled', 'forward connection closed'));
                socket.destroy();
            };
            signal.addEventListener('abort', onAbort, { once: true });
            try {
                for await (const frame of this.grpc.forwardTcp(input, { signal })) {
                    if (frame.payload.case !== 'data')
                        continue;
                    const data = frame.payload.value;
                    if (data.length === 0)
                        continue;
                    // Respect backpressure: if the local socket buffer is full, stop
                    // pulling sandbox data until it drains so memory stays bounded.
                    if (!socket.write(Buffer.from(data)))
                        await waitForDrain(socket);
                }
            }
            finally {
                signal.removeEventListener('abort', onAbort);
            }
            socket.end();
        }
        catch (e) {
            socket.destroy();
            throw e instanceof SdkError ? e : fromConnect(e);
        }
        finally {
            input.end();
            if (token !== undefined) {
                try {
                    await this.grpc.revokeSshSession({ token, allowMissing: true }, { signal });
                }
                catch {
                    // Best-effort revoke; the token expires on its own regardless.
                }
            }
        }
    }
    // Mint a short-lived SSH session token for the sandbox — the input side of
    // ssh-config / ProxyCommand and forwardTcp authorization.
    async createSshSession(name, options) {
        try {
            const sandbox = await this.get(name, options);
            const resp = await this.grpc.createSshSession({ sandboxId: sandbox.id });
            // Reject any response outside the proto trust-boundary contract before
            // handing these values to the caller (they feed OpenSSH ProxyCommand).
            validateSshResponse(resp, sandbox.id);
            return {
                sandboxId: resp.sandboxId,
                token: resp.token,
                gatewayHost: resp.gatewayHost,
                gatewayPort: resp.gatewayPort,
                gatewayScheme: resp.gatewayScheme,
                ...(resp.hostKeyFingerprint ? { hostKeyFingerprint: resp.hostKeyFingerprint } : {}),
                ...(timestampMillis(resp.expirationTime) ? { expiresAtMs: timestampMillis(resp.expirationTime) } : {}),
            };
        }
        catch (e) {
            throw e instanceof SdkError ? e : fromConnect(e);
        }
    }
    async revokeSshSession(token, options) {
        try {
            const resp = await this.grpc.revokeSshSession({ token, allowMissing: options?.allowMissing ?? false });
            return deletionResult(resp);
        }
        catch (e) {
            throw fromConnect(e);
        }
    }
    async attachProvider(name, provider, options) {
        try {
            const resp = await this.grpc.attachSandboxProvider({
                sandboxName: name,
                providerName: provider,
                expectedResourceVersion: versionPin(options?.expectedResourceVersion),
                workspaceScope: workspaceScope(options),
            });
            return { sandbox: sandboxRef(resp.sandbox), changed: resp.attached };
        }
        catch (e) {
            throw fromConnect(e);
        }
    }
    async detachProvider(name, provider, options) {
        try {
            const resp = await this.grpc.detachSandboxProvider({
                sandboxName: name,
                providerName: provider,
                expectedResourceVersion: versionPin(options?.expectedResourceVersion),
                workspaceScope: workspaceScope(options),
            });
            return { sandbox: sandboxRef(resp.sandbox), changed: resp.detached };
        }
        catch (e) {
            throw fromConnect(e);
        }
    }
    async listProviders(name, options) {
        try {
            const resp = await this.grpc.listSandboxProviders({
                sandboxName: name,
                workspaceScope: workspaceScope(options),
            });
            return resp.providers.map((p) => providerRef(p));
        }
        catch (e) {
            throw fromConnect(e);
        }
    }
    async getConfig(name, options) {
        try {
            const sandbox = await this.get(name, options);
            const resp = await this.grpc.getSandboxConfig({ sandboxId: sandbox.id }, requestCallOptions(options));
            return sandboxConfig(resp);
        }
        catch (e) {
            throw e instanceof SdkError ? e : fromConnect(e);
        }
    }
    // Update the sandbox-scoped policy. Sandbox scope (global=false) may only
    // change network_policies; static fields must match the create-time policy or
    // the gateway rejects the update. With `wait`, poll getConfig until the
    // applied policy hash is observed.
    async setPolicy(name, policy, options) {
        try {
            const resp = await this.grpc.updateConfig({
                name,
                policy,
                global: false,
                expectedResourceVersion: versionPin(options?.expectedResourceVersion),
                workspaceScope: workspaceScope(options),
            });
            const result = updateConfigResult(resp);
            if (options?.wait)
                await this.waitForPolicyHash(name, result.policyHash, options.waitTimeoutSecs, options.workspace);
            return result;
        }
        catch (e) {
            throw e instanceof SdkError ? e : fromConnect(e);
        }
    }
    // Upsert a single sandbox-scoped setting. Sandbox-scoped deletes are rejected
    // by the gateway, so there is no sandbox-scoped delete on this surface.
    async setSetting(name, key, value, options) {
        try {
            const resp = await this.grpc.updateConfig({
                name,
                settingKey: key,
                settingValue: value,
                global: false,
                workspaceScope: workspaceScope(options),
            });
            return updateConfigResult(resp);
        }
        catch (e) {
            throw fromConnect(e);
        }
    }
    // Poll getConfig until the applied policy hash is observed. Each poll RPC is
    // bounded by the remaining deadline (deadlineOptions), so a stalled getConfig
    // cannot make the returned promise outlive timeoutSecs.
    async waitForPolicyHash(name, policyHash, timeoutSecs = 60, workspace) {
        const deadline = Date.now() + timeoutSecs * 1000;
        let delay = 100;
        for (;;) {
            let config;
            const pollOptions = deadlineOptions(deadline - Date.now());
            try {
                config = await this.getConfig(name, { ...pollOptions, workspace });
            }
            catch (e) {
                if (pollOptions.signal?.aborted || Date.now() >= deadline) {
                    throw new SdkError('connect', `timed out waiting for policy '${policyHash}' on sandbox '${name}'`);
                }
                throw e instanceof SdkError ? e : fromConnect(e);
            }
            if (config.policyHash === policyHash)
                return;
            if (Date.now() >= deadline) {
                throw new SdkError('connect', `timed out waiting for policy '${policyHash}' on sandbox '${name}'`);
            }
            await waitSleep(delay, deadline);
            delay = Math.min(delay * 2, 2000);
        }
    }
}
// ---- The client ------------------------------------------------------------
export class OpenShellClient {
    /** Sandbox lifecycle + exec: create/get/list/delete, waitReady/waitDeleted, exec. */
    sandbox;
    /** Reusable sandbox workload template lifecycle. */
    sandboxTemplates;
    /**
     * Advanced escape hatch: a generated client for every gateway RPC, including
     * surface the curated sub-clients do not wrap yet (gateway config, provider
     * CRUD, policy status, watch, logs, and the full observed Sandbox). See
     * '@nvidia/openshell-sdk/raw' for the generated request/response types.
     */
    raw;
    /** The shared Connect transport, for building extra clients over the same connection. */
    transport;
    grpc;
    constructor(transport) {
        // One transport (one connection) shared across every scoped client.
        this.transport = transport;
        this.grpc = createClient(OpenShell, transport);
        this.raw = this.grpc;
        this.sandbox = new SandboxClient(transport, this.grpc);
        this.sandboxTemplates = new SandboxTemplateClient(transport, this.grpc);
    }
    /**
     * Constructs a lazy Connect client. No network request is made until the
     * first RPC; call health() when startup must verify gateway reachability.
     */
    static async connect(options) {
        return new OpenShellClient(buildTransport(options));
    }
    // Gateway-scoped, so it stays top-level rather than under a namespace.
    async health() {
        try {
            const resp = await this.grpc.health({});
            return { status: statusName(resp.status), version: resp.version };
        }
        catch (e) {
            throw fromConnect(e);
        }
    }
}