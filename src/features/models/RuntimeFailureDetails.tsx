import DiagnosticDetails, { isLongDiagnostic, summarizeDiagnostic } from '../../shared/ui/DiagnosticDetails';
import { normalizeDisplayText } from '../../shared/lib/displayPaths';

/**
 * A model failure shown where it happened: the error stays the readable
 * summary and the runtime log reported with it sits behind the existing
 * diagnostic disclosure, so a startup failure can be read and copied in full
 * without a separate diagnostics page. Short errors without a log stay inline.
 */
export default function RuntimeFailureDetails({ error, log }: { error?: string | null; log?: string | null }) {
  const message = error?.trim() ? error : '';
  const tail = log?.trim() ? log : '';
  if (!message && !tail) return null;
  if (!tail && !isLongDiagnostic(message)) return <p className="app-diagnostic-summary">{normalizeDisplayText(message)}</p>;
  const detail = message && tail ? `${message}\n\n${tail}` : message || tail;
  return <DiagnosticDetails summary={summarizeDiagnostic(message || tail)} detail={detail} />;
}
