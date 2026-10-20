import { describe, it, expect, beforeEach, vi } from 'vitest';
import { screen } from '@testing-library/react';
import { renderWithProviders } from '@/test/utils';
import { RuntimeStepCard } from '../RuntimeStepCard';
import { useSetupStore } from '../useSetupStore';
import { fixtureInitialMessage, fixtureRuntimeSettings, fixtureSetupSteps } from '../fixtures';

vi.mock('@/bff/env', () => ({ isBffEnabled: () => true }));

const readiness = vi.fn();
vi.mock('@/bff/client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/bff/client')>();
  return {
    ...actual,
    getStructuredAskReadiness: () => readiness(),
    getGatewayModelCatalog: () => Promise.resolve({ status: 'unavailable', reason: 'test' }),
    getSubscriptionModelCatalog: () => Promise.reject(new Error('no catalog')),
    getNativeSessionsReadiness: () => Promise.reject(new Error('unused')),
  };
});

const off = { offered: false, state: 'not_offered', ask: false, setup: false, reason: 'Not enabled for this boot.' };
const localPi = (over: Record<string, unknown> = {}) => ({
  offered: true, backend: 'pi-local', state: 'ready', ask: true, setup: false, reason: 'Structured Ask runs through pi for API key and gateway; every other purpose runs in-process.', ...over,
});
const boot = (pi: unknown) => ({ runtime: 'local', backends: { claude: { ...off, offered: true, state: 'ready' }, codex: { ...off, offered: true, state: 'ready' }, pi }, active: { backend: 'pi-local', state: 'ready', ask: true, reason: '' } });

beforeEach(() => {
  readiness.mockReset();
  useSetupStore.setState({
    steps: fixtureSetupSteps, selectedStepKey: 'runtime',
    runtimeSettings: { ...fixtureRuntimeSettings, authMode: 'gateway', tierModels: [] },
    runtimeTierNames: ['cheap', 'strong'], runtimeTierNamesError: undefined,
    adapterEnvStatus: { anthropic: false, openaiCompatible: false }, subscriptionLoginStatus: { claude: false, codex: false },
    subscriptionModelCatalogs: {}, subscriptionModelCatalogLoading: {}, subscriptionModelCatalogErrors: {},
    runtimeSettingsSaving: false, runtimeSettingsError: undefined,
    verifyGate: false, connectedSourceKey: undefined, messages: [fixtureInitialMessage],
  }, false);
});

describe('RuntimeStepCard under a local pi boot', () => {
  it('shows pi on this machine as ready and keeps the existing pickers', async () => {
    readiness.mockResolvedValue(boot(localPi()));
    renderWithProviders(<RuntimeStepCard />);
    expect(await screen.findByText('pi on this machine')).toBeInTheDocument();
    expect(screen.getByText('Ready')).toBeInTheDocument();
    expect(screen.getAllByRole('combobox').length).toBeGreaterThan(0);
    expect(screen.queryByRole('table')).toBeNull();
    expect(screen.queryByText('pi on OpenShell')).toBeNull();
  });
  it('shows the reason and the fixed code when pi is not ready, and still shows the pickers', async () => {
    readiness.mockResolvedValue(boot(localPi({ state: 'unavailable', ask: false, reason: 'Selected vendor backend is not ready.', code: 'pi_not_installed' })));
    renderWithProviders(<RuntimeStepCard />);
    expect(await screen.findByText('Not ready')).toBeInTheDocument();
    expect(screen.getByText('Selected vendor backend is not ready.')).toBeInTheDocument();
    expect(screen.getByText('Reason code: pi_not_installed')).toBeInTheDocument();
    expect(screen.getAllByRole('combobox').length).toBeGreaterThan(0);
  });
  it('shows nothing about pi when the boot does not offer it', async () => {
    readiness.mockResolvedValue(boot(off));
    renderWithProviders(<RuntimeStepCard />);
    expect(await screen.findAllByRole('combobox')).not.toHaveLength(0);
    expect(screen.queryByText('pi on this machine')).toBeNull();
  });
});
