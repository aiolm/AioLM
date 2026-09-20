import type { AppStore } from "../../shared/state/store";
import PerformanceBench from "./PerformanceBench";
import "./benchmark.css";

export default function BenchPanel({ store, active = true }: { store: AppStore; active?: boolean }) {
  return <PerformanceBench store={store} active={active} />;
}
