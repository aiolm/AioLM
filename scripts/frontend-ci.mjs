/* global process, console */
// Run disjoint frontend files in parallel, then require the exact collected
// test inventory and the original whole-suite coverage gate before success.
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { appendFileSync, copyFileSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const VERSION = 1;
const INPUTS = ["vitest.config.ts", "vitest.ci.config.ts", "vitest.setup.ts", "scripts/frontend-ci.mjs", "package.json", "package-lock.json"];
const hash = (value) => createHash("sha256").update(value).digest("hex");
const json = (path) => JSON.parse(readFileSync(path, "utf8"));
const writeJson = (path, value) => { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, JSON.stringify(value, null, 2) + "\n"); };
function requireThat(condition, message) { if (!condition) throw new Error(message); }

export function testPath(path, root = ROOT) {
  const candidate = isAbsolute(path) ? relative(root, path) : path;
  const normalized = candidate.split(sep).join("/");
  requireThat(/^src\/.+\.test\.(?:ts|tsx)$/.test(normalized) && normalized.split("/").every((part) => part && part !== "." && part !== ".."), `Unexpected test path: ${path}`);
  return normalized;
}

function same(actual, expected, label) {
  requireThat(JSON.stringify(actual) === JSON.stringify(expected), `${label} does not match the collected test inventory`);
}

export function inventory(tests, root = ROOT) {
  const files = new Map();
  for (const test of tests) {
    requireThat(typeof test.name === "string" && test.name.length > 0, "Missing collected test name");
    const file = testPath(test.file, root);
    const names = files.get(file) ?? [];
    names.push(test.name);
    files.set(file, names);
  }
  requireThat(files.size > 0, "No frontend tests collected");
  // Names are a multiset: parameterized cases may intentionally share a name.
  // Their multiplicity must still match exactly, and files cannot overlap.
  return [...files].sort(([a], [b]) => a.localeCompare(b)).map(([path, names]) => ({ path, tests: names.sort() }));
}

export function assignFiles(files, count, timings = {}, sizes = {}) {
  requireThat(Number.isInteger(count) && count > 0 && count <= files.length, "Invalid frontend shard count");
  const prior = Object.values(timings).filter((value) => Number.isFinite(value) && value > 0).sort((a, b) => a - b);
  const fallback = prior.length ? prior[Math.floor(prior.length / 2)] : 1;
  const weight = (file) => Number.isFinite(timings[file]) && timings[file] > 0 ? timings[file] : prior.length ? fallback : Math.max(1, sizes[file] ?? 1);
  const ordered = [...files].sort((a, b) => weight(b.path) - weight(a.path) || a.path.localeCompare(b.path));
  const bins = Array.from({ length: count }, () => ({ weight: 0, files: [] }));
  for (const file of ordered) {
    const target = bins.reduce((best, bin) => bin.weight < best.weight ? bin : best, bins[0]);
    target.files.push(file.path);
    target.weight += weight(file.path);
  }
  return bins.map((bin) => bin.files.sort());
}

function sourceSha() {
  const result = spawnSync("git", ["rev-parse", "HEAD"], { cwd: ROOT, encoding: "utf8" });
  requireThat(result.status === 0, "Cannot resolve frontend source commit");
  const sha = result.stdout.trim();
  requireThat(/^[a-f0-9]{40}$/.test(sha), "Invalid frontend source commit");
  if (process.env.GITHUB_ACTIONS === "true") same(sha, process.env.GITHUB_SHA, "Checked-out SHA");
  return sha;
}

function runVitest(args, env = {}) {
  const cli = join(dirname(fileURLToPath(import.meta.resolve("vitest/package.json"))), "vitest.mjs");
  const result = spawnSync(process.execPath, [cli, ...args], { cwd: ROOT, env: { ...process.env, ...env }, stdio: "inherit" });
  if (result.error) throw result.error;
  return result.status ?? 1;
}

function collect(output) {
  mkdirSync(dirname(output), { recursive: true });
  const code = runVitest(["list", "--config", "vitest.config.ts", "--json", output]);
  requireThat(code === 0, "Frontend test collection failed");
  return inventory(json(output));
}

