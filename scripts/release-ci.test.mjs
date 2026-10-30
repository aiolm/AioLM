/* global structuredClone */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { URL } from "node:url";
import test from "node:test";
import { BUILD_INPUT_FILES, assertMainCI, matchingMainCI, parseReleaseArguments, prepareAssets, recordBuildInputs, releaseAssets, validateBuildInput, verifyBuildInputs, verifyDefaultFeatureInputs, waitForMainCI } from "./release-ci.mjs";

const sha = "a".repeat(40);
const success = { id: 1, head_sha: sha, head_branch: "main", event: "push", path: ".github/workflows/ci.yml", status: "completed", conclusion: "success", html_url: "https://github.com/aiolm/AioLM/actions/runs/1" };

const releaseWorkflow = readFileSync(new URL("../.github/workflows/release.yml", import.meta.url), "utf8").replace(/\r\n/g, "\n");
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
function workflowScript(source, name, next) {
  const parts = source.replace(/\r\n/g, "\n").split(`      - name: ${name}\n`);
  assert.equal(parts.length, 2, `Expected one ${name} step`);
  const step = parts[1].split(`      - name: ${next}\n`)[0];
  assert.ok(step.includes("          script: |\n"), `Expected inline ${name} policy`);
  const script = step.split("          script: |\n")[1].split("\n").filter(line => line.trim()).map(line => {
    assert.ok(line.startsWith("            "), `Unexpected ${name} script indentation`);
    return line.slice(12);
  }).join("\n");
  return new AsyncFunction("github", "context", "process", "core", script);
}

function publicationFixture(options = {}, workflow = releaseWorkflow) {
  const state = {
    tag: "v1.2.3", source: sha, ci: success,
    releases: [[]], latest: { tag_name: "v1.2.2", draft: false, prerelease: false },
    tags: {}, errors: {}, ...options,
  };
  const calls = [], mutations = [];
  const read = async (name, args, value, optional = false) => {
    calls.push({ name, args });
    if (state.errors[name]) throw state.errors[name];
    if (optional && value === undefined) throw Object.assign(new Error("Synthetic absent state"), { status: 404 });
    return { data: value };
  };
  const mutation = name => async () => { mutations.push(name); throw new Error("Publication policy must be read-only"); };
  const github = { rest: {
    actions: { getWorkflowRun: args => read("getWorkflowRun", args, state.ci) },
    repos: {
      getReleaseByTag: args => read("getReleaseByTag", args, state.existing, true),
      listReleases: args => read("listReleases", args, Object.hasOwn(state.releases, args.page - 1) ? state.releases[args.page - 1] : []),
      getLatestRelease: args => read("getLatestRelease", args, state.latest, true),
      ...Object.fromEntries(["createRelease", "updateRelease", "deleteRelease", "uploadReleaseAsset", "deleteReleaseAsset"].map(name => [name, mutation(name)])),
    },
    git: {
      getRef: args => read("getRef", args, state.reference, true),
      getTag: args => read("getTag", args, state.tags[args.tag_sha], true),
      ...Object.fromEntries(["createRef", "updateRef", "deleteRef"].map(name => [name, mutation(name)])),
    },
  } };
  const context = { repo: { owner: "synthetic", repo: "synthetic" } };
  const process = { env: { TARGET_SHA: state.source, TAG_NAME: state.tag, CI_RUN_ID: "1" } };
  const core = { info: () => {} };
  const ci = workflowScript(workflow, "Recheck CI after approval", "Recheck staged checksums");
  const release = workflowScript(workflow, "Recheck release and tag state after approval", "Publish GitHub release");
  const runState = () => release(github, context, process, core);
  return { calls, mutations, runState, run: async () => { await ci(github, context, process, core); await runState(); } };
}

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

