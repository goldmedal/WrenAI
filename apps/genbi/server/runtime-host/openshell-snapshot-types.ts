import { z } from "zod";
import { openShellIdentitySchema } from "./openshell-types.js";
const digest = z.string().regex(/^sha256:[a-f0-9]{64}$/);
export const snapshotFileSchema = z.object({ path: z.string().min(1).max(240), size: z.number().int().nonnegative().max(134_217_728), sha256: z.string().regex(/^[a-f0-9]{64}$/) }).strict();
export const snapshotManifestSchema = z.object({ version: z.literal(1), project: digest, bindingGeneration: z.string().regex(/^[0-9]{1,20}$/), bindingRevision: digest,
  context: digest, source: digest, files: z.array(snapshotFileSchema).max(4096), digest }).strict();
export type SnapshotManifest = z.infer<typeof snapshotManifestSchema>;
export const snapshotPublicationSchema = z.object({ id: z.uuid(), owner: z.uuid(), volume: z.string().regex(/^genbi-snapshot-[a-f0-9]{32}$/),
  configuration: digest, identity: openShellIdentitySchema, createdAt: z.number().int().nonnegative(),
  phase: z.enum(["intent", "publishing", "ready", "cleanup_pending", "cleaned"]), manifest: snapshotManifestSchema.optional(),
  helperIds: z.array(z.string().regex(/^[a-f0-9]{64}$/)).max(256), helperNames: z.array(z.string().regex(/^genbi-snapshot-[a-f0-9]{32}-(?:publish|verify)-[a-f0-9]{32}$/)).max(256), interrupted: z.boolean(), acknowledged: z.boolean(),
}).strict().refine((row) => row.volume === `genbi-snapshot-${row.owner.replaceAll("-", "")}`);
export type SnapshotPublication = z.infer<typeof snapshotPublicationSchema>;
export const snapshotReferenceSchema = z.object({ id: z.uuid(), publication: z.uuid(), identity: openShellIdentitySchema,
  phase: z.enum(["pending", "active", "releasing", "released"]), workerId: z.uuid().optional(), interrupted: z.boolean(),
}).strict();
export type SnapshotReference = z.infer<typeof snapshotReferenceSchema>;
export interface SnapshotJournal {
  listSnapshotPublications(): readonly SnapshotPublication[];
  saveSnapshotPublication(row: SnapshotPublication): void;
  listSnapshotReferences(): readonly SnapshotReference[];
  saveSnapshotReference(row: SnapshotReference): void;
}
export interface SnapshotMount { readonly volume: string; readonly owner: string; readonly digest: string }
