import type { AppStore } from "../../shared/state/store";
import PerformanceBench from "./PerformanceBench";
import "./benchmark.css";

export default function BenchPanel({ store }: { store: AppStore }) {
  return <PerformanceBench store={store} />;
}
