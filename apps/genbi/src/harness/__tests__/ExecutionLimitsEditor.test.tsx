import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, screen, waitFor } from '@testing-library/react';
import { renderWithProviders } from '@/test/utils';
import { ExecutionLimitsEditor } from '../ExecutionLimitsEditor';
import type { ExecutionLimitsInfo } from '../types';

const mocks = vi.hoisted(() => ({ get: vi.fn(), put: vi.fn() }));
vi.mock('@/bff/env', () => ({ isBffEnabled: () => true }));
vi.mock('@/bff/client', () => ({ getExecutionLimits: mocks.get, putExecutionLimits: mocks.put }));

const deployer: ExecutionLimitsInfo = { componentTimeoutMs: 120000, componentTimeoutSource: 'env', deployerTimeoutMs: 120000, ceilingMs: 1800000, minMs: 30000, editable: true };

describe('ExecutionLimitsEditor', () => {
  beforeEach(() => {
    mocks.get.mockReset();
    mocks.put.mockReset();
  });

  it('shows the value in force, saves an operator override, and reports the result', async () => {
    mocks.get.mockResolvedValue(deployer);
    mocks.put.mockResolvedValue({ ...deployer, componentTimeoutMs: 300000, componentTimeoutSource: 'operator', operatorTimeoutMs: 300000 });
    const onSaved = vi.fn();
    renderWithProviders(<ExecutionLimitsEditor onSaved={onSaved} />);
    expect(await screen.findByText(/120 s · set by WREN_HARNESS_COMPONENT_TIMEOUT_MS/)).toBeInTheDocument();
    expect(screen.getByText(/Allowed 30–1800 s · deployer value 120 s/)).toBeInTheDocument();

    const input = screen.getByRole('spinbutton', { name: 'Component run timeout in seconds' });
    fireEvent.change(input, { target: { value: '300' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save timeout' }));
    await waitFor(() => expect(mocks.put).toHaveBeenCalledWith(300000));
    expect(await screen.findByText(/300 s · set on this page/)).toBeInTheDocument();
    expect(onSaved).toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'Use deployer value' })).toBeEnabled();
  });

  it('locks the controls and explains why when the deployment forbids overrides', async () => {
    mocks.get.mockResolvedValue({ ...deployer, editable: false, editableReason: 'Operator overrides are disabled on a hosted deployment until the deployer sets WREN_HARNESS_MAX_COMPONENT_TIMEOUT_MS as the ceiling.' });
    renderWithProviders(<ExecutionLimitsEditor />);
    expect(await screen.findByText(/hosted deployment/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Save timeout' })).toBeDisabled();
    expect(screen.getByRole('spinbutton', { name: 'Component run timeout in seconds' })).toBeDisabled();
  });

  it('surfaces a rejected save without losing the current value', async () => {
    mocks.get.mockResolvedValue(deployer);
    mocks.put.mockRejectedValue(new Error('componentTimeoutMs must be an integer number of milliseconds between 30000 and 600000, got 900000'));
    renderWithProviders(<ExecutionLimitsEditor />);
    await screen.findByText(/120 s · set by/);
    fireEvent.change(screen.getByRole('spinbutton', { name: 'Component run timeout in seconds' }), { target: { value: '900' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save timeout' }));
    expect(await screen.findByText(/between 30000 and 600000/)).toBeInTheDocument();
    expect(screen.getByText(/120 s · set by WREN_HARNESS_COMPONENT_TIMEOUT_MS/)).toBeInTheDocument();
  });
});
