import type { AppStore } from "../../shared/state/store";
import McpView from "./McpView";
import { useMcpController } from "./useMcpController";
import "./mcp.css";

export default function McpPanel(_props: { store: AppStore }) {
  const controller = useMcpController();
  return <McpView controller={controller} />;
}
