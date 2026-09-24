import { Alert } from 'antd';
import { t } from '@/i18n/strings';
import type { UnavailableBlock as UnavailableBlockData } from '../types';

interface Props {
  block: UnavailableBlockData;
}

/**
 * A report cell with no value: the answer was refused on its way out of the
 * private zone, or the data oracle could not give one. Shows the cell's label,
 * N/A, and the reason category (the only part of the reason that crossed).
 */
export function UnavailableBlock({ block }: Props) {
  return (
    <Alert
      type="warning"
      showIcon
      message={`${block.label}: ${t('envelope.unavailableValue')}`}
      description={
        <span>
          {t('envelope.unavailableReasonPrefix')}
          <code>{block.reason_category}</code>
          {block.note ? ` — ${block.note}` : null}
        </span>
      }
    />
  );
}
