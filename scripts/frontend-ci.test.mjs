/* global process */
import test from "node:test";
import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { assignFiles, casesOutputEntry, expectedCaseDigests, inventory, planOutputEntry, reportInventory, testPath, validateAssignments, verifyCaseDigest, verifyCases, verifyPlanDigest, verifyRecords, verifyReport } from "./frontend-ci.mjs";

const sha = "a".repeat(40);
const digest = "b".repeat(64);
const files = [
  { path: "src/one.test.ts", tests: ["same parameter", "same parameter", "suite > keeps data"] },
  { path: "src/two.test.tsx", tests: ["suite > cancel"] },
];
const plan = { formatVersion: 2, sourceSha: sha, shardCount: 2, files: files.map(({ path }) => ({ path })), assignments: [[files[0].path], [files[1].path]] };
const record = (index, overrides = {}) => ({ formatVersion: 2, sourceSha: sha, planSha256: digest, index, shardCount: 2, exitCode: 0, ...overrides });
const cases = (index, overrides = {}) => ({ formatVersion: 2, sourceSha: sha, planSha256: digest, index, shardCount: 2, files: [files[index - 1]], ...overrides });
const report = (path, names) => ({
  success: true, numFailedTests: 0, numFailedTestSuites: 0, numTotalTests: names.length, numPassedTests: names.length,
  testResults: [{ name: path, status: "passed", assertionResults: names.map((name) => {
    const parts = name.split(" > ");
    return { fullName: parts.join(" "), ancestorTitles: parts.slice(0, -1), title: parts.at(-1), status: "passed" };
  }) }],
});

test("weighted planning puts long files on separate runners and retains every file", () => {
  const paths = ["src/slow.test.ts", "src/medium.test.ts", "src/small.test.ts", "src/tiny.test.ts"];
  const assignments = assignFiles(paths.map((path) => ({ path })), 2, Object.fromEntries(paths.map((path, index) => [path, [100, 80, 15, 5][index]])));
  assert.deepEqual(assignments, [[paths[0]], [paths[1], paths[2], paths[3]].sort()]);
  assert.deepEqual(assignments.flat().sort(), paths.sort());
});

test("the plan refuses missing, duplicated and empty file assignments", () => {
  assert.doesNotThrow(() => validateAssignments(plan));
  assert.throws(() => validateAssignments({ ...plan, assignments: [[files[0].path], [files[0].path]] }), /assignments/);
  assert.throws(() => validateAssignments({ ...plan, assignments: [[files[0].path], []] }), /Empty/);
  assert.throws(() => validateAssignments({ ...plan, files: [files[0], files[0]] }), /Duplicate/);
});

test("source and shard provenance cannot be replaced by a successful status", () => {
  assert.doesNotThrow(() => verifyRecords(plan, [record(1), record(2)], digest));
  assert.throws(() => verifyRecords(plan, [record(1)], digest), /Missing/);
  assert.throws(() => verifyRecords(plan, [record(1), record(1)], digest), /Duplicate/);
  assert.throws(() => verifyRecords(plan, [record(1), record(2, { sourceSha: "c".repeat(40) })], digest), /different source/);
  assert.throws(() => verifyRecords(plan, [record(1), record(2, { planSha256: "c".repeat(64) })], digest), /different source/);
  assert.throws(() => verifyRecords(plan, [record(1), record(2, { exitCode: 1 })], digest), /failed/);
});

test("parameterized names retain exact multiplicity and all original assertions must pass", () => {
  assert.doesNotThrow(() => verifyReport(cases(1), report(files[0].path, files[0].tests)));
  assert.throws(() => verifyReport(cases(1), report(files[0].path, files[0].tests.slice(1))), /inventory/);
  assert.throws(() => verifyReport(cases(1), report(files[0].path, [...files[0].tests, files[0].tests[0]])), /inventory/);
  const failed = report(files[0].path, files[0].tests);
  failed.testResults[0].assertionResults[0].status = "pending";
  assert.throws(() => verifyReport(cases(1), failed), /did not pass/);
});

test("a report cannot substitute an assigned file or list one twice", () => {
  assert.throws(() => verifyReport(cases(1), report(files[1].path, files[1].tests)), /inventory/);
  const duplicate = report(files[0].path, files[0].tests);
  duplicate.testResults.push(duplicate.testResults[0]);
  assert.throws(() => reportInventory(duplicate), /Duplicate/);
  assert.throws(() => reportInventory({ ...duplicate, success: false }), /failed/);
});