function checkSourceFiles(plan, output) {
  // filesOnly applies the real include/exclude globs without importing tests
  // or constructing hundreds of jsdom environments a second time.
  const code = runVitest(["list", "--config", "vitest.config.ts", "--filesOnly", "--json", output]);
  requireThat(code === 0, "Frontend source file discovery failed");
  const current = json(output).map((entry) => testPath(entry.file)).sort();
  same(current, plan.files.map((entry) => entry.path).sort(), "Current source file inventory");
}

export function verifyPlanDigest(bytes, expected) {
  requireThat(typeof expected === "string" && /^[a-f0-9]{64}$/i.test(expected), "Expected frontend plan digest must be 64 hexadecimal characters");
  requireThat(hash(bytes) === expected.toLowerCase(), "Frontend plan does not match the trusted producer digest");
}

export function planOutputEntry(runnerOs, digest) {
  const key = runnerOs === "Linux" ? "linux_plan" : runnerOs === "Windows" ? "windows_plan" : undefined;
  requireThat(key, "Frontend plan output requires a Linux or Windows runner");
  requireThat(/^[a-f0-9]{64}$/.test(digest), "Invalid frontend plan output digest");
  return `${key}=${digest}\n`;
}

function stamp(files) {
  return {
    files: files.map((file) => ({ ...file, sha256: hash(readFileSync(resolve(ROOT, file.path))) })),
    inputs: INPUTS.map((path) => ({ path, sha256: hash(readFileSync(resolve(ROOT, path))) })),
  };
}

export function validateAssignments(plan) {
  requireThat(plan.formatVersion === VERSION, "Unknown frontend plan version");
  requireThat(Array.isArray(plan.files) && Array.isArray(plan.assignments) && plan.assignments.length === plan.shardCount, "Invalid frontend plan");
  requireThat(plan.files.length > 0 && plan.shardCount > 0, "Empty frontend plan");
  const expected = plan.files.map((file) => testPath(file.path)).sort();
  requireThat(new Set(expected).size === expected.length, "Duplicate frontend file in plan");
  const assigned = plan.assignments.flatMap((files) => {
    requireThat(Array.isArray(files) && files.length > 0, "Empty frontend shard");
    return files.map((file) => testPath(file));
  }).sort();
  same(assigned, expected, "Shard file assignments");
}

function validateCheckout(plan) {
  validateAssignments(plan);
  same(plan.sourceSha, sourceSha(), "Plan source SHA");
  const current = stamp(plan.files.map(({ path, tests }) => ({ path, tests })));
  same(current.files, plan.files, "Test source hashes");
  same(current.inputs, plan.inputs, "Frontend configuration hashes");
}

export function reportInventory(report, root = ROOT) {
  requireThat(report.success === true && report.numFailedTests === 0 && report.numFailedTestSuites === 0, "Frontend shard contains failed tests or suites");
  requireThat(Array.isArray(report.testResults), "Missing frontend test results");
  const seen = new Set();
  const tests = [];
  for (const file of report.testResults) {
    const path = testPath(file.name, root);
    requireThat(!seen.has(path), `Duplicate frontend result file: ${path}`);
    seen.add(path);
    requireThat(file.status === "passed" && Array.isArray(file.assertionResults) && file.assertionResults.length > 0, `Incomplete frontend file: ${path}`);
    for (const test of file.assertionResults) {
      requireThat(test.status === "passed", `Frontend test did not pass: ${path}: ${test.fullName}`);
      requireThat(Array.isArray(test.ancestorTitles) && test.ancestorTitles.every((name) => typeof name === "string") && typeof test.title === "string", "Incomplete frontend test name");
      // The list command separates suite names with ` > `, while the JSON
      // reporter's fullName joins them with spaces. Reconstruct from the
      // reporter's structured names so nested/parameterized cases compare.
      tests.push({ file: path, name: [...test.ancestorTitles, test.title].join(" > ") });
    }
  }
  requireThat(report.numTotalTests === tests.length && report.numPassedTests === tests.length, "Frontend report test count mismatch");
  return inventory(tests, root);
}

