import { beforeEach, describe, expect, it } from 'vitest';
import { fireEvent, screen, within } from '@testing-library/react';
import { renderWithProviders } from '@/test/utils';
import { AppRoutes } from '@/app/App';
import { useHarnessStore } from '../useHarnessStore';

beforeEach(() => {
  useHarnessStore.setState(
    { selectedPurpose: 'analysis', harness: undefined, loading: false, error: undefined },
    false,
  );
});

describe('Harness page (fixture mode)', () => {
  it('lists the two system purposes and every fixture conversation profile, refused ones disabled with their reason', () => {
    renderWithProviders(<AppRoutes />, { route: '/harness' });

    const sidebar = screen.getByRole('navigation', { name: 'Profiles' });
    expect(within(sidebar).getByRole('button', { name: /Setup/ })).toBeEnabled();
    expect(within(sidebar).getByRole('button', { name: /Analyze data/ })).toBeEnabled();
    expect(within(sidebar).getByRole('button', { name: /Context enrichment/ })).toBeEnabled();
    expect(within(sidebar).getByRole('button', { name: /team-kpis/ })).toBeEnabled();
    expect(within(sidebar).getByRole('button', { name: /genbi-report/ })).toBeEnabled();
    expect(within(sidebar).getByText(/enters at plan_report/)).toBeInTheDocument();
    expect(within(sidebar).getByRole('button', { name: /genbi-monitor/ })).toBeDisabled();
    expect(within(sidebar).getByText(/outside the host's execution scope/)).toBeInTheDocument();
    expect(within(sidebar).getAllByRole('button')).toHaveLength(6);
    // Fixture mode says so, and the registration form is inert.
    const addProfile = screen.getByRole('region', { name: 'Add profile' });
    expect(within(addProfile).getByText('Fixture')).toBeInTheDocument();
    expect(within(addProfile).getByRole('textbox', { name: /Profile directory/ })).toBeDisabled();
    expect(within(addProfile).getByRole('button', { name: 'Register' })).toBeDisabled();
  });

  it('shows a fixture conversation profile under its own id when selected', () => {
    renderWithProviders(<AppRoutes />, { route: '/harness' });
    fireEvent.click(screen.getByRole('button', { name: /team-kpis/ }));
    const panel = screen.getByText('Execution path').closest('.ant-card') as HTMLElement;
    expect(panel).toHaveTextContent('team-kpis');
    expect(screen.getByText('Answer Query')).toBeInTheDocument();
  });

  it('keeps the selected purpose execution path and components in sync', () => {
    renderWithProviders(<AppRoutes />, { route: '/harness' });
    expect(screen.getByText('Answer Query')).toBeInTheDocument();
    expect(screen.getByText('analysis')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /Setup/ }));
    expect(screen.getByText('Connect Source')).toBeInTheDocument();
    expect(screen.getByText('setup')).toBeInTheDocument();
    expect(screen.getAllByText('genbi-setup')).not.toHaveLength(0);
    expect(screen.queryByText('Answer Query')).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /Context enrichment/ }));
    expect(screen.getByText('Draft Enrichment')).toBeInTheDocument();
    expect(screen.getByText('context_enrichment')).toBeInTheDocument();
    expect(screen.queryByText('Connect Source')).not.toBeInTheDocument();
  });

  it('shows a component unavailable on the compiled target as Available via its native session, with the programmatic limitation still discoverable on expand', () => {
    renderWithProviders(<AppRoutes />, { route: '/harness' });
    fireEvent.click(screen.getByRole('button', { name: /Context enrichment/ }));

    const row = screen.getAllByRole('row').find((candidate) => within(candidate).queryByText('Apply Enrichment'));
    expect(row).toBeDefined();
    // Purpose-level readiness IS available for this fixture, so the compiled-target
    // limitation must not be promoted into a warning-colored Unavailable tag.
    expect(within(row!).queryByText(/^Unavailable/)).not.toBeInTheDocument();
    expect(within(row!).getByText('Available via Claude CLI')).toBeInTheDocument();

    // The programmatic limitation is still discoverable — the row stays expandable.
    const expandButton = within(row!).getByRole('button');
    fireEvent.click(expandButton);
    const expandedRow = row!.nextElementSibling;
    expect(expandedRow).not.toBeNull();
    expect(within(expandedRow as HTMLElement).getByText('claude-agent-sdk:local')).toBeInTheDocument();
    expect(
      within(expandedRow as HTMLElement).getByText('component is unavailable on the configured runtime'),
    ).toBeInTheDocument();
  });

  it('does not present disabled future controls or duplicate profile-management actions', () => {
    renderWithProviders(<AppRoutes />, { route: '/harness' });

    expect(screen.queryByRole('button', { name: /Re-compile/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Add profile/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Import from warble Hub/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Test connection' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Re-sync tables' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Manage source' })).not.toBeInTheDocument();
  });
});
