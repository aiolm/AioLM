/* global structuredClone */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { BUILD_INPUT_FILES, assertMainCI, matchingMainCI, parseReleaseArguments, prepareAssets, recordBuildInputs, releaseAssets, validateBuildInput, verifyBuildInputs, waitForMainCI } from "./release-ci.mjs";

const sha = "a".repeat(40);
const success = { id: 1, head_sha: sha, head_branch: "main", event: "push", path: ".github/workflows/ci.yml", status: "completed", conclusion: "success", html_url: "https://github.com/aiolm/AioLM/actions/runs/1" };

function inputArtifacts(t) {
  const root = mkdtempSync(join(tmpdir(), "aiolm-build-inputs-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const directories = { ciInputs: join(root, "ci"), packageInputs: join(root, "package") };
  const records = [];
  for (const [os, arch] of [["Windows", "X64"], ["Linux", "X64"], ["macOS", "ARM64"], ["macOS", "X64"]]) {
    const input = {
      formatVersion: 1, sourceSha: sha, runner: { os, arch }, benchmarkOriginSha256: "b".repeat(64),
      rustcVersion: "rustc 1.98.0 (synthetic 2026-08-18)",
      sourceInputs: BUILD_INPUT_FILES.map(path => ({ path, sha256: "c".repeat(64) })),
    };
    for (const directory of Object.values(directories)) {
      const artifact = join(directory, `${os}-${arch}`);
      mkdirSync(artifact, { recursive: true });
      const file = join(artifact, "build-inputs.json");
      writeFileSync(file, JSON.stringify(input));
      records.push({ directory, file, input: structuredClone(input) });
    }
  }
  return { ...directories, records };
}

test("publication accepts only successful push CI for its exact main commit", () => {
  assert.equal(assertMainCI(success, sha), success);
  for (const patch of [{ head_sha: "b".repeat(40) }, { event: "pull_request" }, { head_branch: "release" }, { path: ".github/workflows/release.yml" }, { status: "in_progress" }, { conclusion: "failure" }, { conclusion: "cancelled" }]) {
    assert.throws(() => assertMainCI({ ...success, ...patch }, sha));
  }
  assert.equal(matchingMainCI([{ ...success, id: 5, event: "pull_request" }, success], sha), success);
});

test("waiting observes completion without launching another CI run", async () => {
  let reads = 0;
  const run = await waitForMainCI({ sha, getRuns: async () => (++reads === 1 ? [{ ...success, status: "in_progress", conclusion: null }] : [success]), delay: async () => {} });
  assert.equal(run, success);
  assert.equal(reads, 2);
  await assert.rejects(waitForMainCI({ sha, getRuns: async () => [{ ...success, conclusion: "failure" }] }), /has not passed/);
  let clock = 0;
  await assert.rejects(waitForMainCI({ sha, getRuns: async () => [], now: () => clock, timeoutMs: 10, delay: async () => { clock = 20; } }), /Timed out/);
});

test("approval artifacts cover all payloads exactly once with portable checksums", t => {
  const directory = mkdtempSync(join(tmpdir(), "aiolm-approval-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const names = releaseAssets("0.3.3");
  for (const name of names) writeFileSync(join(directory, name), `synthetic ${name}`);
  const inputs = inputArtifacts(t);
  const report = prepareAssets(directory, "0.3.3", sha, success, inputs);
  assert.equal(report.assets.length, 9);
  assert.equal(report.build_inputs.length, 4);
  const checksum = readFileSync(join(directory, "checksums.txt"), "ascii");
  assert.equal(checksum.split("\n").filter(Boolean).length, 9);
  assert.ok(!checksum.includes("\r"));
  assert.ok(checksum.endsWith("\n"));
  assert.throws(() => prepareAssets(directory, "0.3.3", sha, success, inputs), /unexpected/);
});

test("approval preparation rejects extra, empty and linked assets", t => {
  for (const bad of ["extra", "empty", "link"]) {
    const directory = mkdtempSync(join(tmpdir(), "aiolm-approval-bad-"));
    t.after(() => rmSync(directory, { recursive: true, force: true }));
    const names = releaseAssets("0.3.3");
    for (const name of names) writeFileSync(join(directory, name), "synthetic");
    if (bad === "extra") writeFileSync(join(directory, "unexpected.txt"), "extra");
    if (bad === "empty") writeFileSync(join(directory, names[0]), "");
    if (bad === "link") { rmSync(join(directory, names[0])); symlinkSync(join(directory, names[1]), join(directory, names[0])); }
    assert.throws(() => prepareAssets(directory, "0.3.3", sha, success, inputArtifacts(t)));
  }
});

test("all four package targets must bind the same source, actual origin and pinned compiler inputs to CI", t => {
  const inputs = inputArtifacts(t);
  assert.equal(verifyBuildInputs(inputs.ciInputs, inputs.packageInputs, sha).length, 4);
  const record = inputs.records.find(record => record.directory === inputs.packageInputs);
  for (const change of [
    input => { input.benchmarkOriginSha256 = "d".repeat(64); },
    input => { input.rustcVersion = "rustc 1.99.0 (different compiler)"; },
    input => { input.sourceInputs[0].sha256 = "d".repeat(64); },
    input => { input.sourceSha = "d".repeat(40); },
    input => { input.formatVersion = 2; },
  ]) {
    const altered = structuredClone(record.input);
    change(altered);
    writeFileSync(record.file, JSON.stringify(altered));
    assert.throws(() => verifyBuildInputs(inputs.ciInputs, inputs.packageInputs, sha));
  }
  writeFileSync(record.file, JSON.stringify(record.input));
  const missing = inputs.records.find(item => item.directory === inputs.ciInputs);
  rmSync(missing.file);
  assert.throws(() => verifyBuildInputs(inputs.ciInputs, inputs.packageInputs, sha), /contents/);
  writeFileSync(missing.file, JSON.stringify(missing.input));
  const duplicate = inputs.records.find(item => item.directory === inputs.ciInputs && item.file !== missing.file);
  writeFileSync(duplicate.file, JSON.stringify(missing.input));
  assert.throws(() => verifyBuildInputs(inputs.ciInputs, inputs.packageInputs, sha), /Duplicate/);
});

test("recording observes checkout, compiler and raw origin without storing the origin", t => {
  const root = mkdtempSync(join(tmpdir(), "aiolm-record-inputs-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  for (const file of BUILD_INPUT_FILES) {
    const path = join(root, file);
    mkdirSync(join(path, ".."), { recursive: true });
    writeFileSync(path, `synthetic source for ${file}\n`);
  }
  const secretOrigin = "https://synthetic-user:synthetic-secret@example.invalid";
  const env = { RUNNER_OS: "Linux", RUNNER_ARCH: "X64", AIOLM_BENCHMARK_API_URL: secretOrigin };
  const calls = [];
  const spawn = (name, args) => {
    calls.push([name, args]);
    return { status: 0, stdout: name === "git" ? sha + "\n" : "rustc 1.98.0 (synthetic 2026-08-18)\n" };
  };
  const input = recordBuildInputs({ sha, root, env, spawn });
  assert.deepEqual(calls, [["git", ["rev-parse", "HEAD"]], ["rustc", ["--version"]]]);
  assert.ok(!JSON.stringify(input).includes("synthetic-secret"));
  assert.ok(!JSON.stringify(input).includes("example.invalid"));
  assert.equal(validateBuildInput(input, sha), input);
  assert.throws(() => recordBuildInputs({ sha: "d".repeat(40), root, env, spawn }), /Checked-out/);
  assert.throws(() => validateBuildInput({ ...input, sourceInputs: input.sourceInputs.slice(1) }, sha), /pinned/);
});

test("release commands reject missing, duplicate, unknown and malformed arguments", () => {
  assert.deepEqual(parseReleaseArguments("record-inputs", ["--sha", sha, "--output", "tmp/build-inputs.json"]), { sha, output: "tmp/build-inputs.json" });
  for (const args of [[], ["--sha", sha], ["--sha", sha, "--output"], ["--sha", sha, "--output", "tmp/a", "--unknown", "bad"], ["--sha", sha, "--output", "tmp/a", "--sha", sha]]) {
    assert.throws(() => parseReleaseArguments("record-inputs", args));
  }
  const complete = ["--sha", sha, "--directory", "assets", "--version", "0.3.3", "--ci-run-id", "12", "--ci-inputs", "ci", "--package-inputs", "packages"];
  assert.equal(parseReleaseArguments("prepare-assets", complete)["ci-run-id"], "12");
  const badRun = [...complete]; badRun[7] = "../bad";
  assert.throws(() => parseReleaseArguments("prepare-assets", badRun), /CI run/);
  assert.throws(() => parseReleaseArguments("prepare-assets", complete.slice(0, -2)), /Missing/);
});
