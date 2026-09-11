// Canonical entrypoint for the direct Node assertion scripts (the ones that
// throw via node:assert rather than registering Vitest test() cases). This
// replaces the long `&&` chain that used to live in package.json's `test`
// script, while preserving that chain's exact semantics: scripts run in
// order, each under the same `node --experimental-strip-types` runtime they
// already relied on, and the first failing script stops the run and its
// exit code becomes the overall exit code (fail-fast, matching `&&`).
import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import { pathToFileURL } from "node:url";

export interface DirectTestResult {
  script: string;
  code: number;
}

export interface DirectTestRunSummary {
  results: DirectTestResult[];
  exitCode: number;
  stoppedAt: string | null;
}

export type SpawnScript = (script: string) => Pick<SpawnSyncReturns<Buffer>, "status">;

export function runDirectTests(scripts: readonly string[], spawn: SpawnScript): DirectTestRunSummary {
  const results: DirectTestResult[] = [];
  for (const script of scripts) {
    const outcome = spawn(script);
    const code = outcome.status ?? 1;
    results.push({ script, code });
    if (code !== 0) {
      return { results, exitCode: code, stoppedAt: script };
    }
  }
  return { results, exitCode: 0, stoppedAt: null };
}

// Order matches the historical `npm test` `&&` chain (test:tuning through
// test:models-css) so failure order and output order stay unchanged.
export const DIRECT_TEST_SCRIPTS = [
  "tests/direct/test-tuning-validation.ts",
  "tests/direct/test-advanced-settings.ts",
  "tests/direct/test-sse.ts",
  "tests/direct/test-chat-stream.ts",
  "tests/direct/test-endpoint-adapters.ts",
  "tests/direct/test-chat-history.ts",
  "tests/direct/test-document-context.ts",
  "tests/direct/test-document-index.ts",
  "tests/direct/test-discover-utils.ts",
  "tests/direct/test-developer-utils.ts",
  "tests/direct/test-mcp-utils.ts",
  "tests/direct/test-runtime-utils.ts",
  "tests/direct/test-config-schema.ts",
  "tests/direct/test-config-save-queue.ts",
  "tests/direct/test-scan-generation.ts",
  "tests/direct/test-vision-state.ts",
  "tests/direct/test-tuning-async.ts",
  "tests/direct/test-model-row-events.ts",
  "tests/direct/test-model-selection-paths.ts",
  "tests/direct/test-project-store.ts",
  "tests/direct/test-lifecycle-utils.ts",
  "tests/direct/test-storage.ts",
  "tests/direct/test-i18n.ts",
  "tests/direct/test-models-css.ts",
] as const;

function spawnWithNode(script: string): Pick<SpawnSyncReturns<Buffer>, "status"> {
  return spawnSync(process.execPath, ["--experimental-strip-types", script], { stdio: "inherit" });
}

function isMainModule(): boolean {
  return process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
}

if (isMainModule()) {
  const summary = runDirectTests(DIRECT_TEST_SCRIPTS, spawnWithNode);
  if (summary.stoppedAt) {
    console.error(`\ndirect test runner stopped after failure in ${summary.stoppedAt}`);
  }
  process.exit(summary.exitCode);
}
