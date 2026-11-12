import type { AppStore } from '../../shared/state/store';
import { PerformanceBenchView } from './PerformanceBenchView';
import { usePerformanceBench } from './usePerformanceBench';

export default function PerformanceBench(props: { store: AppStore; active?: boolean }) {
  return <PerformanceBenchView controller={usePerformanceBench(props)} />;
}
