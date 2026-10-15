import type { RuntimeDescriptor } from '../../shared/api/runtimeHelp';
import { useI18n } from '../../shared/i18n/i18n';
import { runtimeOptionsCopy } from '../../shared/i18n/runtimeOptionsCopy';
import FeedbackBanner from '../../shared/ui/FeedbackBanner';
import RuntimeFactDifferences from './RuntimeFactDifferences';

/** Help changes and retained settings need the same review at registration
 * and in an installed runtime's option editor. */
export default function RuntimeSchemaChanges({ descriptor }: { descriptor: RuntimeDescriptor }) {
  const { locale } = useI18n();
  const copy = runtimeOptionsCopy[locale];
  const diff = descriptor.diff;
  return <>
    {diff && <ul>
      {diff.added.length > 0 && <li>{copy.added}: {diff.added.join(', ')}</li>}
      {diff.removed.length > 0 && <li>{copy.removed}: {diff.removed.join(', ')}</li>}
      {diff.changed.length > 0 && <li>{copy.changed}: {diff.changed.join(', ')}</li>}
    </ul>}
    {descriptor.retained.length > 0 && <FeedbackBanner tone="warning">{copy.retained}: {descriptor.retained.join(', ')}</FeedbackBanner>}
    <RuntimeFactDifferences metadata={descriptor.metadata} schema={descriptor.schema} />
  </>;
}
