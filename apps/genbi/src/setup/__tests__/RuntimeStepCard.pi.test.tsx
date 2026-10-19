import { describe, it, expect, beforeEach, vi } from 'vitest';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { renderWithProviders } from '@/test/utils';
import { RuntimeStepCard } from '../RuntimeStepCard';
import { useSetupStore } from '../useSetupStore';
import { fixtureInitialMessage, fixtureRuntimeSettings, fixtureSetupSteps } from '../fixtures';

vi.mock('@/bff/env', () => ({ isBffEnabled: () => true }));

const readiness = vi.fn();
const putRuntimeSettings = vi.fn();
const getGatewayModelCatalog = vi.fn();
vi.mock('@/bff/client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/bff/client')>();
  return {
    ...actual,
    getStructuredAskReadiness: () => readiness(),
    getGatewayModelCatalog: (...args: unknown[]) => getGatewayModelCatalog(...args),
    putRuntimeSettings: (patch: unknown) => putRuntimeSettings(patch),
    getSubscriptionModelCatalog: () => Promise.reject(new Error('no catalog')),
    getNativeSessionsReadiness: () => Promise.reject(new Error('unused')),
  };
});

const off = { offered: false, state: 'not_offered', ask: false, setup: false, reason: 'Not enabled for this boot.' };
const pi = (over: Record<string, unknown> = {}) => ({
  offered: true, backend: 'openshell', state: 'ready', ask: true, setup: false, reason: 'Only explicitly supported operations are available.',
  pinned: { provider: 'Synthetic Vendor', auth: 'byo', models: { cheap: 'model-cheap', strong: 'model-strong' } }, ...over,
});
const boot = (backend: unknown) => ({ runtime: 'openshell', backends: { claude: off, codex: off, pi: backend }, active: { backend: 'openshell', state: 'ready', ask: true, reason: '' } });

beforeEach(() => {
  readiness.mockReset(); putRuntimeSettings.mockReset(); getGatewayModelCatalog.mockReset();
  getGatewayModelCatalog.mockResolvedValue({ status: 'unavailable', reason: 'test' });
  useSetupStore.setState({
    steps: fixtureSetupSteps, selectedStepKey: 'runtime',
    runtimeSettings: { ...fixtureRuntimeSettings, authMode: 'subscription', tierModels: [], apiKeyBaseURL: 'https://forged.example.test/v1' },
    runtimeTierNames: ['cheap', 'strong'], runtimeTierNamesError: undefined,
    adapterEnvStatus: { anthropic: false, openaiCompatible: false }, subscriptionLoginStatus: { claude: false, codex: false },
    subscriptionModelCatalogs: {}, subscriptionModelCatalogLoading: {}, subscriptionModelCatalogErrors: {},
    runtimeSettingsSaving: false, runtimeSettingsError: undefined,
    verifyGate: false, connectedSourceKey: undefined, messages: [fixtureInitialMessage],
  }, false);
});

