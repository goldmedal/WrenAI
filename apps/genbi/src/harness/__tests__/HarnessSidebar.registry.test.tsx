import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { renderWithProviders } from '@/test/utils';

const client = vi.hoisted(() => ({ getHarness: vi.fn(), listProfiles: vi.fn(), addProfile: vi.fn(), deleteProfile: vi.fn() }));
vi.mock('@/bff/env', () => ({ isBffEnabled: () => true }));
vi.mock('@/bff/client', () => ({
  getHarness: client.getHarness,
  listProfiles: client.listProfiles,
  addProfile: client.addProfile,
  deleteProfile: client.deleteProfile,
}));
import { HarnessSidebar } from '../HarnessSidebar';
import { useHarnessStore } from '../useHarnessStore';
import { fixtureHarnessViews } from '../fixtures';

const stamp = '2026-10-01T00:00:00.000Z';
const base = { createdAt: stamp, updatedAt: stamp, components: [] };
const registry = [
  { id: 'genbi-setup', kind: 'builtin', role: 'system', selectable: false, admission: { status: 'admitted', reason: 'system purpose profile', checkedAt: stamp }, ...base },
  { id: 'genbi-enrich-context', kind: 'builtin', role: 'system', selectable: false, admission: { status: 'admitted', reason: 'system purpose profile', checkedAt: stamp }, ...base },
  { id: 'genbi-default', kind: 'builtin', role: 'conversation', selectable: true, admission: { status: 'admitted', checkedAt: stamp }, entry: { kind: 'scope' }, ...base },
  { id: 'genbi-report', kind: 'builtin', role: 'conversation', selectable: false, admission: { status: 'unavailable', reason: 'composition is not dispatchable to the native CLI targets in this version', checkedAt: stamp }, ...base },
  { id: 'team-kpis', kind: 'user', role: 'conversation', selectable: true, admission: { status: 'admitted', checkedAt: stamp }, entry: { kind: 'agent', verb: 'explore_model' }, sourceDir: '/workspace/profiles/team-kpis', ...base },
] as const;

