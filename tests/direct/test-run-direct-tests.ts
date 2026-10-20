import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { runDirectTests, DIRECT_TEST_SCRIPTS, type DirectTestResult } from "./run.ts";

const packageJson = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8")) as {
  scripts?: Record<string, string>;
};
const nodeDirectPrefix = "node --experimental-strip-types ";
const harnessPath = "tests/direct/test-run-direct-tests.ts";
// Derive the expected child set from package.json rather than mirroring the runner list.
// The harness itself is excluded so this assertion cannot recurse through its own command.
const packageDirectScripts = Object.values(packageJson.scripts ?? {}).flatMap((command) => {
  if (!command.startsWith(nodeDirectPrefix) || !command.endsWith(".ts")) return [];
  const path = command.slice(nodeDirectPrefix.length);
  return path.startsWith("tests/direct/test-") && path !== harnessPath ? [path] : [];
});
const sortedPaths = (paths: readonly string[]) => [...paths].sort();

assert.equal(new Set(DIRECT_TEST_SCRIPTS).size, DIRECT_TEST_SCRIPTS.length, "direct test script list should have no duplicates");
assert.equal(new Set(packageDirectScripts).size, packageDirectScripts.length, "package direct test commands should have no duplicate paths");
assert.deepEqual(
  sortedPaths(DIRECT_TEST_SCRIPTS),
  sortedPaths(packageDirectScripts),
  "runner child paths should match package.json direct Node commands",
);
for (const script of DIRECT_TEST_SCRIPTS) {
  assert.ok(existsSync(new URL(`../../${script}`, import.meta.url)), `direct test file is missing: ${script}`);
}

// All scripts succeed: every script runs, in order, exit code 0.
{
  const invoked: string[] = [];
  const summary = runDirectTests(["a.ts", "b.ts", "c.ts"], (script) => {
    invoked.push(script);
    return { status: 0 };
  });
  assert.deepEqual(invoked, ["a.ts", "b.ts", "c.ts"]);
  assert.equal(summary.exitCode, 0);
  assert.equal(summary.stoppedAt, null);
  const codes: DirectTestResult[] = summary.results;
  assert.deepEqual(codes, [
    { script: "a.ts", code: 0 },
    { script: "b.ts", code: 0 },
    { script: "c.ts", code: 0 },
  ]);
}

// A middle script fails: propagate its exit code and stop before later
// scripts run (fail-fast, matching the historical `&&` chain).
{
  const invoked: string[] = [];
  const summary = runDirectTests(["a.ts", "b.ts", "c.ts"], (script) => {
    invoked.push(script);
    return { status: script === "b.ts" ? 1 : 0 };
  });
  assert.deepEqual(invoked, ["a.ts", "b.ts"], "c.ts must not run after b.ts fails");
  assert.equal(summary.exitCode, 1);
  assert.equal(summary.stoppedAt, "b.ts");
}

// A null status (killed by signal) still counts as a failure.
{
  const summary = runDirectTests(["a.ts"], () => ({ status: null }));
  assert.equal(summary.exitCode, 1);
  assert.equal(summary.stoppedAt, "a.ts");
}

console.log("run-direct-tests harness tests passed");