export function verifyReport(plan, index, report, root = ROOT) {
  const assigned = plan.assignments[index - 1];
  requireThat(Array.isArray(assigned), "Unknown frontend shard index");
  const expected = plan.files.filter((file) => assigned.includes(file.path)).map(({ path, tests }) => ({ path, tests }));
  same(reportInventory(report, root), expected, `Shard ${index} tests`);
}

function checkedOutput(path) {
  const output = resolve(ROOT, path);
  requireThat(output.startsWith(resolve(ROOT, "tmp") + sep), "Frontend reports must be under repository tmp/");
  return output;
}

function makePlan(options) {
  const output = checkedOutput(options.output ?? "tmp/frontend-ci/plan.json");
  const collected = collect(join(dirname(output), "collected.json"));
  const timings = options.timings && existsSync(options.timings) ? json(options.timings).files : {};
  const count = Number(options.shards ?? 2);
  const sizes = Object.fromEntries(collected.map((file) => [file.path, readFileSync(resolve(ROOT, file.path)).length]));
  const plan = { formatVersion: VERSION, sourceSha: sourceSha(), shardCount: count, ...stamp(collected), assignments: assignFiles(collected, count, timings, sizes) };
  validateAssignments(plan);
  writeJson(output, plan);
  if (process.env.GITHUB_ACTIONS === "true") {
    requireThat(process.env.GITHUB_OUTPUT, "Missing GitHub output file for frontend plan digest");
    appendFileSync(process.env.GITHUB_OUTPUT, planOutputEntry(process.env.RUNNER_OS, hash(readFileSync(output))));
  }
  console.log(`Planned ${collected.length} files and ${collected.reduce((n, file) => n + file.tests.length, 0)} tests in ${count} disjoint shards.`);
}

function runShard(options) {
  requireThat(options.plan && options.index, "Shard requires --plan and --index");
  const planPath = resolve(ROOT, options.plan);
  const planBytes = readFileSync(planPath);
  const plan = JSON.parse(planBytes);
  validateCheckout(plan);
  const index = Number(options.index);
  requireThat(Number.isInteger(index) && index >= 1 && index <= plan.shardCount, "Unknown frontend shard index");
  const output = checkedOutput(options.output ?? `tmp/frontend-ci/shard-${index}`);
  requireThat(!existsSync(output), "Refusing to reuse a frontend shard output directory");
  mkdirSync(output, { recursive: true });
  const blob = join(output, "blob.json");
  const results = join(output, "results.json");
  const code = runVitest(["run", "--config", "vitest.ci.config.ts", "--coverage", "--reporter=blob", "--reporter=json", `--outputFile.blob=${blob}`, `--outputFile.json=${results}`], {
    AIOLM_FRONTEND_PLAN: planPath, AIOLM_FRONTEND_SHARD: String(index), AIOLM_FRONTEND_OUTPUT: output,
  });
  // Preserve failure status even when Vitest managed to write partial reports.
  writeJson(join(output, "record.json"), {
    formatVersion: VERSION, sourceSha: plan.sourceSha, planSha256: hash(planBytes), index, shardCount: plan.shardCount, exitCode: code,
    blobSha256: existsSync(blob) ? hash(readFileSync(blob)) : null,
    resultsSha256: existsSync(results) ? hash(readFileSync(results)) : null,
  });
  if (code !== 0) return code;
  verifyReport(plan, index, json(results));
  return 0;
}

export function verifyRecords(plan, records, planDigest) {
  requireThat(records.length === plan.shardCount, "Missing or extra frontend shard reports");
  const seen = new Set();
  for (const record of records) {
    requireThat(record.formatVersion === VERSION && record.sourceSha === plan.sourceSha && record.planSha256 === planDigest && record.shardCount === plan.shardCount, "Frontend shard belongs to a different source or plan");
    requireThat(Number.isInteger(record.index) && record.index >= 1 && record.index <= plan.shardCount && !seen.has(record.index), "Duplicate or unknown frontend shard");
    seen.add(record.index);
    requireThat(record.exitCode === 0, `Frontend shard ${record.index} failed`);
  }
}

