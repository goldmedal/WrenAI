import { useEffect, useState } from 'react';
import { Alert, Button, Input, Popconfirm, Tag, Typography } from 'antd';
import type { SidebarItem } from '@/fixtures';
import { SidebarList } from '@/app/shell/SidebarList';
import { isBffEnabled } from '@/bff/env';
import { t } from '@/i18n/strings';
import { DEFAULT_CONVERSATION_PROFILE, HARNESS_PURPOSES, useHarnessStore } from './useHarnessStore';

/**
 * Harness page's contextual sidebar: the two system purposes (Setup, Context enrichment), then
 * every conversation profile the registry lists. The analysis purpose's fixed profile is the first
 * conversation entry and keeps its "Analyze data" label; the others are named by their registry id.
 * A profile the registry refused stays listed, disabled, with its reason, so a reader learns why it
 * is not offered instead of wondering where it went. Below the list, an operator registers a new
 * profile directory; in fixture mode the registry is sample data and the form is inert.
 */
export function HarnessSidebar() {
  const selectedPurpose = useHarnessStore((s) => s.selectedPurpose);
  const selectedProfile = useHarnessStore((s) => s.selectedProfile);
  const selectProfile = useHarnessStore((s) => s.selectProfile);
  const selectConversationProfile = useHarnessStore((s) => s.selectConversationProfile);
  const harness = useHarnessStore((s) => s.harness);
  const profiles = useHarnessStore((s) => s.profiles);
  const profilesError = useHarnessStore((s) => s.profilesError);
  const loadProfiles = useHarnessStore((s) => s.loadProfiles);
  const registerProfile = useHarnessStore((s) => s.registerProfile);
  const removeProfile = useHarnessStore((s) => s.removeProfile);
  const addProfileResult = useHarnessStore((s) => s.addProfileResult);
  const live = isBffEnabled();
  const [sourcePath, setSourcePath] = useState('');
  const [registering, setRegistering] = useState(false);
  const [removing, setRemoving] = useState<string>();
  const [removeError, setRemoveError] = useState<string>();

  useEffect(() => { void loadProfiles(); }, [loadProfiles]);

  const labels: Record<typeof HARNESS_PURPOSES[number], string> = {
    setup: 'Setup',
    analysis: 'Analyze data',
    context_enrichment: 'Context enrichment',
  };
  const systemItems: SidebarItem[] = (['setup', 'context_enrichment'] as const).map((purpose) => ({
    key: purpose,
    label: labels[purpose],
    meta: harness?.purpose.purpose === purpose ? harness.purpose.profile : t('harness.systemPurposeMeta'),
  }));
  const conversation = profiles.filter((profile) => profile.role === 'conversation');
  const ordered = [
    ...conversation.filter((profile) => profile.id === DEFAULT_CONVERSATION_PROFILE),
    ...conversation.filter((profile) => profile.id !== DEFAULT_CONVERSATION_PROFILE),
  ];
  // Without a registry row the default is still a purpose the BFF always serves.
  const conversationItems: SidebarItem[] = (ordered.length ? ordered : [{ id: DEFAULT_CONVERSATION_PROFILE, selectable: true, admission: { status: 'admitted' as const, checkedAt: '' }, kind: 'builtin' as const, role: 'conversation' as const, components: [], createdAt: '', updatedAt: '' }]).map((profile) => ({
    key: profile.id === DEFAULT_CONVERSATION_PROFILE ? 'analysis' : `profile:${profile.id}`,
    label: profile.id === DEFAULT_CONVERSATION_PROFILE ? labels.analysis : profile.id,
    meta: profile.id === DEFAULT_CONVERSATION_PROFILE
      ? profile.id
      : profile.selectable
        ? `${profile.kind === 'user' ? 'user · ' : ''}${profile.entry?.kind === 'agent' ? `enters at ${profile.entry.verb ?? 'one component'}` : 'scope entry'}`
        : `${t('harness.profileReadinessUnavailable')} · ${profile.admission.reason ?? ''}`,
    disabled: !profile.selectable,
  }));
  const selectedKey = selectedPurpose === 'analysis' && selectedProfile !== DEFAULT_CONVERSATION_PROFILE ? `profile:${selectedProfile}` : selectedPurpose;
  const userProfiles = conversation.filter((profile) => profile.kind === 'user');

  const onSelect = (key: string) => {
    if (key.startsWith('profile:')) { selectConversationProfile(key.slice('profile:'.length)); return; }
    selectProfile(key as typeof HARNESS_PURPOSES[number]);
  };
  const register = async () => {
    setRegistering(true);
    try { await registerProfile(sourcePath.trim()); } finally { setRegistering(false); }
  };
  const remove = async (id: string) => {
    setRemoving(id); setRemoveError(undefined);
    try { await removeProfile(id); } catch (reason) { setRemoveError(reason instanceof Error ? reason.message : String(reason)); } finally { setRemoving(undefined); }
  };

  return (
    <>
      <SidebarList
        header={t('harness.profilesHeader')}
        items={[...systemItems, ...conversationItems]}
        selectedKey={selectedKey}
        onSelect={onSelect}
      />
      <section aria-label={t('harness.addProfileTitle')} style={{ padding: '4px 16px 12px', display: 'flex', flexDirection: 'column', gap: 8 }}>
        <Typography.Text type="secondary" style={{ fontSize: 11, textTransform: 'uppercase', letterSpacing: 0.6 }}>
          {t('harness.addProfileTitle')} {!live ? <Tag style={{ marginInlineStart: 6 }}>{t('harness.fixtureRegistryBadge')}</Tag> : null}
        </Typography.Text>
        {!live ? <Typography.Text type="secondary" style={{ fontSize: 12 }}>{t('harness.addProfileFixtureNote')}</Typography.Text> : <Typography.Text type="secondary" style={{ fontSize: 12 }}>{t('harness.addProfileLead')}</Typography.Text>}
        {profilesError ? <Alert type="error" showIcon message={t('harness.profilesLoadFailed')} description={profilesError} /> : null}
        <Input
          aria-label={t('harness.addProfilePathLabel')}
          placeholder="/absolute/path/to/profile"
          value={sourcePath}
          disabled={!live || registering}
          onChange={(event) => setSourcePath(event.target.value)}
          onPressEnter={() => { if (live && sourcePath.trim()) void register(); }}
        />
        <Button type="primary" size="small" disabled={!live || !sourcePath.trim()} loading={registering} onClick={() => void register()}>{t('harness.addProfileButton')}</Button>
        {addProfileResult ? <Alert
          role="status"
          type={addProfileResult.kind === 'registered' ? 'success' : addProfileResult.kind === 'refused' ? 'warning' : 'error'}
          showIcon
          message={addProfileResult.kind === 'error' ? addProfileResult.message : `${addProfileResult.profile?.id ?? ''}: ${addProfileResult.message}`}
        /> : null}
        {live && userProfiles.length ? <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
          {userProfiles.map((profile) => <div key={profile.id} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
            <Typography.Text style={{ fontSize: 12 }} title={profile.sourceDir}>{profile.id}</Typography.Text>
            <Popconfirm title={t('harness.removeProfileConfirm')} onConfirm={() => void remove(profile.id)} okText={t('harness.removeProfile')}>
              <Button size="small" danger loading={removing === profile.id} aria-label={`${t('harness.removeProfile')} ${profile.id}`}>{t('harness.removeProfile')}</Button>
            </Popconfirm>
          </div>)}
        </div> : null}
        {removeError ? <Alert type="error" showIcon message={removeError} /> : null}
      </section>
    </>
  );
}
