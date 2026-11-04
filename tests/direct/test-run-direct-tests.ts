import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { assertDirectTestInventory, runDirectTests, DIRECT_TEST_SCRIPTS, type DirectTestResult } from "./run.ts";

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
assertDirectTestInventory(DIRECT_TEST_SCRIPTS);

// Physical fixture locations still use repository-relative logical paths.
{
  const directory = mkdtempSync(join(tmpdir(), "aiolm-direct-inventory-"));
  const directoryUrl = pathToFileURL(`${directory}/`);
  const registered = ["tests/direct/test-registered.ts"];
  try {
    writeFileSync(join(directory, "test-registered.ts"), "");
    writeFileSync(join(directory, "test-run-direct-tests.ts"), "");
    writeFileSync(join(directory, "notes.ts"), "");
    mkdirSync(join(directory, "test-directory.ts"));
    assertDirectTestInventory(registered, directoryUrl);

    writeFileSync(join(directory, "test-unregistered.ts"), "");
    assert.throws(
      () => assertDirectTestInventory(registered, directoryUrl),
      { message: "Direct test inventory mismatch\nUnregistered: tests/direct/test-unregistered.ts" },
    );
    rmSync(join(directory, "test-unregistered.ts"));

    assert.throws(
      () => assertDirectTestInventory([...registered, "tests/direct/test-missing.ts"], directoryUrl),
      { message: "Direct test inventory mismatch\nMissing: tests/direct/test-missing.ts" },
    );

    writeFileSync(join(directory, "test-z-orphan.ts"), "");
    writeFileSync(join(directory, "test-a-orphan.ts"), "");
    assert.throws(
      () => assertDirectTestInventory([
        ...registered,
        "tests/direct/test-z-missing.ts",
        "tests/direct/test-a-missing.ts",
        ...registered,
        "tests/direct/test-z-missing.ts",
      ], directoryUrl),
      {
        message: [
          "Direct test inventory mismatch",
          "Unregistered: tests/direct/test-a-orphan.ts, tests/direct/test-z-orphan.ts",
          "Missing: tests/direct/test-a-missing.ts, tests/direct/test-z-missing.ts",
          "Duplicate: tests/direct/test-registered.ts, tests/direct/test-z-missing.ts",
        ].join("\n"),
      },
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

// The real CLI must reject an orphan before it can launch even the first child.
{
  const directory = mkdtempSync(join(tmpdir(), "aiolm-direct-cli-"));
  const directDirectory = join(directory, "tests", "direct");
  const sentinel = "DIRECT_CHILD_MUST_NOT_RUN";
  try {
    mkdirSync(directDirectory, { recursive: true });
    writeFileSync(join(directory, "package.json"), JSON.stringify({ type: "module" }));
    copyFileSync(new URL("./run.ts", import.meta.url), join(directDirectory, "run.ts"));
    for (const script of DIRECT_TEST_SCRIPTS) {
      writeFileSync(join(directory, script), `console.log(${JSON.stringify(sentinel)});\n`);
    }
    writeFileSync(join(directDirectory, "test-unregistered.ts"), "");
    const outcome = spawnSync(process.execPath, ["--experimental-strip-types", "tests/direct/run.ts"], {
      cwd: directory,
      encoding: "utf8",
    });
    assert.ifError(outcome.error);
    assert.equal(outcome.status, 1);
    assert.match(outcome.stderr, /Direct test inventory mismatch/);
    assert.match(outcome.stderr, /Unregistered: tests\/direct\/test-unregistered[.]ts/);
    assert.ok(!`${outcome.stdout}${outcome.stderr}`.includes(sentinel), "no child should run before inventory validation");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
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
