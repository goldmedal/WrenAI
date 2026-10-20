import type { NativeSessionReadiness } from '@/bff/client';

/** The BFF refuses new OpenShell launches while another one is provisioning; this is that refusal's code. */
export const LAUNCH_IN_PROGRESS_CODE = 'openshell_launch_in_progress';
/** Readiness re-poll cadence while that refusal is shown. */
export const LAUNCH_IN_PROGRESS_POLL_MS = 3_000;
/** Re-polls before giving up (about two minutes); a reload or new mount starts again. */
export const LAUNCH_IN_PROGRESS_POLL_CAP = 40;

export function launchInProgress(native: NativeSessionReadiness | undefined, structured: { code?: string } | undefined): boolean {
  const selected = native?.runtimeHost?.selectedReadiness;
  return (selected?.state !== undefined && selected.state !== 'ready' && selected.code === LAUNCH_IN_PROGRESS_CODE) || structured?.code === LAUNCH_IN_PROGRESS_CODE;
}
