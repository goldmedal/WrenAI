import { useCallback, useEffect, useState } from 'react';
import { Alert, Button, InputNumber, Space, Typography } from 'antd';
import { t } from '@/i18n/strings';
import { getExecutionLimits, putExecutionLimits } from '@/bff/client';
import { isBffEnabled } from '@/bff/env';
import type { ExecutionLimitsInfo, RuntimeLimits } from './types';

export function limitSourceLabel(source: RuntimeLimits['componentTimeoutSource']): string {
  if (source === 'operator') return t('harness.limitSourceOperator');
  if (source === 'env') return t('harness.limitSourceEnv');
  return t('harness.limitSourceDefault');
}

interface Props {
  /** Called after a successful save so a parent view (the Harness page) can refetch its own copy. */
  onSaved?: () => void;
}

/**
 * The operator's component run timeout. Self-contained: reads `GET /api/config/limits`, writes
 * `PUT /api/config/limits`. That endpoint is a separate config bucket from runtime settings, so a
 * save here never revokes sessions. Renders nothing in fixture mode.
 */
export function ExecutionLimitsEditor({ onSaved }: Props) {
  const [info, setInfo] = useState<ExecutionLimitsInfo>();
  const [seconds, setSeconds] = useState<number | null>(null);
  const [error, setError] = useState<string>();
  const [saving, setSaving] = useState(false);

  const apply = useCallback((next: ExecutionLimitsInfo) => {
    setInfo(next);
    setSeconds((next.operatorTimeoutMs ?? next.componentTimeoutMs) / 1000);
  }, []);
  const load = useCallback(async () => {
    try {
      apply(await getExecutionLimits());
      setError(undefined);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [apply]);
  useEffect(() => {
    if (isBffEnabled()) void load();
  }, [load]);

  if (!isBffEnabled()) return null;
  if (!info) return error ? <Alert type="error" showIcon message={t('harness.limitsLoadErrorTitle')} description={error} /> : null;

  const save = async (componentTimeoutMs: number | null) => {
    setSaving(true);
    try {
      apply(await putExecutionLimits(componentTimeoutMs));
      setError(undefined);
      onSaved?.();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  };
  const locked = !info.editable || saving;

  return (
    <Space direction="vertical" size={8} style={{ width: '100%' }}>
      <Typography.Text>
        {t('harness.componentTimeoutEffective')}: {info.componentTimeoutMs / 1000} s · {limitSourceLabel(info.componentTimeoutSource)}
      </Typography.Text>
      <Typography.Text type="secondary">
        {t('harness.limitsRange')} {info.minMs / 1000}–{info.ceilingMs / 1000} s · {t('harness.limitsDeployerValue')} {info.deployerTimeoutMs / 1000} s
      </Typography.Text>
      {!info.editable && <Alert type="info" showIcon message={info.editableReason ?? t('harness.limitsNotEditable')} />}
      <Space wrap>
        <InputNumber
          aria-label={t('harness.limitsInputLabel')}
          min={info.minMs / 1000}
          max={info.ceilingMs / 1000}
          step={10}
          value={seconds}
          disabled={locked}
          addonAfter="s"
          onChange={(value) => setSeconds(typeof value === 'number' ? value : null)}
        />
        <Button type="primary" disabled={locked || seconds === null} onClick={() => void save(Math.round((seconds ?? 0) * 1000))}>
          {saving ? t('harness.limitsSaving') : t('harness.limitsSave')}
        </Button>
        <Button disabled={locked || info.operatorTimeoutMs === undefined} onClick={() => void save(null)}>
          {t('harness.limitsReset')}
        </Button>
      </Space>
      {error && <Alert type="error" showIcon message={t('harness.limitsSaveErrorTitle')} description={error} />}
    </Space>
  );
}