describe('Harness sidebar — registry-driven profiles (live mode)', () => {
  beforeEach(() => {
    client.getHarness.mockReset().mockResolvedValue(fixtureHarnessViews.analysis);
    client.listProfiles.mockReset().mockResolvedValue({ profiles: registry });
    client.addProfile.mockReset(); client.deleteProfile.mockReset().mockResolvedValue(undefined);
    useHarnessStore.setState({ selectedPurpose: 'analysis', selectedProfile: 'genbi-default', harness: undefined, loading: false, error: undefined, profiles: [], profilesError: undefined, addProfileResult: undefined }, false);
  });

  it('lists system purposes and conversation profiles from the registry, refused ones disabled with the reason', async () => {
    renderWithProviders(<HarnessSidebar />, { route: '/harness' });
    const sidebar = await screen.findByRole('navigation', { name: 'Profiles' });
    await waitFor(() => expect(within(sidebar).getByRole('button', { name: /team-kpis/ })).toBeInTheDocument());
    expect(within(sidebar).getAllByRole('button').map((button) => button.textContent)).toEqual([
      expect.stringMatching(/^Setup/), expect.stringMatching(/^Context enrichment/), expect.stringMatching(/^Analyze data/), expect.stringMatching(/^genbi-report/), expect.stringMatching(/^team-kpis/),
    ]);
    expect(within(sidebar).getByRole('button', { name: /genbi-report/ })).toBeDisabled();
    expect(within(sidebar).getByText(/composition is not dispatchable/)).toBeInTheDocument();
    expect(within(sidebar).getByText(/user · enters at explore_model/)).toBeInTheDocument();
  });

  it('selecting a user profile fetches its harness by id and marks it selected', async () => {
    const user = userEvent.setup();
    renderWithProviders(<HarnessSidebar />, { route: '/harness' });
    const sidebar = await screen.findByRole('navigation', { name: 'Profiles' });
    await user.click(await within(sidebar).findByRole('button', { name: /team-kpis/ }));
    await waitFor(() => expect(client.getHarness).toHaveBeenCalledWith('analysis', 'team-kpis'));
    expect(useHarnessStore.getState()).toMatchObject({ selectedPurpose: 'analysis', selectedProfile: 'team-kpis' });
    await user.click(within(sidebar).getByRole('button', { name: /Analyze data/ }));
    await waitFor(() => expect(client.getHarness).toHaveBeenLastCalledWith('analysis', undefined));
  });

  it('registers a profile directory, shows the verdict, reloads the registry and selects an admitted profile', async () => {
    const added = { ...registry[4], id: 'sales-review', sourceDir: '/workspace/profiles/sales-review' };
    client.addProfile.mockResolvedValue({ profile: added });
    client.listProfiles.mockResolvedValueOnce({ profiles: registry }).mockResolvedValue({ profiles: [...registry, added] });
    const user = userEvent.setup();
    renderWithProviders(<HarnessSidebar />, { route: '/harness' });
    const form = await screen.findByRole('region', { name: 'Add profile' });
    expect(within(form).getByRole('button', { name: /Register/ })).toBeDisabled();
    await user.type(within(form).getByRole('textbox', { name: /Profile directory/ }), '/Users/me/profiles/sales-review');
    await user.click(within(form).getByRole('button', { name: /Register/ }));
    await waitFor(() => expect(client.addProfile).toHaveBeenCalledWith('/Users/me/profiles/sales-review'));
    expect(await within(form).findByRole('status')).toHaveTextContent('sales-review: Profile registered.');
    await waitFor(() => expect(within(screen.getByRole('navigation', { name: 'Profiles' })).getByRole('button', { name: /sales-review/ })).toBeInTheDocument());
    expect(useHarnessStore.getState().selectedProfile).toBe('sales-review');
  });

  it('shows a refused registration with every reason, and a rejected request with its message', async () => {
    const refused = { ...registry[4], id: 'wide', selectable: false, admission: { status: 'unavailable', reason: 'component "x" requires capabilities outside the host ceiling: filesystem_write; component "y" uses step tiers the runtime configuration cannot bind: orchestrator', checkedAt: stamp } };
    client.addProfile.mockResolvedValueOnce({ profile: refused }).mockRejectedValueOnce(new Error('sourcePath must be an absolute path: "relative/dir"'));
    const user = userEvent.setup();
    renderWithProviders(<HarnessSidebar />, { route: '/harness' });
    const form = await screen.findByRole('region', { name: 'Add profile' });
    const input = within(form).getByRole('textbox', { name: /Profile directory/ });
    await user.type(input, '/tmp/wide');
    await user.click(within(form).getByRole('button', { name: /Register/ }));
    const status = await within(form).findByRole('status');
    expect(status).toHaveTextContent(/wide: Profile registered but not selectable: component "x" requires capabilities outside the host ceiling: filesystem_write; component "y" uses step tiers/);
    expect(useHarnessStore.getState().selectedProfile).toBe('genbi-default');
    await user.clear(input); await user.type(input, 'relative/dir');
    await user.click(within(form).getByRole('button', { name: /Register/ }));
    await waitFor(() => expect(within(form).getByRole('status')).toHaveTextContent('sourcePath must be an absolute path'));
  });

  it('removes a user profile after confirmation and never offers removal for built-ins', async () => {
    client.listProfiles.mockResolvedValueOnce({ profiles: registry }).mockResolvedValue({ profiles: registry.slice(0, 4) });
    const user = userEvent.setup();
    renderWithProviders(<HarnessSidebar />, { route: '/harness' });
    const form = await screen.findByRole('region', { name: 'Add profile' });
    expect(within(form).queryByRole('button', { name: /Remove genbi-default/ })).not.toBeInTheDocument();
    await user.click(await within(form).findByRole('button', { name: 'Remove team-kpis' }));
    await user.click(await screen.findByRole('button', { name: 'Remove' }));
    await waitFor(() => expect(client.deleteProfile).toHaveBeenCalledWith('team-kpis'));
    await waitFor(() => expect(within(screen.getByRole('navigation', { name: 'Profiles' })).queryByRole('button', { name: /team-kpis/ })).not.toBeInTheDocument());
  });
});
