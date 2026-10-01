import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { renderWithProviders } from '@/test/utils';

const navigate = vi.fn();
const client = vi.hoisted(() => ({ list: vi.fn(), create: vi.fn(), readiness: vi.fn(), listStructured: vi.fn() }));
vi.mock('react-router-dom', async (importOriginal) => ({ ...(await importOriginal<typeof import('react-router-dom')>()), useNavigate: () => navigate, useParams: () => ({}) }));
vi.mock('@/bff/env', () => ({ isBffEnabled: () => true }));
vi.mock('@/bff/client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/bff/client')>()),
  listNativeSessions: client.list,
  createNativeSession: client.create,
  getNativeSessionReadiness: client.readiness,
  listSessions: client.listStructured,
  getRuntimeSettingsReadiness: () => Promise.resolve({ valid: true as const }),
}));
import { SessionsSidebar } from '../SessionsSidebar';
import { useNativeSessions } from '../useNativeSessions';

const analysis = { scopeKind: 'bound_project', profile: 'genbi-default', target: 'claude-code:interactive', targetLabel: 'Claude CLI', available: true } as const;
const ready = {
  runtime: { configured: true, generation: 4, provider: 'claude', target: 'claude-code:interactive', targetLabel: 'Claude CLI' },
  mcp: { server: 'GenBI MCP', tool: 'save_dashboard', destination: 'GenBI Artifacts', available: true },
  purposes: {
    analysis,
    setup: { ...analysis, scopeKind: 'bootstrap', profile: 'genbi-setup' },
    context_enrichment: { ...analysis, profile: 'genbi-enrich-context' },
  },
  profiles: {
    'genbi-default': { id: 'genbi-default', scopeKind: 'bound_project', profile: 'genbi-default', target: 'claude-code:interactive', targetLabel: 'Claude CLI', available: true, entryKind: 'scope' },
    'team-kpis': { id: 'team-kpis', scopeKind: 'bound_project', profile: 'team-kpis', target: 'claude-code:interactive', targetLabel: 'Claude CLI', available: true, entryKind: 'scope' },
    'genbi-survey': { id: 'genbi-survey', scopeKind: 'bound_project', profile: 'genbi-survey', target: 'claude-code:interactive', targetLabel: 'Claude CLI', available: true, entryKind: 'agent', entryVerb: 'explore_model' },
    'genbi-monitor': { id: 'genbi-monitor', scopeKind: 'bound_project', profile: 'genbi-monitor', target: 'claude-code:interactive', targetLabel: 'Claude CLI', available: false, reason: 'component "monitor_freshness" is outside the host\'s execution scope' },
  },
} as const;

function session(id: string, dispatchProfile = 'genbi-default') {
  return { id, purpose: 'analysis', vendor: 'claude', agent: 'answer_query', entryVerb: null, scopeKind: 'bound_project', scopeId: 's', projectIdentity: 'p', bindingGeneration: 1, projectRevision: 'r', dispatchProfile, dispatchTarget: 'claude-code:interactive', runtimeGeneration: 4, status: 'running', createdAt: '2026-10-01T00:00:00.000Z', updatedAt: '2026-10-01T00:00:00.000Z', startedAt: null, endedAt: null, exitCode: null, failure: null } as const;
}