test("split default-feature checks must match both Mac compiler and source inputs", t => {
  const inputs = inputArtifacts(t);
  const defaults = join(inputs.ciInputs, "..", "defaults");
  const records = inputs.records.filter(record => record.directory === inputs.ciInputs && record.input.runner.os === "macOS");
  for (const record of records) {
    const directory = join(defaults, record.input.runner.arch);
    mkdirSync(directory, { recursive: true });
    writeFileSync(join(directory, "build-inputs.json"), JSON.stringify(record.input));
  }
  assert.deepEqual(verifyDefaultFeatureInputs(inputs.ciInputs, defaults, sha), ["macOS/ARM64", "macOS/X64"]);
  const record = records[0];
  const file = join(defaults, record.input.runner.arch, "build-inputs.json");
  for (const change of [
    input => { input.sourceSha = "d".repeat(40); },
    input => { input.rustcVersion = "rustc 1.99.0 (different compiler)"; },
    input => { input.benchmarkOriginSha256 = "d".repeat(64); },
    input => { input.sourceInputs[0].sha256 = "d".repeat(64); },
    input => { input.runner.os = "Windows"; },
  ]) {
    const altered = structuredClone(record.input);
    change(altered);
    writeFileSync(file, JSON.stringify(altered));
    assert.throws(() => verifyDefaultFeatureInputs(inputs.ciInputs, defaults, sha));
  }
  writeFileSync(file, JSON.stringify(record.input));
  const otherFile = join(defaults, records[1].input.runner.arch, "build-inputs.json");
  writeFileSync(otherFile, JSON.stringify(record.input));
  assert.throws(() => verifyDefaultFeatureInputs(inputs.ciInputs, defaults, sha), /Duplicate/);
  writeFileSync(otherFile, JSON.stringify(records[1].input));
  rmSync(otherFile);
  assert.throws(() => verifyDefaultFeatureInputs(inputs.ciInputs, defaults, sha), /contents/);
  writeFileSync(otherFile, JSON.stringify(records[1].input));
  mkdirSync(join(defaults, "extra"));
  assert.throws(() => verifyDefaultFeatureInputs(inputs.ciInputs, defaults, sha), /exactly 2/);
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
  assert.deepEqual(parseReleaseArguments("verify-default-inputs", ["--sha", sha, "--ci-inputs", "ci", "--default-inputs", "defaults"]),
    { sha, "ci-inputs": "ci", "default-inputs": "defaults" });
  assert.throws(() => parseReleaseArguments("verify-default-inputs", ["--sha", sha, "--ci-inputs", "ci"]), /Missing/);
});

test("publication state is checked after hashes and before the non-overwriting protected publisher", async () => {
  const ci = releaseWorkflow.indexOf("      - name: Recheck CI after approval\n");
  const hashes = releaseWorkflow.indexOf("      - name: Recheck staged checksums\n");
  const state = releaseWorkflow.indexOf("      - name: Recheck release and tag state after approval\n");
  const publish = releaseWorkflow.indexOf("      - name: Publish GitHub release\n");
  assert.ok(ci < hashes && hashes < state && state < publish);
  const job = releaseWorkflow.split("  publish:\n")[1].split("  verify-public:\n")[0];
  assert.match(job, / {4}environment: release-publish\n/);
  assert.ok(!job.includes("actions/checkout@"), "publication does not check out repository source");
  assert.match(job, / {10}overwrite_files: false\n/);
  const guardStep = releaseWorkflow.slice(state, publish);
  const publisher = releaseWorkflow.slice(publish).split("  verify-public:\n")[0];
  assert.doesNotMatch(guardStep, /^ {8}(?:if|continue-on-error):/m, "the state guard must run and its failure must stop publication");
  assert.doesNotMatch(publisher, /^ {8}(?:if|continue-on-error):/m, "the publisher must retain normal success gating");
  const fixture = publicationFixture();
  await fixture.run();
  assert.deepEqual(fixture.calls.map(call => call.name), ["getWorkflowRun", "getReleaseByTag", "listReleases", "getLatestRelease", "getRef"]);
  assert.deepEqual(fixture.mutations, []);
});

test("publication still requires the approved exact-main CI before reading release state", async () => {
  for (const patch of [{ head_sha: "b".repeat(40) }, { event: "pull_request" }, { head_branch: "release" }, { path: ".github/workflows/release.yml" }, { status: "in_progress" }, { conclusion: "failure" }]) {
    const fixture = publicationFixture({ ci: { ...success, ...patch } });
    await assert.rejects(fixture.run(), /exact main CI is no longer successful/);
    assert.deepEqual(fixture.calls.map(call => call.name), ["getWorkflowRun"]);
    assert.deepEqual(fixture.mutations, []);
  }
});

