/** Navigation targets accepted by feature callbacks; the app owns their layout. */
export type ViewId =
  | "chat" | "projects" | "models" | "discover" | "lora"
  | "runtimes" | "tuning" | "profiles" | "benchmark"
  | "api" | "mcp" | "settings";
