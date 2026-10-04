import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

const host = process.env.TAURI_DEV_HOST;

export default defineConfig(async () => ({
  plugins: [react(), tailwindcss()],
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
    host: host || false,
    hmr: host
      ? { protocol: "ws", host, port: 1421 }
      : undefined,
    // Temporary tools, generated HTML and runtime/build trees must not consume
    // file watchers or reload an active dev session.
    watch: { ignored: ["**/src-tauri/**", "**/.codex-target/**", "**/coverage/**", "**/tmp/**"] },
  },
}));
