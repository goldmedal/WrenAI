import { beforeEach, describe, expect, it, vi } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderWithProviders } from '@/test/utils';
import type { EnrichmentRun, EnrichmentStatus } from '@/bff/client';

const client = vi.hoisted(() => ({
  status: vi.fn(), start: vi.fn(), authorize: vi.fn(), apply: vi.fn(), discard: vi.fn(),
}));
vi.mock('@/bff/env', () => ({ isBffEnabled: () => true }));
vi.mock('@/bff/client', () => ({
  getContextEnrichment: client.status,
  startContextEnrichment: client.start,
  authorizeEnrichmentApply: client.authorize,
  applyEnrichmentRun: client.apply,
  discardEnrichmentRun: client.discard,
  getContextFiles: vi.fn(), getContextImpact: vi.fn(), getContextOverview: vi.fn(),
  getNativeSessionReadiness: () => Promise.resolve({ runtime: { configured: false }, purposes: {} }), createNativeSession: vi.fn(), getRuntimeSettingsReadiness: () => Promise.resolve({ valid: true as const }),
}));
import { OpenShellEnrichment } from '../OpenShellEnrichment';
import { EnrichmentPanel } from '../EnrichmentPanel';
import { useContextStore } from '../useContextStore';

const SECRET = 'capability-secret-0123456789';

function run(overrides: Partial<EnrichmentRun> = {}): EnrichmentRun {
  return {
    id: 'run-1', mode: 'grill', projectRevision: 'sha256:r', bindingGeneration: 1, version: 3, proposalId: 'p', proposalHash: 'h', status: 'awaiting_decision',
    createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z', operations: [], events: [], audit: { entries: [], history: [] }, backend: 'openshell', ...overrides,
  };
}
const review = (diff: NonNullable<EnrichmentRun['review']>['diff'] = [{ path: 'knowledge/rules/revenue.md', change: 'modified', beforeSha256: 'a', afterSha256: 'b', before: 'Old rule.\n', after: 'Old rule.\nNew rule.\n', appended: 'New rule.\n' }]): EnrichmentRun['review'] => ({
  diff, diffSha256: 'sha256:diff', binding: { generation: 1, revision: 'sha256:r' }, snapshot: { digest: 'sha256:s' },
  receipt: { checks: [{ check: 'context_validate', status: 'pass' }], mdl: { sha256: 'sha256:m', size: 10 }, changeSetSha256: 'sha256:c' },
});
const receipt = { version: 1 as const, appliedAt: '2026-01-01T00:01:00Z', runId: 'run-1', diffSha256: 'sha256:diff', changeSetSha256: 'sha256:c', files: [{ path: 'knowledge/rules/revenue.md', beforeSha256: 'a', afterSha256: 'b' }], mdl: { sha256: 'sha256:m', written: true }, previousBinding: { generation: 1, revision: 'sha256:r' }, binding: { generation: 2, revision: 'sha256:r2' } };

let current: EnrichmentStatus;
function seed(next?: EnrichmentRun, extra: Partial<EnrichmentStatus> = {}) {
  current = { available: true, foundationReady: true, backend: 'openshell', capabilities: { draft: { available: true }, apply: { available: true }, approval: { available: true }, reconcile: { available: true } }, run: next, ...extra };
  useContextStore.setState({ enrichment: current });
}

beforeEach(() => {
  window.sessionStorage.clear(); window.localStorage.clear();
  Object.values(client).forEach((fn) => fn.mockReset());
  client.status.mockImplementation(() => Promise.resolve(current));
  useContextStore.setState({ enrichment: undefined, enrichmentLoading: false, enrichmentError: undefined });
});