test("an existing draft or published candidate stops without updating releases or assets", async () => {
  for (const draft of [false, true]) {
    const fixture = publicationFixture({ existing: { id: 41, tag_name: "v1.2.3", draft } });
    await assert.rejects(fixture.run(), /release already exists/);
    assert.deepEqual(fixture.mutations, []);
  }
});

test("a matching draft hidden from the direct lookup is found on later listing pages", async () => {
  const page = Array.from({ length: 100 }, (_, index) => ({ tag_name: `v0.0.${index}`, draft: false, prerelease: false }));
  for (const draft of [false, true]) {
    const fixture = publicationFixture({ releases: [page, [{ tag_name: "v1.2.3", draft, prerelease: false }]] });
    await assert.rejects(fixture.run(), /matching draft or published release/);
    assert.deepEqual(fixture.calls.filter(call => call.name === "listReleases").map(call => call.args.page), [1, 2]);
    assert.deepEqual(fixture.mutations, []);
  }
});

test("release absence requires a complete bounded well-formed listing", async () => {
  const page = Array.from({ length: 100 }, (_, index) => ({ tag_name: `v0.0.${index}`, draft: false, prerelease: false }));
  const complete = publicationFixture({ releases: [page, []] });
  await complete.run();
  for (const releases of [Array.from({ length: 10 }, () => page), [null], [[{}]], [[{ tag_name: "v1.0.0", prerelease: false }]], [[...page, { tag_name: "v0.1.0", draft: false, prerelease: false }]]]) {
    const fixture = publicationFixture({ releases });
    await assert.rejects(fixture.run(), /listing limit|Invalid release listing/);
    assert.ok(fixture.calls.filter(call => call.name === "listReleases").length <= 10);
    assert.deepEqual(fixture.mutations, []);
  }
});

test("a same or newer latest version cannot be replaced and versions compare without numeric loss", async () => {
  for (const tag of ["v1.2.3", "v1.2.4", "v1.3.0", "v2.0.0"]) {
    const fixture = publicationFixture({ latest: { tag_name: tag, draft: false, prerelease: false } });
    await assert.rejects(fixture.run(), /same or newer stable release/);
    assert.deepEqual(fixture.mutations, []);
  }
  const large = publicationFixture({ tag: "v9007199254740993.0.0", latest: { tag_name: "v9007199254740992.999.999", draft: false, prerelease: false } });
  await large.run();
  const older = publicationFixture({ tag: "v9007199254740992.0.0", latest: { tag_name: "v9007199254740993.0.0", draft: false, prerelease: false } });
  await assert.rejects(older.run(), /same or newer stable release/);
  assert.deepEqual(large.mutations, []);
  assert.deepEqual(older.mutations, []);
});

test("a newer published stable release blocks promotion even when it is not marked latest", async () => {
  for (const tag of ["v1.3.0", "v2.0.0"]) {
    const fixture = publicationFixture({ releases: [[{ tag_name: tag, draft: false, prerelease: false }]] });
    await assert.rejects(fixture.run(), /same or newer published stable release/);
    assert.ok(!fixture.calls.some(call => call.name === "getLatestRelease"));
    assert.deepEqual(fixture.mutations, []);
  }
  const unknown = publicationFixture({ releases: [[{ tag_name: "stable-tip", draft: false, prerelease: false }]] });
  await assert.rejects(unknown.run(), /Cannot verify an existing published stable release/);
  const pending = publicationFixture({ releases: [[
    { tag_name: "v9.0.0", draft: true, prerelease: false },
    { tag_name: "v9.0.0-rc.1", draft: false, prerelease: true },
  ]] });
  await pending.run();
  assert.deepEqual(unknown.mutations, []);
  assert.deepEqual(pending.mutations, []);
});

