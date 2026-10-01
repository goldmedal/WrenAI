import { create } from 'zustand';
import { isBffEnabled } from '@/bff/env';
import { addProfile, deleteProfile, getHarness, listProfiles, type WarbleProfile } from '@/bff/client';
import type { HarnessPurpose, HarnessView } from './types';
import { t } from '@/i18n/strings';
import { fixtureProfileRegistry } from './fixtures';

export const HARNESS_PURPOSES: readonly HarnessPurpose[] = ['setup', 'analysis', 'context_enrichment'];

/** The analysis purpose's fixed profile; selecting it is the same as selecting no profile. */
export const DEFAULT_CONVERSATION_PROFILE = 'genbi-default';

let latestRequest = 0;
let latestProfilesRequest = 0;

interface HarnessStoreState {
  /** Key of the currently selected purpose in the sidebar. */
  selectedPurpose: HarnessPurpose;
  /** For the analysis purpose, which conversation profile the canvas describes. */
  selectedProfile: string;
  /** Live-fetched harness view, once loaded. Fixture mode never populates this. */
  harness?: HarnessView;
  /** True while the live harness fetch is in flight. Always false in fixture mode. */
  loading: boolean;
  /** Set when the live harness fetch failed. Fixture mode never populates this. */
  error?: string;
  /** The profile registry: live rows from the BFF, or the fixture registry when no BFF is configured. */
  profiles: WarbleProfile[];
  profilesLoading: boolean;
  profilesError?: string;
  /** Result of the last registration attempt, for the Add profile form. */
  addProfileResult?: { kind: 'registered' | 'refused' | 'error'; message: string; profile?: WarbleProfile };
  /** Select a system purpose (setup, context enrichment) or the default analysis profile. */
  selectProfile: (purpose: HarnessPurpose) => void;
  /** Select a conversation profile by registry id; the purpose becomes analysis. */
  selectConversationProfile: (id: string) => void;
  /** Live-only: fetch the harness from the BFF. No-op in fixture mode. */
  loadHarness: () => void;
  /** Fetch the registry (live) or install the fixture registry. */
  loadProfiles: () => Promise<void>;
  /** Register a profile directory; the verdict lands in `addProfileResult` and the registry reloads. */
  registerProfile: (sourcePath: string) => Promise<void>;
  /** Remove a user profile and reload the registry. */
  removeProfile: (id: string) => Promise<void>;
}

/**
 * Harness page state: the sidebar's selection, the live harness view once loaded, and the
 * conversation-profile registry the sidebar lists. One store per feature module. With no
 * `VITE_BFF_URL` set, `harness` stays undefined and the page falls back to fixtures, and the
 * registry is the fixture registry; when the BFF is enabled, `loadHarness` fetches the selected
 * purpose (and profile) from `GET /api/harness`. A request that is late for a prior selection
 * cannot replace the active view.
 */
export const useHarnessStore = create<HarnessStoreState>()((set, get) => ({
  selectedPurpose: 'analysis',
  selectedProfile: DEFAULT_CONVERSATION_PROFILE,
  harness: undefined,
  loading: false,
  error: undefined,
  profiles: isBffEnabled() ? [] : fixtureProfileRegistry,
  profilesLoading: false,
  profilesError: undefined,
  addProfileResult: undefined,

  selectProfile: (purpose) => {
    if (!HARNESS_PURPOSES.includes(purpose)) return;
    set({ selectedPurpose: purpose, selectedProfile: DEFAULT_CONVERSATION_PROFILE, harness: undefined, loading: false, error: undefined });
    get().loadHarness();
  },

  selectConversationProfile: (id) => {
    set({ selectedPurpose: 'analysis', selectedProfile: id, harness: undefined, loading: false, error: undefined });
    get().loadHarness();
  },

  loadHarness: () => {
    if (!isBffEnabled()) return;

    const purpose = get().selectedPurpose;
    const profile = get().selectedProfile;
    const request = ++latestRequest;
    set({ loading: true, error: undefined });
    getHarness(purpose, purpose === 'analysis' && profile !== DEFAULT_CONVERSATION_PROFILE ? profile : undefined)
      .then((harness) => {
        if (request !== latestRequest || get().selectedPurpose !== purpose || get().selectedProfile !== profile) return;
        set({ harness, loading: false, error: undefined });
      })
      .catch((err: unknown) => {
        if (request !== latestRequest || get().selectedPurpose !== purpose || get().selectedProfile !== profile) return;
        set({ loading: false, error: err instanceof Error ? err.message : t('harness.loadFailedMessage') });
      });
  },

  async loadProfiles() {
    if (!isBffEnabled()) { set({ profiles: fixtureProfileRegistry, profilesLoading: false, profilesError: undefined }); return; }
    const request = ++latestProfilesRequest;
    set({ profilesLoading: true, profilesError: undefined });
    try {
      const { profiles } = await listProfiles();
      if (request !== latestProfilesRequest) return;
      set({ profiles, profilesLoading: false });
    } catch (err: unknown) {
      if (request !== latestProfilesRequest) return;
      set({ profilesLoading: false, profilesError: err instanceof Error ? err.message : t('harness.profilesLoadFailed') });
    }
  },

  async registerProfile(sourcePath) {
    if (!isBffEnabled()) return;
    set({ addProfileResult: undefined });
    try {
      const { profile } = await addProfile(sourcePath);
      set({
        addProfileResult: profile.selectable
          ? { kind: 'registered', message: t('harness.addProfileRegistered'), profile }
          : { kind: 'refused', message: `${t('harness.addProfileRefused')} ${profile.admission.reason ?? t('harness.profileReadinessUnavailable')}`, profile },
      });
      await get().loadProfiles();
      if (profile.selectable) get().selectConversationProfile(profile.id);
    } catch (err: unknown) {
      set({ addProfileResult: { kind: 'error', message: err instanceof Error ? err.message : t('harness.profilesLoadFailed') } });
    }
  },

  async removeProfile(id) {
    if (!isBffEnabled()) return;
    await deleteProfile(id);
    if (get().selectedProfile === id) set({ selectedProfile: DEFAULT_CONVERSATION_PROFILE, harness: undefined });
    await get().loadProfiles();
    if (get().selectedPurpose === 'analysis') get().loadHarness();
  },
}));
