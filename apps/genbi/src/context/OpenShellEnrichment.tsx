import { useEffect, useState } from 'react';
import { Alert, Button, Space, Spin, Tag, Typography } from 'antd';
import {
  applyEnrichmentRun,
  authorizeEnrichmentApply,
  discardEnrichmentRun,
  startContextEnrichment,
} from '@/bff/client';
import type { EnrichmentDiffEntry, EnrichmentRun, EnrichmentRunState } from '@/bff/client';
import { useContextStore } from './useContextStore';

const POLL_MS = 2000;
const IN_FLIGHT: readonly EnrichmentRunState[] = ['drafting', 'validation_pending', 'applying'];
const REVOCATION_PENDING_NOTICE = 'existing sessions are fenced; runtime cleanup pending';
const UNSUPPORTED_BY_RUNTIME_NOTICE = 'Under OpenShell, enrichment can only change knowledge, descriptions and relationships in files that already exist. This proposal needs a change outside that scope, so it cannot be applied here.';

/** Static, human wording per sanitized server code; an unknown code is shown as the bare code. */
const APPLY_CODE_TEXT: Record<string, string> = {
  binding_changed: 'The project binding changed since the review.',
  account_changed: 'The model account changed since the review.',
  manifest_drift: 'A project file changed since the review.',
  target_changed: 'A target file changed since the review.',
  symlink: 'A project path is a link or not a regular file.',
  unsupported_by_runtime: 'The change set is outside what this runtime supports.',
  mdl_invalid: 'The validated MDL does not match its receipt.',
  too_large: 'A project file exceeds the apply limits.',
};

function errorText(error: unknown): string {
  return error instanceof Error && error.message ? error.message : 'The request failed.';
}

function FileDiff({ entry }: { entry: EnrichmentDiffEntry }) {
  const block: React.CSSProperties = { margin: 0, padding: 8, maxHeight: 240, overflow: 'auto', whiteSpace: 'pre-wrap', wordBreak: 'break-word', fontSize: 12, background: 'rgba(0,0,0,0.04)', borderRadius: 4 };
  return <div data-testid="enrichment-diff-file" style={{ marginBottom: 12 }}>
    <Typography.Text strong code>{entry.path}</Typography.Text>
    {entry.truncated ? <Typography.Text type="warning" style={{ marginLeft: 8 }}>Shown text was truncated by the server.</Typography.Text> : null}
    {entry.appended !== null ? <>
      <div style={{ marginTop: 4 }}><Typography.Text type="secondary">Appended to the existing file</Typography.Text></div>
      <pre aria-label={`Appended text for ${entry.path}`} style={block}>{entry.appended}</pre>
    </> : <>
      <div style={{ marginTop: 4 }}><Typography.Text type="secondary">Before</Typography.Text></div>
      <pre aria-label={`Before text for ${entry.path}`} style={block}>{entry.before}</pre>
      <div style={{ marginTop: 4 }}><Typography.Text type="secondary">After</Typography.Text></div>
      <pre aria-label={`After text for ${entry.path}`} style={block}>{entry.after}</pre>
    </>}
  </div>;
}

function Checks({ run }: { run: EnrichmentRun }) {
  const checks = run.review?.receipt.checks ?? run.validation?.checks ?? [];
  if (checks.length === 0) return null;
  return <ul style={{ margin: '8px 0', paddingLeft: 20 }}>
    {checks.map((check) => <li key={check.check}>
      <Tag color={check.status === 'pass' ? 'success' : check.status === 'fail' ? 'error' : 'default'}>{check.status}</Tag>
      {check.check}{check.code ? ` (${check.code})` : ''}{check.message ? ` - ${check.message}` : ''}
    </li>)}
  </ul>;
}

/**
 * OpenShell enrichment: start a run, review the host-captured diff and validator result, then Apply (authorize -> confirm -> apply
 * with the one-use capability) or Discard. The capability exists only inside `confirmApply`'s call frame: it is never stored, shown or logged.
 */