describe('OpenShellEnrichment states', () => {
  it('validation_pending shows a progress state and no actions', () => {
    seed(run({ status: 'validation_pending' }));
    renderWithProviders(<OpenShellEnrichment />);
    expect(screen.getByRole('status')).toHaveTextContent('Validating the proposed change');
    expect(screen.queryByRole('button', { name: 'Apply' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Start enrichment run' })).toBeDisabled();
  });

  it('awaiting_decision shows the appended text and checks with only Apply and Discard', () => {
    seed(run({ review: review() }));
    renderWithProviders(<OpenShellEnrichment />);
    expect(screen.getByText('knowledge/rules/revenue.md')).toBeInTheDocument();
    expect(screen.getByLabelText('Appended text for knowledge/rules/revenue.md')).toHaveTextContent('New rule.');
    expect(screen.queryByLabelText('Before text for knowledge/rules/revenue.md')).not.toBeInTheDocument();
    expect(screen.getByText(/context_validate/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Apply' })).toBeEnabled();
    expect(screen.getByRole('button', { name: 'Discard' })).toBeEnabled();
    for (const name of [/accept/i, /skip/i, /edit/i, /approve/i]) expect(screen.queryByRole('button', { name })).not.toBeInTheDocument();
  });

  it('shows before and after for a non-append change and reports server truncation', () => {
    seed(run({ review: review([{ path: 'relationships.yml', change: 'modified', beforeSha256: 'a', afterSha256: 'b', before: 'rels: []\n', after: 'rels: [x]\n', appended: null, truncated: true }]) }));
    renderWithProviders(<OpenShellEnrichment />);
    expect(screen.getByLabelText('Before text for relationships.yml')).toHaveTextContent('rels: []');
    expect(screen.getByLabelText('After text for relationships.yml')).toHaveTextContent('rels: [x]');
    expect(screen.getByText(/truncated by the server/)).toBeInTheDocument();
  });

  it('validation_failed shows the code and message', () => {
    seed(run({ status: 'validation_failed', validation: { stage: 'validator', code: 'context_validate', message: 'The project did not validate.' } }));
    renderWithProviders(<OpenShellEnrichment />);
    expect(screen.getByText('Validation failed (context_validate)')).toBeInTheDocument();
    expect(screen.getByText('The project did not validate.')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Apply' })).not.toBeInTheDocument();
  });

  it('validation_failed(unsupported_by_runtime) explains the OpenShell scope in plain words', () => {
    seed(run({ status: 'validation_failed', validation: { stage: 'host', code: 'unsupported_by_runtime', message: 'x' } }));
    renderWithProviders(<OpenShellEnrichment />);
    expect(screen.getByText('Validation failed (unsupported_by_runtime)')).toBeInTheDocument();
    expect(screen.getByText(/only change knowledge, descriptions and relationships in files that already exist/)).toBeInTheDocument();
  });

  it('applied shows the receipt, and the fence notice only when revocation is pending', () => {
    seed(run({ status: 'applied', apply: { state: 'applied', receipt } }));
    const { unmount } = renderWithProviders(<OpenShellEnrichment />);
    expect(screen.getByText('Applied')).toBeInTheDocument();
    expect(within(screen.getByTestId('enrichment-receipt')).getByText('knowledge/rules/revenue.md')).toBeInTheDocument();
    expect(screen.queryByText('existing sessions are fenced; runtime cleanup pending')).not.toBeInTheDocument();
    unmount();
    seed(run({ status: 'applied', apply: { state: 'applied', receipt }, events: [{ id: 'e1', kind: 'revocation_pending', createdAt: '' }] }));
    renderWithProviders(<OpenShellEnrichment />);
    expect(screen.getByText('existing sessions are fenced; runtime cleanup pending')).toBeInTheDocument();
  });

  it('apply_refused shows the sanitized code', () => {
    seed(run({ status: 'apply_refused', apply: { code: 'manifest_drift' } }));
    renderWithProviders(<OpenShellEnrichment />);
    expect(screen.getByText('Apply refused; nothing was written')).toBeInTheDocument();
    expect(screen.getByText(/A project file changed since the review/)).toBeInTheDocument();
    expect(screen.getByText('manifest_drift')).toBeInTheDocument();
  });

  it('apply_failed says the project was rolled back', () => {
    seed(run({ status: 'apply_failed', apply: { code: 'apply_failed' } }));
    renderWithProviders(<OpenShellEnrichment />);
    expect(screen.getByText('Apply failed')).toBeInTheDocument();
    expect(screen.getByText(/rolled back/)).toBeInTheDocument();
  });

  it('reconcile_required blocks a new run and says an operator must reconcile', () => {
    seed(run({ status: 'reconcile_required' }));
    renderWithProviders(<OpenShellEnrichment />);
    expect(screen.getByText('Reconciliation required')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Start enrichment run' })).toBeDisabled();
  });

  it('discarded is terminal and allows a new run', () => {
    seed(run({ status: 'discarded' }));
    renderWithProviders(<OpenShellEnrichment />);
    expect(screen.getByText('Discarded')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Start enrichment run' })).toBeEnabled();
  });

  it('starts a run through the start route', async () => {
    seed(undefined);
    client.start.mockResolvedValue(run({ status: 'validation_pending' }));
    renderWithProviders(<OpenShellEnrichment />);
    await userEvent.setup().click(screen.getByRole('button', { name: 'Start enrichment run' }));
    expect(client.start).toHaveBeenCalledWith('grill');
    await waitFor(() => expect(client.status).toHaveBeenCalled());
  });
});

describe('Apply flow', () => {
  it('authorizes only after the confirm step, then applies, and never persists or shows the capability', async () => {
    seed(run({ review: review() }));
    const setItem = vi.spyOn(Storage.prototype, 'setItem');
    const order: string[] = [];
    client.authorize.mockImplementation(async () => { order.push('authorize'); return { code: 'minted', capability: SECRET, reviewSha256: 'sha256:diff', runId: 'run-1' }; });
    client.apply.mockImplementation(async () => {
      order.push('apply'); current = { ...current, run: run({ status: 'applied', apply: { state: 'applied', receipt } }) };
      return { code: 'applied', receipt, revocationPending: true, runId: 'run-1' };
    });
    const user = userEvent.setup();
    renderWithProviders(<OpenShellEnrichment />);
    await user.click(screen.getByRole('button', { name: 'Apply' }));
    expect(client.authorize).not.toHaveBeenCalled();
    expect(screen.getByText(/This writes to the project: knowledge\/rules\/revenue\.md/)).toBeInTheDocument();
    expect(screen.getByText(/Existing sessions will be revoked/)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Confirm apply' }));
    await waitFor(() => expect(screen.getByText('Applied')).toBeInTheDocument());
    expect(order).toEqual(['authorize', 'apply']);
    expect(client.apply).toHaveBeenCalledWith('run-1', SECRET, 'sha256:diff');
    expect(screen.getByText('existing sessions are fenced; runtime cleanup pending')).toBeInTheDocument();
    expect(setItem.mock.calls.flat().join(' ')).not.toContain(SECRET);
    expect(JSON.stringify({ ...window.localStorage })).not.toContain(SECRET);
    expect(JSON.stringify({ ...window.sessionStorage })).not.toContain(SECRET);
    expect(window.location.href).not.toContain(SECRET);
    expect(document.body.textContent).not.toContain(SECRET);
    expect(JSON.stringify(useContextStore.getState().enrichment)).not.toContain(SECRET);
    setItem.mockRestore();
  });

  it('a refused apply discards the capability: a second apply needs a new authorize', async () => {
    seed(run({ review: review() }));
    let minted = 0;
    client.authorize.mockImplementation(async () => ({ code: 'minted', capability: `${SECRET}-${++minted}`, reviewSha256: 'sha256:diff', runId: 'run-1' }));
    const { BffRequestError } = await vi.importActual<typeof import('@/bff/client')>('@/bff/client');
    client.apply.mockRejectedValueOnce(new BffRequestError('the apply capability is missing, wrong, already used or expired', 403, 'capability_invalid'))
      .mockResolvedValueOnce({ code: 'applied', receipt, runId: 'run-1' });
    const user = userEvent.setup();
    renderWithProviders(<OpenShellEnrichment />);
    await user.click(screen.getByRole('button', { name: 'Apply' }));
    await user.click(screen.getByRole('button', { name: 'Confirm apply' }));
    expect(await screen.findByText('the apply capability is missing, wrong, already used or expired')).toBeInTheDocument();
    expect(client.authorize).toHaveBeenCalledTimes(1);
    // Back to the un-confirmed state: nothing re-applies without another explicit click.
    expect(screen.queryByRole('button', { name: 'Confirm apply' })).not.toBeInTheDocument();
    expect(client.apply).toHaveBeenCalledTimes(1);
    await user.click(screen.getByRole('button', { name: 'Apply' }));
    await user.click(screen.getByRole('button', { name: 'Confirm apply' }));
    await waitFor(() => expect(client.apply).toHaveBeenCalledTimes(2));
    expect(client.authorize).toHaveBeenCalledTimes(2);
    expect(client.apply.mock.calls[0]![1]).toBe(`${SECRET}-1`);
    expect(client.apply.mock.calls[1]![1]).toBe(`${SECRET}-2`);
  });

  it('Cancel on the confirm step calls nothing', async () => {
    seed(run({ review: review() }));
    const user = userEvent.setup();
    renderWithProviders(<OpenShellEnrichment />);
    await user.click(screen.getByRole('button', { name: 'Apply' }));
    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(client.authorize).not.toHaveBeenCalled();
    expect(client.apply).not.toHaveBeenCalled();
  });
});

describe('Discard flow', () => {
  it('discards through the route and refreshes to the discarded state', async () => {
    seed(run({ review: review() }));
    client.discard.mockImplementation(async () => { current = { ...current, run: run({ status: 'discarded' }) }; return { code: 'discarded', runId: 'run-1' }; });
    renderWithProviders(<OpenShellEnrichment />);
    await userEvent.setup().click(screen.getByRole('button', { name: 'Discard' }));
    expect(client.discard).toHaveBeenCalledWith('run-1');
    expect(client.authorize).not.toHaveBeenCalled();
    await waitFor(() => expect(screen.getByText('Discarded')).toBeInTheDocument());
  });
});

describe('diff rendering is text only (S4-6)', () => {
  it('renders markup in a diff as inert text', () => {
    const evil = '<script>window.__pwned = 1</script><img src=x onerror="window.__pwned = 2">';
    seed(run({ review: review([
      { path: 'knowledge/rules/a.md', change: 'modified', beforeSha256: 'a', afterSha256: 'b', before: 'x', after: `x${evil}`, appended: evil },
      { path: 'relationships.yml', change: 'modified', beforeSha256: 'a', afterSha256: 'b', before: evil, after: `${evil}!`, appended: null },
    ]) }));
    const { container } = renderWithProviders(<OpenShellEnrichment />);
    expect(screen.getByLabelText('Appended text for knowledge/rules/a.md').textContent).toBe(evil);
    expect(screen.getByLabelText('Before text for relationships.yml').textContent).toBe(evil);
    expect(container.querySelector('script')).toBeNull();
    expect(container.querySelector('img')).toBeNull();
    expect((window as unknown as { __pwned?: number }).__pwned).toBeUndefined();
  });
});

describe('EnrichmentPanel hosting', () => {
  it('does not show the OpenShell review for a local-backend status', () => {
    seed(run({ backend: 'local', status: 'awaiting_decision' }), { backend: 'local' });
    renderWithProviders(<EnrichmentPanel />);
    expect(screen.queryByTestId('openshell-enrichment')).not.toBeInTheDocument();
  });
  it('shows it for an OpenShell status', () => {
    seed(run({ review: review() }));
    renderWithProviders(<EnrichmentPanel />);
    expect(screen.getByTestId('openshell-enrichment')).toBeInTheDocument();
  });
});