test("unknown latest state and invalid approved inputs fail before publication", async () => {
  for (const latest of [null, {}, { tag_name: "latest", draft: false, prerelease: false }, { tag_name: "v1.2.2", draft: true, prerelease: false }, { tag_name: "v1.2.2", draft: false, prerelease: true }]) {
    const fixture = publicationFixture({ latest });
    await assert.rejects(fixture.run(), /Invalid GitHub release state|Cannot verify the latest stable release/);
    assert.deepEqual(fixture.mutations, []);
  }
  for (const patch of [{ tag: "v01.2.3" }, { tag: "1.2.3" }, { tag: "v1.2.3-rc.1" }, { tag: "v1.2.3\n" }, { source: "a".repeat(7) }, { source: "A".repeat(40) }, { source: sha + "\n" }]) {
    const fixture = publicationFixture(patch);
    await assert.rejects(fixture.runState(), /Invalid approved release/);
    assert.deepEqual(fixture.calls, []);
    assert.deepEqual(fixture.mutations, []);
  }
});

test("absent, direct and nested annotated tags are accepted only for the approved commit", async () => {
  const first = "b".repeat(40), second = "c".repeat(40);
  for (const options of [
    { latest: undefined },
    { reference: { ref: "refs/tags/v1.2.3", object: { type: "commit", sha } } },
    { reference: { ref: "refs/tags/v1.2.3", object: { type: "tag", sha: first } }, tags: { [first]: { object: { type: "tag", sha: second } }, [second]: { object: { type: "commit", sha } } } },
  ]) {
    const fixture = publicationFixture(options);
    await fixture.run();
    assert.deepEqual(fixture.mutations, []);
  }
});

test("moved, cyclic, missing, malformed and excessively nested tag objects stop publication", async () => {
  const reference = object => ({ ref: "refs/tags/v1.2.3", object });
  const first = "b".repeat(40);
  const nested = Object.fromEntries(Array.from({ length: 5 }, (_, index) => [(index + 1).toString(16).repeat(40), { object: { type: "tag", sha: (index + 2).toString(16).repeat(40) } }]));
  for (const options of [
    { reference: reference({ type: "commit", sha: first }) },
    { reference: { ref: "refs/tags/other", object: { type: "commit", sha } } },
    { reference: reference({ type: "tree", sha }) },
    { reference: reference({ type: "commit", sha: "bad" }) },
    { reference: reference({ type: "tag", sha: first + "\n" }) },
    { reference: reference({ type: "tag", sha: first }), tags: { [first]: { object: { type: "tag", sha: first } } } },
    { reference: reference({ type: "tag", sha: first }) },
    { reference: reference({ type: "tag", sha: "1".repeat(40) }), tags: nested },
    { reference: null },
  ]) {
    const fixture = publicationFixture(options);
    await assert.rejects(fixture.run(), /approved source|Unexpected release tag|resolve to a commit|Invalid or cyclic|absent state|nesting exceeds|Invalid GitHub release state/);
    assert.deepEqual(fixture.mutations, []);
  }
});

test("GitHub read errors other than allowed absence never become publication permission", async () => {
  for (const [name, status] of [["getReleaseByTag", 403], ["listReleases", 404], ["getLatestRelease", 429], ["getRef", 500], ["getTag", 404]]) {
    const fixture = publicationFixture({
      errors: { [name]: Object.assign(new Error("Synthetic API failure"), { status }) },
      ...(name === "getTag" ? { reference: { ref: "refs/tags/v1.2.3", object: { type: "tag", sha: "b".repeat(40) } } } : {}),
    });
    await assert.rejects(fixture.run(), /Synthetic API failure/);
    assert.deepEqual(fixture.mutations, []);
  }
});

test("the actual publication policy handles LF and Windows CRLF workflow sources identically", async () => {
  for (const workflow of [releaseWorkflow, releaseWorkflow.replace(/\n/g, "\r\n")]) {
    const empty = publicationFixture({}, workflow);
    await empty.run();
    const conflict = publicationFixture({ existing: { tag_name: "v1.2.3", draft: true } }, workflow);
    await assert.rejects(conflict.run(), /release already exists/);
    assert.deepEqual(empty.mutations, []);
    assert.deepEqual(conflict.mutations, []);
  }
});