export function OpenShellEnrichment() {
  const enrichment = useContextStore((s) => s.enrichment);
  const loadEnrichment = useContextStore((s) => s.loadEnrichment);
  const run = enrichment?.run;
  const [busy, setBusy] = useState<'start' | 'apply' | 'discard'>();
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState<string>();
  const [fenceNotice, setFenceNotice] = useState<string>();

  const inFlight = busy === 'start' || (run !== undefined && IN_FLIGHT.includes(run.status));
  useEffect(() => {
    if (!inFlight) return undefined;
    const timer = setInterval(() => loadEnrichment(), POLL_MS);
    return () => clearInterval(timer);
  }, [inFlight, loadEnrichment]);
  useEffect(() => { setConfirming(false); }, [run?.id, run?.status]);

  const start = async () => {
    setBusy('start'); setError(undefined); setFenceNotice(undefined);
    try { await startContextEnrichment('grill'); } catch (e) { setError(errorText(e)); } finally { setBusy(undefined); loadEnrichment(); }
  };

  const confirmApply = async () => {
    if (!run) return;
    setBusy('apply'); setError(undefined);
    try {
      const minted = await authorizeEnrichmentApply(run.id);
      if (!minted.capability || !minted.reviewSha256) throw new Error('The server did not authorize the apply.');
      const applied = await applyEnrichmentRun(run.id, minted.capability, minted.reviewSha256);
      setFenceNotice(applied.revocationPending ? run.id : undefined);
    } catch (e) { setError(errorText(e)); } finally { setConfirming(false); setBusy(undefined); loadEnrichment(); }
  };

  const discard = async () => {
    if (!run) return;
    setBusy('discard'); setError(undefined);
    try { await discardEnrichmentRun(run.id); } catch (e) { setError(errorText(e)); } finally { setBusy(undefined); loadEnrichment(); }
  };

  const canStart = enrichment?.foundationReady !== false && enrichment?.capabilities?.draft?.available !== false && busy === undefined && !(run && (IN_FLIGHT.includes(run.status) || run.status === 'awaiting_decision' || run.status === 'reconcile_required'));
  const revocationPending = run !== undefined && (fenceNotice === run.id || run.events.some((event) => event.kind === 'revocation_pending'));
  const unavailable = enrichment?.capabilities?.draft?.available === false ? enrichment.capabilities.draft.reason : undefined;

  return <div data-testid="openshell-enrichment" style={{ marginTop: 16 }}>
    <Typography.Title level={5} style={{ marginTop: 0 }}>Review and apply enrichment</Typography.Title>
    <Space direction="vertical" style={{ width: '100%' }} size={8}>
      {run?.status === 'drafting' || run?.status === 'validation_pending' || busy === 'start' && !run
        ? <div role="status"><Spin size="small" /> <Typography.Text>{run?.status === 'validation_pending' ? 'Validating the proposed change in an isolated sandbox.' : 'Drafting a proposal.'}</Typography.Text></div> : null}

      {run?.status === 'awaiting_decision' && run.review ? <>
        <Typography.Text>The sandbox validated this change set. Review the exact files below, then apply all of it or discard it.</Typography.Text>
        {run.review.diff.map((entry) => <FileDiff key={entry.path} entry={entry} />)}
        <Checks run={run} />
        {confirming ? <Alert type="warning" showIcon message="Confirm apply" description={<>
          <div>This writes to the project: {run.review.diff.map((entry) => entry.path).join(', ')}.</div>
          <div>Existing sessions will be revoked and must be restarted.</div>
          <Space style={{ marginTop: 8 }}>
            <Button type="primary" loading={busy === 'apply'} onClick={confirmApply}>Confirm apply</Button>
            <Button disabled={busy === 'apply'} onClick={() => setConfirming(false)}>Cancel</Button>
          </Space>
        </>} /> : <Space>
          <Button type="primary" disabled={busy !== undefined} onClick={() => setConfirming(true)}>Apply</Button>
          <Button disabled={busy !== undefined} loading={busy === 'discard'} onClick={discard}>Discard</Button>
        </Space>}
      </> : null}

      {run?.status === 'validation_failed' ? <>
        <Alert type="error" showIcon message={`Validation failed (${run.validation?.code ?? 'unknown'})`}
          description={run.validation?.code === 'unsupported_by_runtime' ? UNSUPPORTED_BY_RUNTIME_NOTICE : run.validation?.message ?? run.error ?? 'The proposed change did not pass validation.'} />
        <Checks run={run} />
        <Button disabled={busy !== undefined} loading={busy === 'discard'} onClick={discard}>Discard</Button>
      </> : null}

      {run?.status === 'applied' ? <>
        <Alert type="success" showIcon message="Applied" description="The change was written to the project. Existing sessions were revoked; start a new session to use it." />
        {revocationPending ? <Alert type="info" showIcon message={REVOCATION_PENDING_NOTICE} /> : null}
        {run.apply?.receipt ? <div data-testid="enrichment-receipt">
          <Typography.Text type="secondary">Receipt, applied at {run.apply.receipt.appliedAt}</Typography.Text>
          <ul style={{ margin: '4px 0', paddingLeft: 20 }}>{run.apply.receipt.files.map((file) => <li key={file.path}><Typography.Text code>{file.path}</Typography.Text></li>)}</ul>
        </div> : null}
      </> : null}

      {run?.status === 'apply_refused' ? <Alert type="warning" showIcon message="Apply refused; nothing was written"
        description={run.apply?.code ? <>{APPLY_CODE_TEXT[run.apply.code] ?? 'The server refused the apply.'} <Typography.Text code>{run.apply.code}</Typography.Text></> : 'The server refused the apply.'} /> : null}

      {run?.status === 'apply_failed' ? <Alert type="error" showIcon message="Apply failed"
        description="The apply did not complete and the project was rolled back to its previous state."
        action={run.apply?.code ? <Typography.Text code>{run.apply.code}</Typography.Text> : undefined} /> : null}

      {run?.status === 'reconcile_required' ? <Alert type="error" showIcon message="Reconciliation required"
        description="The apply was interrupted and the project files could not be restored automatically. An operator must reconcile them before another apply can run." /> : null}

      {run?.status === 'discarded' ? <Alert type="info" showIcon message="Discarded" description="This proposal was discarded and nothing was written to the project." /> : null}

      {error ? <Alert type="error" showIcon message={error} /> : null}
      {unavailable ? <Typography.Text type="secondary">Enrichment drafting is unavailable: {unavailable}</Typography.Text> : null}
      <Button onClick={start} disabled={!canStart} loading={busy === 'start'}>Start enrichment run</Button>
    </Space>
  </div>;
}
