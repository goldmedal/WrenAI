import { describe, it, expect, beforeEach, vi } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import { renderWithProviders } from '@/test/utils';
import { RuntimeStepCard } from '../RuntimeStepCard';
import { useSetupStore } from '../useSetupStore';
import { fixtureInitialMessage, fixtureRuntimeSettings, fixtureSetupSteps } from '../fixtures';

vi.mock('@/bff/env', () => ({ isBffEnabled: () => true }));

const readiness = vi.fn();
vi.mock('@/bff/client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/bff/client')>();
  return { ...actual, getStructuredAskReadiness: () => readiness(), getGatewayModelCatalog: () => Promise.resolve({ status: 'unavailable', reason: 'test' }) };
});

const backend = (offered: boolean) => ({ offered, state: offered ? 'ready' : 'not_offered', ask: offered, setup: offered, reason: offered ? '' : 'Not supported on this runtime.' });

beforeEach(() => {
  readiness.mockReset();
  useSetupStore.setState({
    steps: fixtureSetupSteps, selectedStepKey: 'runtime',
    runtimeSettings: { ...fixtureRuntimeSettings, subscriptionDriverModel: 'claude-opus', tierModels: [{ tier: 'cheap', model: 'claude-haiku' }, { tier: 'strong', model: 'claude-sonnet' }] },
    runtimeTierNames: ['cheap', 'strong'], runtimeTierNamesError: undefined,
    adapterEnvStatus: { anthropic: true, openaiCompatible: true }, subscriptionLoginStatus: { claude: true, codex: true },
    subscriptionModelCatalogs: {}, subscriptionModelCatalogLoading: {}, subscriptionModelCatalogErrors: {},
    verifyGate: false, connectedSourceKey: undefined, messages: [fixtureInitialMessage],
  }, false);
});

describe('RuntimeStepCard — backends the boot does not offer', () => {
  it('disables a provider the server reports as not offered and leaves the offered one selectable', async () => {
    readiness.mockResolvedValue({ runtime: 'openshell', backends: { claude: backend(true), codex: backend(false), pi: backend(false) }, active: { backend: 'openshell', state: 'ready', ask: true, reason: '' } });
    renderWithProviders(<RuntimeStepCard />);
    const codex = await screen.findByRole('radio', { name: 'Codex CLI' });
    await waitFor(() => expect(codex).toBeDisabled());
    expect(screen.getByRole('radio', { name: 'Claude CLI' })).not.toBeDisabled();
  });
  it('disables nothing when readiness is unavailable', async () => {
    readiness.mockRejectedValue(new Error('down'));
    renderWithProviders(<RuntimeStepCard />);
    const codex = await screen.findByRole('radio', { name: 'Codex CLI' });
    expect(codex).not.toBeDisabled();
  });
});