function merge(options) {
  requireThat(options.plan && options.input, "Merge requires --plan and --input");
  const planBytes = readFileSync(resolve(ROOT, options.plan));
  const trustedPlan = Object.hasOwn(options, "expected-plan-sha");
  if (trustedPlan) verifyPlanDigest(planBytes, options["expected-plan-sha"]);
  const plan = JSON.parse(planBytes);
  validateCheckout(plan);
  const output = checkedOutput(options.output ?? "tmp/frontend-ci/merged");
  requireThat(!existsSync(output), "Refusing to reuse a frontend merge output directory");
  mkdirSync(output, { recursive: true });
  const expected = plan.files.map(({ path, tests }) => ({ path, tests }));
  let current;
  if (trustedPlan) {
    // CI passes the producing job's digest separately from downloaded artifacts.
    // That authenticates the once-collected names; source hashes and the cheap
    // fresh file inventory still prevent stale/new/omitted source files.
    checkSourceFiles(plan, join(output, "source-files.json"));
    current = expected;
  } else {
    // Local callers without an independently trusted digest retain the full
    // recollection check; artifact metadata alone never authorizes omissions.
    current = collect(join(output, "collected.json"));
    same(current, expected, "Merged source test inventory");
  }
  const input = resolve(ROOT, options.input);
  const directories = readdirSync(input).map((name) => join(input, name)).filter((path) => lstatSync(path).isDirectory() && !lstatSync(path).isSymbolicLink() && existsSync(join(path, "record.json")));
  const records = directories.map((path) => json(join(path, "record.json")));
  verifyRecords(plan, records, hash(planBytes));
  const blobs = join(output, "blobs");
  mkdirSync(blobs);
  directories.forEach((path, position) => {
    const record = records[position];
    for (const [name, expected] of [["blob.json", record.blobSha256], ["results.json", record.resultsSha256]]) {
      const file = join(path, name);
      requireThat(lstatSync(file).isFile() && !lstatSync(file).isSymbolicLink() && hash(readFileSync(file)) === expected, `Changed frontend report: ${name}`);
    }
    verifyReport(plan, record.index, json(join(path, "results.json")));
    copyFileSync(join(path, "blob.json"), join(blobs, `shard-${record.index}.json`));
  });
  const results = join(output, "results.json");
  const code = runVitest(["--config", "vitest.config.ts", "--merge-reports", blobs, "--coverage", "--reporter=default", "--reporter=json", `--outputFile.json=${results}`]);
  if (code !== 0) return code;
  // Validate actual blob contents after merge as well as the JSON reports.
  // This prevents a stale or different blob from hiding behind valid metadata.
  const report = json(results);
  same(reportInventory(report), current, "Merged blob test inventory");
  const times = Object.fromEntries(report.testResults.map((file) => [testPath(file.name), Math.max(1, file.endTime - file.startTime)]));
  writeJson(join(output, "timings.json"), { formatVersion: VERSION, files: times });
  console.log(`All ${plan.shardCount} frontend shards, exact test inventory, and aggregate coverage passed.`);
  return 0;
}

function parseOptions(args) {
  const options = {};
  while (args.length) {
    const key = args.shift();
    requireThat(/^--(?:plan|index|output|input|shards|timings|expected-plan-sha)$/.test(key ?? "") && args.length > 0, `Unknown or incomplete argument: ${key}`);
    requireThat(!Object.hasOwn(options, key.slice(2)), `Repeated argument: ${key}`);
    options[key.slice(2)] = args.shift();
  }
  return options;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const [command, ...args] = process.argv.slice(2);
    const options = parseOptions(args);
    if (command === "plan") makePlan(options);
    else if (command === "shard") process.exitCode = runShard(options);
    else if (command === "merge") process.exitCode = merge(options);
    else throw new Error("Usage: frontend-ci.mjs plan|shard|merge [options]");
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  }
}