describe('RuntimeStepCard under a pi boot', () => {
  it('shows pi, its readiness, the provider label and the pinned models read-only, with no model catalog and no editable field', async () => {
    readiness.mockResolvedValue(boot(pi()));
    renderWithProviders(<RuntimeStepCard />);
    expect(await screen.findByText('pi on OpenShell')).toBeInTheDocument();
    expect(screen.getByText('Ready')).toBeInTheDocument();
    expect(screen.getByText('Synthetic Vendor')).toBeInTheDocument();
    const table = screen.getByRole('table');
    expect(within(table).getByText('cheap')).toBeInTheDocument(); expect(within(table).getByText('model-cheap')).toBeInTheDocument();
    expect(within(table).getByText('strong')).toBeInTheDocument(); expect(within(table).getByText('model-strong')).toBeInTheDocument();
    expect(screen.queryAllByRole('textbox')).toHaveLength(0); expect(screen.queryAllByRole('combobox')).toHaveLength(0);
    expect(screen.queryByRole('radio', { name: 'Claude CLI' })).toBeNull(); expect(screen.queryByRole('radio', { name: 'Codex CLI' })).toBeNull();
    expect(getGatewayModelCatalog).not.toHaveBeenCalled();
  });
  it('shows the reason and the fixed code when pi is not ready, and still shows the pins', async () => {
    readiness.mockResolvedValue(boot(pi({ state: 'unavailable', ask: false, reason: 'Selected vendor backend is not ready.', code: 'pi_uncertified' })));
    renderWithProviders(<RuntimeStepCard />);
    expect(await screen.findByText('Not ready')).toBeInTheDocument();
    expect(screen.getByText('Selected vendor backend is not ready.')).toBeInTheDocument();
    expect(screen.getByText('Reason code: pi_uncertified')).toBeInTheDocument();
    expect(screen.getByText('model-strong')).toBeInTheDocument();
  });
  it('saves the pins, not anything typed: the boot auth mode, exactly the pinned model per compiled tier, no base URL and no hybrid', async () => {
    readiness.mockResolvedValue(boot(pi()));
    putRuntimeSettings.mockImplementation(async (patch) => ({ ...patch, warnings: [], nativeSessionBinding: undefined }));
    renderWithProviders(<RuntimeStepCard />);
    fireEvent.click(await screen.findByRole('button', { name: 'Save pinned runtime' }));
    await waitFor(() => expect(putRuntimeSettings).toHaveBeenCalledOnce());
    expect(putRuntimeSettings.mock.calls[0]![0]).toMatchObject({
      authMode: 'byo', hybrid: false, apiKeyBaseURL: '', gatewayBaseURL: '', apiKeyModel: '',
      tierModels: [{ tier: 'cheap', model: 'model-cheap' }, { tier: 'strong', model: 'model-strong' }],
    });
    await waitFor(() => expect(useSetupStore.getState().runtimeSettingsSaving).toBe(false));
    expect(useSetupStore.getState().runtimeSettingsError).toBeUndefined();
  });
  it('saves the gateway mode when the boot serves the gateway', async () => {
    readiness.mockResolvedValue(boot(pi({ pinned: { provider: 'Synthetic Vendor', auth: 'gateway', models: { cheap: 'a', strong: 'b' } } })));
    putRuntimeSettings.mockImplementation(async (patch) => ({ ...patch, warnings: [], nativeSessionBinding: undefined }));
    renderWithProviders(<RuntimeStepCard />);
    fireEvent.click(await screen.findByRole('button', { name: 'Save pinned runtime' }));
    await waitFor(() => expect(putRuntimeSettings).toHaveBeenCalledOnce());
    expect(putRuntimeSettings.mock.calls[0]![0]).toMatchObject({ authMode: 'gateway', tierModels: [{ tier: 'cheap', model: 'a' }, { tier: 'strong', model: 'b' }] });
  });
  it('refuses to save, and says which tiers have no pin, when a compiled tier is not pinned', async () => {
    readiness.mockResolvedValue(boot(pi({ pinned: { provider: 'Synthetic Vendor', auth: 'byo', models: { cheap: 'model-cheap' } } })));
    renderWithProviders(<RuntimeStepCard />);
    expect(await screen.findByText('The server pins no model for these compiled tiers, so the runtime cannot be saved: strong')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Save pinned runtime' })).toBeDisabled();
  });
  it('surfaces a rejected save without advancing', async () => {
    readiness.mockResolvedValue(boot(pi())); putRuntimeSettings.mockRejectedValue(new Error('rejected by the server'));
    renderWithProviders(<RuntimeStepCard />);
    fireEvent.click(await screen.findByRole('button', { name: 'Save pinned runtime' }));
    expect(await screen.findByText('rejected by the server')).toBeInTheDocument();
    expect(useSetupStore.getState().selectedStepKey).toBe('runtime');
  });
  it('keeps the ordinary form for a boot that offers pi without a descriptor to show, and for a boot that does not offer it', async () => {
    readiness.mockResolvedValue(boot(pi({ pinned: undefined })));
    const { unmount } = renderWithProviders(<RuntimeStepCard />);
    expect(await screen.findByRole('radio', { name: 'Claude CLI' })).toBeInTheDocument(); expect(screen.queryByText('pi on OpenShell')).toBeNull();
    unmount();
    readiness.mockResolvedValue(boot(off));
    renderWithProviders(<RuntimeStepCard />);
    expect(await screen.findByRole('radio', { name: 'Claude CLI' })).toBeInTheDocument(); expect(screen.queryByText('pi on OpenShell')).toBeNull();
  });
  it('shows nothing from a response that carries an endpoint, key name or path in a field the contract does not define', async () => {
    readiness.mockResolvedValue(boot(pi({ endpoint: 'https://api.vendor.example.test/v1', credentialEnv: 'VENDOR_KEY', profile: '/etc/profile.yaml' })));
    renderWithProviders(<RuntimeStepCard />);
    await screen.findByText('pi on OpenShell');
    const text = document.body.textContent ?? '';
    for (const leaked of ['api.vendor.example.test', 'VENDOR_KEY', '/etc/profile.yaml']) expect(text).not.toContain(leaked);
  });
});
