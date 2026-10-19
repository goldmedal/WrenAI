import { z } from "zod";
import { RUNTIME_BACKEND_REASON_CODES, type RuntimeBackendReasonCode } from "./types.js";
import { runtimeNotReady } from "./policy.js";

const digest = z.string().regex(/^sha256:[a-f0-9]{64}$/);
const token = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/);
/** Host-produced authority only. No endpoint, command, credential or project bytes. */
const baseIdentitySchema = z.object({
  backend: z.literal("openshell"), account: digest, generation: token,
  session: token, turn: token, binding: token, bindingGeneration: token, bindingRevision: digest,
  context: digest, plan: digest, image: digest, policy: digest,
  gateway: token, workspace: token, configuration: digest,
}).strict();
export const openShellIdentitySchema = z.discriminatedUnion("purpose", [
  baseIdentitySchema.extend({ purpose: z.literal("lifecycle"), operation: z.literal("worker"), snapshot: z.literal("none") }),
  baseIdentitySchema.extend({ purpose: z.literal("model"), operation: z.literal("step"), snapshot: z.literal("none"), invocation: z.uuid(), step: z.uuid(), attempt: z.literal(1), model: token, tier: token }),
  baseIdentitySchema.omit({ turn: true }).extend({ purpose: z.literal("model_session"), operation: z.literal("session"), snapshot: z.literal("none") }),
  baseIdentitySchema.extend({ purpose: z.literal("data"), operation: z.literal("read"), snapshot: digest, publication: z.uuid(), reference: z.uuid() }),
  // A separate, credential-less enrichment validator: same image/policy/snapshot shape as `data/read`, never the same authority.
  baseIdentitySchema.extend({ purpose: z.literal("validate"), operation: z.literal("check"), snapshot: digest, publication: z.uuid(), reference: z.uuid() }),
]);
export type OpenShellIdentity = z.infer<typeof openShellIdentitySchema>;
/** Identities whose sandbox mounts one published project snapshot read-only. */
export type OpenShellSnapshotIdentity = Extract<OpenShellIdentity, { purpose: "data" | "validate" }>;
export const isSnapshotIdentity = (identity: OpenShellIdentity): identity is OpenShellSnapshotIdentity => identity.purpose === "data" || identity.purpose === "validate";
export type OpenShellReason = RuntimeBackendReasonCode<"openshell">;
export class OpenShellError extends Error {
  constructor(readonly code: OpenShellReason) { super(runtimeNotReady("openshell", "unavailable", code).message); }
}
export const OPEN_SHELL_OWNER_LABEL = "genbi-lifecycle-owner";
export interface OpenShellResource {
  readonly id: string;
  readonly name: string;
  readonly workspace: string;
  readonly labels: Readonly<Record<string, string>>;
  readonly containers?: readonly string[];
  readonly volumes?: readonly string[];
}
export interface OpenShellIntent {
  readonly id: string;
  readonly owner: string;
  readonly name: string;
  readonly identity: OpenShellIdentity;
  readonly createdAt: number;
  readonly phase: "intent" | "active" | "cleanup_pending" | "cleaned";
  readonly acknowledged: boolean;
  readonly remoteId?: string | undefined;
  readonly containers?: readonly string[] | undefined;
  readonly volumes?: readonly string[] | undefined;
  readonly error?: OpenShellReason | undefined;
  readonly interrupted: boolean;
}
export const openShellIntentSchema = z.object({
  id: z.uuid(), owner: z.uuid(), name: z.string().regex(/^gb-[a-f0-9]{16}$/), identity: openShellIdentitySchema,
  createdAt: z.number().int().nonnegative(), phase: z.enum(["intent", "active", "cleanup_pending", "cleaned"]),
  acknowledged: z.boolean(), interrupted: z.boolean(), remoteId: token.optional(),
  containers: z.array(z.string().regex(/^[a-f0-9]{64}$/)).max(2).optional(),
  volumes: z.array(z.string().regex(/^openshell-(?:channel|supervisor)-[a-f0-9]+$/)).max(2).optional(),
  error: z.enum(RUNTIME_BACKEND_REASON_CODES.openshell).optional(),
}).strict().refine((intent) => intent.name === `gb-${intent.owner.replaceAll("-", "").slice(0, 16)}`);
export interface OpenShellJournal {
  listOpenShellIntents(): readonly OpenShellIntent[];
  saveOpenShellIntent(intent: OpenShellIntent): void;
  interruptOpenShellWork(intent: OpenShellIntent): void;
}
/** All operations must settle under a bound. A killed local RPC is remote uncertainty. */
export interface OpenShellDriver {
  readonly version: string;
  readonly identity: Pick<OpenShellIdentity, "image" | "policy" | "gateway" | "workspace" | "configuration">;
  readonly modelIdentity?: OpenShellDriver["identity"] | undefined;
  duplex?(intent: OpenShellIntent, argv: readonly string[], signal: AbortSignal): Promise<OpenShellDuplex>;
  readonly dataIdentity?: OpenShellDriver["identity"] | undefined;
  /** True only when the protected descriptor names a validator digest equal to the packaged script (fail closed otherwise). */
  validatorReady?(): boolean;
  probe(): Promise<void>;
  create(intent: OpenShellIntent, signal: AbortSignal): Promise<OpenShellResource>;
  list(intent: OpenShellIntent): Promise<readonly OpenShellResource[]>;
  inspect(intent: OpenShellIntent, purpose?: "runnable" | "cleanup"): Promise<OpenShellResource>;
  remove(intent: OpenShellIntent): Promise<void>;
  assertAbsent(intent: OpenShellIntent): Promise<void>;
  exec(intent: OpenShellIntent, argv: readonly string[], signal: AbortSignal): Promise<string>;
}

export interface OpenShellDuplex {
  readonly output: AsyncIterable<{ stream: "stdout" | "stderr"; data: Buffer } | { type: "exit"; exitCode: number }>;
  write(data: Buffer): void;
  close(): void;
  readonly done: Promise<number>;
}