describe('New session — conversation profile picker', () => {
  beforeEach(() => {
    navigate.mockReset(); client.create.mockReset(); client.readiness.mockReset().mockResolvedValue(ready);
    client.list.mockReset().mockResolvedValue({ sessions: [] }); client.listStructured.mockReset().mockResolvedValue({ sessions: [] });
    useNativeSessions.setState({ sessions: [], readiness: undefined, readinessError: undefined });
  });

  async function openMenu() {
    const user = userEvent.setup();
    renderWithProviders(<SessionsSidebar />, { route: '/sessions' });
    await waitFor(() => expect(client.readiness).toHaveBeenCalled());
    await user.click(screen.getByRole('button', { name: /new session/i }));
    await screen.findByLabelText('New session options');
    return user;
  }

  it('defaults to genbi-default and sends no profile field for it', async () => {
    client.create.mockResolvedValue({ session: session('new-default'), capability: 'cap' });
    const user = await openMenu();
    expect(screen.getByRole('combobox', { name: 'Conversation profile' })).toBeInTheDocument();
    expect(screen.getByText('genbi-default (default)')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Start separate native terminal' }));
    await waitFor(() => expect(client.create).toHaveBeenCalledTimes(1));
    expect(client.create.mock.calls[0]?.[1]).toEqual({ intent: 'start_separate', idempotencyKey: expect.any(String) });
    expect(client.create.mock.calls[0]?.[1]).not.toHaveProperty('profile');
  });

  it('lists every conversation profile, disables an unavailable one with its reason, and sends the selected id', async () => {
    client.create.mockResolvedValue({ session: session('new-kpis', 'team-kpis'), capability: 'cap' });
    const user = await openMenu();
    await user.click(screen.getByRole('combobox', { name: 'Conversation profile' }));
    const listbox = await screen.findByRole('listbox');
    const monitorOption = within(listbox).getByText('genbi-monitor').closest('[role="option"]') as HTMLElement;
    expect(monitorOption).toHaveAttribute('aria-disabled', 'true');
    expect(within(monitorOption).getByText(/outside the host's execution scope/)).toBeInTheDocument();
    await user.click(within(listbox).getByText('team-kpis'));
    expect(screen.getByText(/Enters at the profile scope/)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Start separate native terminal' }));
    await waitFor(() => expect(client.create).toHaveBeenCalledWith('analysis', expect.objectContaining({ intent: 'start_separate', profile: 'team-kpis' })));
    expect(navigate).toHaveBeenCalledWith('/sessions/new-kpis');
  });

  it('hides the Codex entry choice for a selected profile and names its pinned component', async () => {
    client.readiness.mockResolvedValue({ ...ready, purposes: { ...ready.purposes, analysis: { ...analysis, target: 'codex:interactive', targetLabel: 'Codex CLI' } } });
    const user = await openMenu();
    expect(screen.getByRole('radio', { name: 'Build a dashboard' })).toBeInTheDocument();
    await user.click(screen.getByRole('combobox', { name: 'Conversation profile' }));
    await user.click(within(await screen.findByRole('listbox')).getByText('genbi-survey'));
    expect(screen.queryByRole('radio', { name: 'Build a dashboard' })).not.toBeInTheDocument();
    expect(screen.getByText(/Enters at the explore_model component/)).toBeInTheDocument();
  });

  it('carries a running row\'s profile into a restart and sends none for the default', async () => {
    client.create.mockResolvedValue({ session: session('restarted', 'team-kpis'), capability: 'cap' });
    await useNativeSessions.getState().restartSession({ ...session('old-kpis', 'team-kpis'), status: 'exited' });
    expect(client.create.mock.calls[0]?.[1]).toEqual({ intent: 'start_separate', idempotencyKey: expect.any(String), profile: 'team-kpis' });
    client.create.mockResolvedValue({ session: session('restarted-default'), capability: 'cap' });
    await useNativeSessions.getState().restartSession({ ...session('old-default'), status: 'exited' });
    expect(client.create.mock.calls[1]?.[1]).toEqual({ intent: 'start_separate', idempotencyKey: expect.any(String) });
  });

  it('disables every option and Start when the runtime itself is unavailable, showing that reason for the default', async () => {
    const runtimeReason = 'Native component execution has not been provisioned for this profile.';
    const down = { ...analysis, available: false, reason: runtimeReason } as const;
    client.readiness.mockResolvedValue({
      ...ready,
      purposes: { ...ready.purposes, analysis: down },
      profiles: Object.fromEntries(Object.entries(ready.profiles).map(([id, entry]) => [id, { ...entry, available: false, reason: id === 'genbi-monitor' ? ready.profiles['genbi-monitor'].reason : runtimeReason }])),
    });
    const user = await openMenu();
    expect(screen.getByTestId('native-session-reason')).toHaveTextContent(runtimeReason);
    expect(screen.getByRole('button', { name: 'Start separate native terminal' })).toBeDisabled();
    await user.click(screen.getByRole('combobox', { name: 'Conversation profile' }));
    const listbox = await screen.findByRole('listbox');
    for (const option of within(listbox).getAllByRole('option')) expect(option).toHaveAttribute('aria-disabled', 'true');
    expect(client.create).not.toHaveBeenCalled();
  });

  it('shows the selected profile on running sessions in the list and omits it for the default', async () => {
    client.list.mockResolvedValue({ sessions: [session('run-a'), session('run-b', 'team-kpis')] });
    renderWithProviders(<SessionsSidebar />, { route: '/sessions' });
    const running = await screen.findByRole('region', { name: 'Running' });
    const items = within(running).getAllByRole('button');
    expect(items).toHaveLength(2);
    expect(within(running).getByText('team-kpis')).toBeInTheDocument();
    expect(within(running).queryByText('genbi-default')).not.toBeInTheDocument();
  });
});
