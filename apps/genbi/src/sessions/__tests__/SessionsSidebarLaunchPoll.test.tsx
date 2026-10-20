import { act, fireEvent, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderWithProviders } from '@/test/utils';

const client = vi.hoisted(() => ({ list: vi.fn(), readiness: vi.fn(), structured: vi.fn(), listStructured: vi.fn() }));

vi.mock('@/bff/env', () => ({ isBffEnabled: () => true, bffBaseUrl: () => '' }));
vi.mock('@/bff/client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/bff/client')>()),
  listNativeSessions: client.list,
  getNativeSessionReadiness: client.readiness,
  listSessions: client.listStructured,
  getStructuredAskReadiness: client.structured,
}));

import { SessionsSidebar } from '../SessionsSidebar';
import { LAUNCH_IN_PROGRESS_POLL_CAP, LAUNCH_IN_PROGRESS_POLL_MS } from '../launchPolling';
import { useNativeSessions } from '../useNativeSessions';
import { useSessionStore } from '@/session/useSessionStore';

const analysis = { scopeKind: 'bound_project' as const, profile: 'genbi-default', target: 'claude-code:interactive' as const, targetLabel: 'Claude CLI' as const, available: true };
function nativeReadiness(code?: string) {
  const selectedReadiness = code
    ? { state: 'unavailable' as const, code, message: 'Another OpenShell session is starting; you can start a new one when it is ready.' }
    : { state: 'ready' as const, version: '0.0.1', capabilities: [] };
  return {
    runtime: { configured: true, generation: 1, provider: 'claude' as const, target: 'claude-code:interactive' as const, targetLabel: 'Claude CLI' as const },
    runtimeHost: { selected: 'openshell' as const, selectedReadiness, backends: { local: selectedReadiness, 'codex-app-server': selectedReadiness, 'claude-sandbox-runtime': selectedReadiness, openshell: selectedReadiness } },
    purposes: { analysis, setup: analysis, context_enrichment: analysis },
  };
}
const structuredBusy = { active: { backend: 'openshell', state: 'unavailable', ask: false, reason: 'Selected vendor backend is not ready.', code: 'openshell_launch_in_progress' } };
const structuredReady = { active: { backend: 'openshell', state: 'ready', ask: true, reason: 'Only explicitly supported operations are available.' } };

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] });
  client.list.mockReset().mockResolvedValue({ sessions: [] });
  client.listStructured.mockReset().mockResolvedValue([]);
  client.readiness.mockReset();
  client.structured.mockReset();
  useNativeSessions.setState({ sessions: [], loading: false, error: undefined, readiness: undefined, readinessLoading: false, readinessError: undefined }, false);
  useSessionStore.setState({ sessionsById: {}, sessionList: [], structuredReadiness: undefined, structuredReadinessError: undefined }, false);
});
afterEach(() => vi.useRealTimers());

const settle = () => act(async () => { await vi.advanceTimersByTimeAsync(0); });
const tick = (times = 1) => act(async () => { await vi.advanceTimersByTimeAsync(LAUNCH_IN_PROGRESS_POLL_MS * times); });
const openMenu = () => act(async () => { fireEvent.click(screen.getByRole('button', { name: /new session/i })); await vi.advanceTimersByTimeAsync(0); });

describe('Sessions sidebar launch-in-progress polling', () => {
  it('re-polls readiness while another launch is in progress and re-enables Start without a reload', async () => {
    client.readiness.mockResolvedValueOnce(nativeReadiness('openshell_launch_in_progress')).mockResolvedValue(nativeReadiness());
    client.structured.mockResolvedValueOnce(structuredBusy).mockResolvedValue(structuredReady);
    renderWithProviders(<SessionsSidebar />, { route: '/sessions' });
    await settle(); await openMenu(); await settle();
    expect(screen.getByRole('button', { name: 'Start Structured Ask' })).toBeDisabled();
    await tick();
    expect(screen.getByRole('button', { name: 'Start Structured Ask' })).toBeEnabled();
    expect(client.readiness.mock.calls.length).toBeGreaterThanOrEqual(2);
  });

  it('stops polling once the reason changes', async () => {
    client.readiness.mockResolvedValueOnce(nativeReadiness('openshell_launch_in_progress')).mockResolvedValue(nativeReadiness());
    client.structured.mockResolvedValueOnce(structuredBusy).mockResolvedValue(structuredReady);
    renderWithProviders(<SessionsSidebar />, { route: '/sessions' });
    await settle(); await tick(); const settled = client.readiness.mock.calls.length;
    await tick(5);
    expect(client.readiness.mock.calls.length).toBe(settled);
  });

  it('is bounded: stops after the cap when the reason never clears', async () => {
    client.readiness.mockResolvedValue(nativeReadiness('openshell_launch_in_progress'));
    client.structured.mockResolvedValue(structuredBusy);
    renderWithProviders(<SessionsSidebar />, { route: '/sessions' });
    await settle(); await tick(LAUNCH_IN_PROGRESS_POLL_CAP + 5);
    const capped = client.readiness.mock.calls.length;
    expect(capped).toBeLessThanOrEqual(LAUNCH_IN_PROGRESS_POLL_CAP + 1);
    await tick(5);
    expect(client.readiness.mock.calls.length).toBe(capped);
  });

  it('does not poll for other refusals', async () => {
    client.readiness.mockResolvedValue(nativeReadiness('openshell_cleanup_pending'));
    client.structured.mockResolvedValue({ active: { ...structuredBusy.active, code: 'openshell_cleanup_pending' } });
    renderWithProviders(<SessionsSidebar />, { route: '/sessions' });
    await settle(); await tick(3);
    expect(client.readiness).toHaveBeenCalledTimes(1);
  });

  it('stops polling on unmount', async () => {
    client.readiness.mockResolvedValue(nativeReadiness('openshell_launch_in_progress'));
    client.structured.mockResolvedValue(structuredBusy);
    const view = renderWithProviders(<SessionsSidebar />, { route: '/sessions' });
    await settle(); await tick(2);
    expect(client.readiness.mock.calls.length).toBeGreaterThan(1);
    view.unmount();
    const unmounted = client.readiness.mock.calls.length;
    await tick(3);
    expect(client.readiness.mock.calls.length).toBe(unmounted);
  });
});