test("each collected case inventory binds its exact source, plan and assigned files", () => {
  assert.deepEqual(verifyCases(plan, 1, cases(1), digest), [files[0]]);
  for (const changed of [
    cases(1, { formatVersion: 1 }), cases(1, { sourceSha: "d".repeat(40) }), cases(1, { planSha256: "d".repeat(64) }),
    cases(1, { index: 2 }), cases(1, { shardCount: 3 }),
  ]) assert.throws(() => verifyCases(plan, 1, changed, digest), /different source/);
  assert.throws(() => verifyCases(plan, 1, cases(1, { files: [files[1]] }), digest), /collected files/);
  assert.throws(() => verifyCases(plan, 1, cases(1, { files: [files[0], files[0]] }), digest), /case inventory/);
  assert.throws(() => verifyCases(plan, 1, cases(1, { files: [{ path: files[0].path, tests: [] }] }), digest), /Empty/);
});

test("trusted merge requires every independently produced case digest", () => {
  const value = JSON.stringify({ 1: digest, 2: digest });
  assert.deepEqual(expectedCaseDigests(value, 2), { 1: digest, 2: digest });
  for (const bad of ["{}", "[]", "null", JSON.stringify({ 1: digest }), JSON.stringify({ 1: digest, 2: "" }), JSON.stringify({ 1: digest, 2: digest, 3: digest })]) {
    assert.throws(() => expectedCaseDigests(bad, 2));
  }
  const bytes = Buffer.from(JSON.stringify(cases(1)));
  const trusted = createHash("sha256").update(bytes).digest("hex");
  assert.doesNotThrow(() => verifyCaseDigest(bytes, trusted));
  const forged = Buffer.from(JSON.stringify(cases(1, { files: [{ ...files[0], tests: files[0].tests.slice(1) }] })));
  assert.throws(() => verifyCaseDigest(forged, trusted), /trusted producer/);
  assert.throws(() => verifyCaseDigest(bytes, ""), /64 hexadecimal/);
  assert.equal(casesOutputEntry("Linux", 1, digest), `linux_1_cases=${digest}\n`);
  assert.equal(casesOutputEntry("Windows", 2, digest), `windows_2_cases=${digest}\n`);
  assert.throws(() => casesOutputEntry("Windows\nevil=1", 1, digest));
  assert.throws(() => casesOutputEntry("Linux", 0, digest));
});

test("collection normalizes runner paths and retains repeated named cases", () => {
  assert.deepEqual(inventory([{ file: "/synthetic/src/a.test.ts", name: "parameter" }, { file: "/synthetic/src/a.test.ts", name: "parameter" }], "/synthetic"), [{ path: "src/a.test.ts", tests: ["parameter", "parameter"] }]);
  assert.throws(() => testPath("src/../../escape.test.ts"), /Unexpected/);
  assert.throws(() => testPath("src/../escape.test.ts"), /Unexpected/);
  assert.throws(() => testPath("/other/src/a.test.ts", "/synthetic"), /Unexpected/);
});

test("only the producer's independently supplied digest authenticates a plan", () => {
  const bytes = Buffer.from('{"files":[]}\n');
  const digest = createHash("sha256").update(bytes).digest("hex");
  assert.doesNotThrow(() => verifyPlanDigest(bytes, digest));
  assert.throws(() => verifyPlanDigest(bytes, ""), /64 hexadecimal/);
  assert.throws(() => verifyPlanDigest(bytes, "x".repeat(64)), /64 hexadecimal/);
  assert.throws(() => verifyPlanDigest(Buffer.from('{"files":["omitted"]}\n'), digest), /trusted producer digest/);
  assert.equal(planOutputEntry("Linux", digest), `linux_plan=${digest}\n`);
  assert.equal(planOutputEntry("Windows", digest), `windows_plan=${digest}\n`);
  assert.throws(() => planOutputEntry("Windows\nevil=value", digest), /Linux or Windows/);
  assert.throws(() => planOutputEntry("__proto__", digest), /Linux or Windows/);
});

test("real Vitest shards merge every parameterized case and enforce unchanged coverage", { timeout: 60_000 }, (context) => {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  mkdirSync(join(root, "tmp"), { recursive: true });
  const fixture = mkdtempSync(join(root, "tmp/frontend-shard-contract-"));
  context.after(() => rmSync(fixture, { recursive: true, force: true }));
  mkdirSync(join(fixture, "scripts"));
  mkdirSync(join(fixture, "src"));
  copyFileSync(join(root, "scripts/frontend-ci.mjs"), join(fixture, "scripts/frontend-ci.mjs"));
  copyFileSync(join(root, "vitest.ci.config.ts"), join(fixture, "vitest.ci.config.ts"));
  symlinkSync(join(root, "node_modules"), join(fixture, "node_modules"), process.platform === "win32" ? "junction" : "dir");
  writeFileSync(join(fixture, "package.json"), '{"type":"module"}\n');
  writeFileSync(join(fixture, "package-lock.json"), '{}\n');
  writeFileSync(join(fixture, "vitest.setup.ts"), "");
  writeFileSync(join(fixture, "vitest.config.ts"), `import { defineConfig } from 'vitest/config';
export default defineConfig({ cacheDir: 'tmp/vite', test: { environment: 'node', maxWorkers: 1,
  include: ['src/*.test.ts'], coverage: { provider: 'v8', include: ['src/math.ts'], reporter: ['json-summary'],
    reportsDirectory: 'coverage', thresholds: { statements: process.env.AIOLM_COVERAGE_THRESHOLD_PROBE ? 100 : 40,
      branches: 35, functions: 35, lines: 45 } } } });\n`);
  writeFileSync(join(fixture, "src/math.ts"), "export function add(a: number, b: number) { return a + b; }\nexport function unused() { return 0; }\n");
  writeFileSync(join(fixture, "src/one.test.ts"), "import { it, expect } from 'vitest'; import { add } from './math'; if (process.env.AIOLM_FRONTEND_COLLECTION_BLOCKED) throw new Error('Test module recollection is blocked'); it.each([1, 2])('same parameter', n => expect(add(n, 1)).toBe(n + 1));\n");
  writeFileSync(join(fixture, "src/two.test.ts"), "import { it, expect } from 'vitest'; import { add } from './math'; it('second file', () => expect(add(2, 3)).toBe(5));\n");
  const runWithEnv = (args, env = {}) => {
    const result = spawnSync(process.execPath, [join(fixture, "scripts/frontend-ci.mjs"), ...args], {
      cwd: fixture, env: { ...process.env, GITHUB_ACTIONS: "false", ...env }, encoding: "utf8", timeout: 30_000,
    });
    assert.equal(result.status, 0, JSON.stringify({ command: args, stdout: result.stdout, stderr: result.stderr, signal: result.signal, error: result.error?.message }));
  };
  const run = (...args) => runWithEnv(args);
  const sourceSha = spawnSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).stdout.trim();
  const runnerOs = process.platform === "win32" ? "Windows" : "Linux";
  const githubOutput = join(fixture, "tmp/github-output");
  // An importing collector would fail here. Global planning must only discover
  // files; the non-owning shard must never import the blocked test either.
  runWithEnv(["plan", "--shards", "2", "--output", "tmp/plan.json"], { GITHUB_ACTIONS: "true", GITHUB_SHA: sourceSha, RUNNER_OS: runnerOs, GITHUB_OUTPUT: githubOutput, AIOLM_FRONTEND_COLLECTION_BLOCKED: "1" });
  const planDigest = createHash("sha256").update(readFileSync(join(fixture, "tmp/plan.json"))).digest("hex");
  assert.equal(readFileSync(githubOutput, "utf8"), planOutputEntry(runnerOs, planDigest));
  const actualPlan = JSON.parse(readFileSync(join(fixture, "tmp/plan.json"), "utf8"));
  assert.ok(actualPlan.files.every((file) => !Object.hasOwn(file, "tests")));
  const caseDigests = {};
  for (const [index, directory] of [[1, "one"], [2, "two"]]) {
    const ownsBlocked = actualPlan.assignments[index - 1].includes("src/one.test.ts");
    const caseOutput = join(fixture, `tmp/case-output-${index}`);
    runWithEnv(["shard", "--plan", "tmp/plan.json", "--index", String(index), "--output", `tmp/shards/${directory}`], {
      GITHUB_ACTIONS: "true", GITHUB_SHA: sourceSha, RUNNER_OS: runnerOs, GITHUB_OUTPUT: caseOutput,
      ...(ownsBlocked ? {} : { AIOLM_FRONTEND_COLLECTION_BLOCKED: "1" }),
    });
    caseDigests[index] = createHash("sha256").update(readFileSync(join(fixture, `tmp/shards/${directory}/cases.json`))).digest("hex");
    assert.equal(readFileSync(caseOutput, "utf8"), casesOutputEntry(runnerOs, index, caseDigests[index]));
  }
  run("merge", "--plan", "tmp/plan.json", "--input", "tmp/shards");
  const merged = JSON.parse(readFileSync(join(fixture, "tmp/frontend-ci/merged/results.json"), "utf8"));
  assert.equal(merged.numPassedTests, 3);
  assert.equal(merged.numFailedTests, 0);
  const coverage = JSON.parse(readFileSync(join(fixture, "coverage/coverage-summary.json"), "utf8"));
  assert.equal(coverage.total.statements.pct, 50);
  const trustedArguments = ["--expected-plan-sha", planDigest, "--expected-cases-shas", JSON.stringify(caseDigests)];
  runWithEnv(["merge", "--plan", "tmp/plan.json", "--input", "tmp/shards", "--output", "tmp/trusted-merge", ...trustedArguments], { AIOLM_FRONTEND_COLLECTION_BLOCKED: "1" });
  const trusted = JSON.parse(readFileSync(join(fixture, "tmp/trusted-merge/results.json"), "utf8"));
  assert.equal(trusted.numPassedTests, 3);
  const reject = (args, pattern) => {
    const result = spawnSync(process.execPath, [join(fixture, "scripts/frontend-ci.mjs"), ...args], {
      cwd: fixture, env: { ...process.env, GITHUB_ACTIONS: "false" }, encoding: "utf8", timeout: 30_000,
    });
    assert.equal(result.status, 1, result.stdout + result.stderr);
    assert.match(result.stdout + result.stderr, pattern);
  };
  reject(["merge", "--plan", "tmp/plan.json", "--input", "tmp/shards", "--output", "tmp/missing-case-digests", "--expected-plan-sha", planDigest], /all case producer digests/);
  // Replacing both the artifact inventory and its internal self-hash cannot
  // replace the digest delivered independently by the successful producer.
  const casesPath = join(fixture, "tmp/shards/one/cases.json");
  const recordPath = join(fixture, "tmp/shards/one/record.json");
  const originalCases = readFileSync(casesPath);
  const originalRecord = readFileSync(recordPath);
  const forged = JSON.parse(originalCases);
  forged.files[0].tests.pop();
  writeFileSync(casesPath, JSON.stringify(forged));
  const forgedRecord = JSON.parse(originalRecord);
  forgedRecord.casesSha256 = createHash("sha256").update(readFileSync(casesPath)).digest("hex");
  writeFileSync(recordPath, JSON.stringify(forgedRecord));
  reject(["merge", "--plan", "tmp/plan.json", "--input", "tmp/shards", "--output", "tmp/forged-case-digests", ...trustedArguments], /trusted producer digest/);
  writeFileSync(casesPath, originalCases);
  writeFileSync(recordPath, originalRecord);
  const strict = spawnSync(process.execPath, [join(fixture, "scripts/frontend-ci.mjs"), "merge", "--plan", "tmp/plan.json", "--input", "tmp/shards", "--output", "tmp/strict-merge"], {
    cwd: fixture, env: { ...process.env, GITHUB_ACTIONS: "false", AIOLM_COVERAGE_THRESHOLD_PROBE: "1" }, encoding: "utf8", timeout: 30_000,
  });
  assert.equal(strict.status, 1, strict.stdout + strict.stderr);
  assert.match(strict.stdout + strict.stderr, /Coverage for statements.*does not meet global threshold/);
  writeFileSync(join(fixture, "src/omitted.test.ts"), "import { it, expect } from 'vitest'; it('new source', () => expect(1).toBe(1));\n");
  const omitted = spawnSync(process.execPath, [join(fixture, "scripts/frontend-ci.mjs"), "merge", "--plan", "tmp/plan.json", "--input", "tmp/shards", "--output", "tmp/omitted-merge", ...trustedArguments], {
    cwd: fixture, env: { ...process.env, GITHUB_ACTIONS: "false" }, encoding: "utf8", timeout: 30_000,
  });
  assert.equal(omitted.status, 1, omitted.stdout + omitted.stderr);
  assert.match(omitted.stdout + omitted.stderr, /Current source file inventory/);
});
