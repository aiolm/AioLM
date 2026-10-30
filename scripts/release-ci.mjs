/* global process, fetch, setTimeout, AbortSignal */
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { appendFileSync, lstatSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, resolve, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const INPUT_VERSION = 1;
const TARGETS = ["Linux/X64", "Windows/X64", "macOS/ARM64", "macOS/X64"].sort();
const DEFAULT_TARGETS = TARGETS.filter(target => target.startsWith("macOS/"));
export const BUILD_INPUT_FILES = [
  ".cargo/config.toml", "rust-toolchain.toml", "src-tauri/Cargo.toml", "src-tauri/Cargo.lock",
  "src-tauri/tauri.conf.json", "src-tauri/tauri-package.conf.json", "src-tauri/tauri-cli-build.conf.json",
  "scripts/build-path-remap.mjs", "scripts/build-cli.mjs", "scripts/package-tauri.mjs",
];
const digest = value => createHash("sha256").update(value).digest("hex");
const failUnless = (condition, message) => { if (!condition) throw new Error(message); };
const isSha = value => typeof value === "string" && /^[0-9a-f]{40}$/.test(value);
const isDigest = value => typeof value === "string" && /^[0-9a-f]{64}$/.test(value);
const exactKeys = (value, keys) => value && typeof value === "object" && !Array.isArray(value)
  && JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...keys].sort());

export function validateBuildInput(input, sha) {
  failUnless(exactKeys(input, ["formatVersion", "sourceSha", "runner", "benchmarkOriginSha256", "rustcVersion", "sourceInputs"])
    && input.formatVersion === INPUT_VERSION, "Unknown or incomplete build-input manifest");
  failUnless(isSha(sha) && input.sourceSha === sha, "Build inputs belong to a different source commit");
  failUnless(exactKeys(input.runner, ["os", "arch"]) && TARGETS.includes(`${input.runner.os}/${input.runner.arch}`), "Unsupported build-input target");
  failUnless(isDigest(input.benchmarkOriginSha256), "Invalid build-origin digest");
  failUnless(typeof input.rustcVersion === "string" && /^rustc [^\r\n]{1,200}$/.test(input.rustcVersion), "Invalid Rust compiler identity");
  failUnless(Array.isArray(input.sourceInputs) && input.sourceInputs.length === BUILD_INPUT_FILES.length
    && input.sourceInputs.every((file, index) => exactKeys(file, ["path", "sha256"])
      && file.path === BUILD_INPUT_FILES[index] && isDigest(file.sha256)), "Incomplete or changed pinned build-input list");
  return input;
}

export function recordBuildInputs({ sha, root = ROOT, env = process.env, spawn = spawnSync }) {
  failUnless(isSha(sha), "Invalid release commit");
  const readCommand = (name, args) => {
    const result = spawn(name, args, { cwd: root, env, encoding: "utf8" });
    failUnless(!result.error && result.status === 0, `Cannot record ${name} identity`);
    return result.stdout.trim();
  };
  failUnless(readCommand("git", ["rev-parse", "HEAD"]) === sha, "Checked-out commit does not match build inputs");
  const input = {
    formatVersion: INPUT_VERSION, sourceSha: sha,
    runner: { os: env.RUNNER_OS, arch: env.RUNNER_ARCH },
    // Hash the exact compiled environment value; never persist or print it.
    benchmarkOriginSha256: digest(env.AIOLM_BENCHMARK_API_URL ?? ""),
    rustcVersion: readCommand("rustc", ["--version"]),
    sourceInputs: BUILD_INPUT_FILES.map(path => ({ path, sha256: digest(readFileSync(join(root, path))) })),
  };
  return validateBuildInput(input, sha);
}

function inputDirectory(directory, sha, targets = TARGETS) {
  failUnless(typeof directory === "string" && directory.length > 0, "Build-input directory is required");
  const stat = lstatSync(directory);
  failUnless(stat.isDirectory() && !stat.isSymbolicLink(), "Build-input root must be a regular directory");
  const entries = readdirSync(directory);
  failUnless(entries.length === targets.length, `Expected exactly ${targets.length} build-input artifacts`);
  const inputs = new Map();
  for (const entry of entries) {
    const artifact = join(directory, entry);
    const metadata = lstatSync(artifact);
    failUnless(metadata.isDirectory() && !metadata.isSymbolicLink()
      && JSON.stringify(readdirSync(artifact)) === JSON.stringify(["build-inputs.json"]), "Unexpected build-input artifact contents");
    const file = join(artifact, "build-inputs.json");
    const size = lstatSync(file);
    failUnless(size.isFile() && !size.isSymbolicLink() && size.size > 0 && size.size <= 65536, "Invalid build-input artifact file");
    const input = validateBuildInput(JSON.parse(readFileSync(file, "utf8")), sha);
    const target = `${input.runner.os}/${input.runner.arch}`;
    failUnless(targets.includes(target), "Unexpected build-input target");
    failUnless(!inputs.has(target), "Duplicate build-input target");
    inputs.set(target, input);
  }
  failUnless(JSON.stringify([...inputs.keys()].sort()) === JSON.stringify(targets), "Missing build-input target");
  return inputs;
}

const sharedInputs = input => [input.benchmarkOriginSha256, input.rustcVersion, input.sourceInputs.map(file => [file.path, file.sha256])];

export function verifyDefaultFeatureInputs(ciDirectory, defaultDirectory, sha) {
  const ci = inputDirectory(ciDirectory, sha);
  const defaults = inputDirectory(defaultDirectory, sha, DEFAULT_TARGETS);
  for (const target of DEFAULT_TARGETS) {
    failUnless(JSON.stringify(sharedInputs(ci.get(target))) === JSON.stringify(sharedInputs(defaults.get(target))),
      `Default and all-feature verification inputs differ for ${target}`);
  }
  return DEFAULT_TARGETS;
}

export function verifyBuildInputs(ciDirectory, packageDirectory, sha) {
  const ci = inputDirectory(ciDirectory, sha);
  const packages = inputDirectory(packageDirectory, sha);
  for (const target of TARGETS) {
    // Verification and packaging intentionally use different Cargo profiles and
    // feature sets. Bind their shared source, compiler and mutable origin only.
    failUnless(JSON.stringify(sharedInputs(ci.get(target))) === JSON.stringify(sharedInputs(packages.get(target))), `CI and package build inputs differ for ${target}`);
  }
  failUnless(new Set([...packages.values()].map(input => input.benchmarkOriginSha256)).size === 1,
    "Platform packages used different benchmark origins");
  return TARGETS.map(target => packages.get(target));
}

export function releaseAssets(version) {
  if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error("Invalid release version");
  return [
    `AioLM_${version}_x64-setup.exe`, `AioLM_${version}_x64_en-US.msi`,
    `AioLM_${version}_amd64.deb`, `AioLM_${version}_amd64.AppImage`,
    `AioLM_${version}_aarch64.dmg`, `AioLM_${version}_x64.dmg`,
    "install.ps1", "install.sh", "register-linux-desktop.py",
  ].sort();
}

export function assertMainCI(run, sha) {
  if (run.head_sha !== sha || run.head_branch !== "main" || run.event !== "push"
    || run.path !== ".github/workflows/ci.yml") throw new Error("CI does not verify this main release commit");
  if (run.status !== "completed" || run.conclusion !== "success") {
    throw new Error(`Main CI has not passed: ${run.status}/${run.conclusion}`);
  }
  return run;
}

export function matchingMainCI(runs, sha) {
  return runs.filter(run => run.head_sha === sha && run.head_branch === "main" && run.event === "push"
    && run.path === ".github/workflows/ci.yml").sort((a, b) => b.id - a.id)[0];
}

export function prepareAssets(directory, version, sha, ciRun, { ciInputs, packageInputs } = {}) {
  if (!/^[0-9a-f]{40}$/.test(sha)) throw new Error("Invalid release commit");
  assertMainCI(ciRun, sha);
  const buildInputs = verifyBuildInputs(ciInputs, packageInputs, sha);
  const expected = releaseAssets(version);
  const actual = readdirSync(directory).sort();
  if (JSON.stringify(expected) !== JSON.stringify(actual)) throw new Error("Release assets are missing, duplicated or unexpected");
  const records = expected.map(name => {
    const file = join(directory, name);
    const stat = lstatSync(file);
    if (!stat.isFile() || stat.size <= 0) throw new Error(`Release asset is not a nonempty regular file: ${name}`);
    return { name, bytes: stat.size, sha256: createHash("sha256").update(readFileSync(file)).digest("hex") };
  });
  writeFileSync(join(directory, "checksums.txt"), records.map(asset => `${asset.sha256}  ${asset.name}\n`).join(""), "ascii");
  return { version, sha, ci_run_id: ciRun.id, ci_url: ciRun.html_url, build_inputs: buildInputs, assets: records };
}

export async function waitForMainCI({ sha, getRuns, delay = ms => new Promise(done => setTimeout(done, ms)), timeoutMs = 3_600_000, now = Date.now }) {
  const deadline = now() + timeoutMs;
  while (now() < deadline) {
    const run = matchingMainCI(await getRuns(), sha);
    if (run?.status === "completed") return assertMainCI(run, sha);
    await delay(15_000);
  }
  throw new Error("Timed out waiting for the same main commit's CI");
}

export function parseReleaseArguments(command, args) {
  const required = {
    wait: ["sha", "output"],
    "record-inputs": ["sha", "output"],
    "verify-default-inputs": ["sha", "ci-inputs", "default-inputs"],
    "prepare-assets": ["sha", "directory", "version", "ci-run-id", "ci-inputs", "package-inputs"],
  }[command];
  failUnless(Array.isArray(required), "Expected wait, record-inputs, verify-default-inputs or prepare-assets");
  const options = {};
  for (let index = 0; index < args.length; index += 2) {
    const key = args[index]?.slice(2);
    failUnless(args[index]?.startsWith("--") && required.includes(key) && typeof args[index + 1] === "string"
      && args[index + 1].length > 0 && !args[index + 1].startsWith("--"), "Unknown or incomplete release argument");
    failUnless(!Object.hasOwn(options, key), "Duplicate release argument");
    options[key] = args[index + 1];
  }
  failUnless(required.every(key => Object.hasOwn(options, key)), "Missing required release argument");
  failUnless(isSha(options.sha), "Invalid release source commit");
  if (command === "prepare-assets") {
    releaseAssets(options.version);
    failUnless(/^[1-9][0-9]*$/.test(options["ci-run-id"]), "Invalid CI run ID");
  }
  return options;
}

async function main() {
  const [command, ...args] = process.argv.slice(2);
  const options = parseReleaseArguments(command, args);
  const sha = options.sha;
  const repository = process.env.GITHUB_REPOSITORY;
  if (!/^[0-9a-f]{40}$/.test(sha ?? "") || !/^[\w.-]+\/[\w.-]+$/.test(repository ?? "")) throw new Error("Invalid release source");
  if (command === "record-inputs") {
    const input = recordBuildInputs({ sha });
    mkdirSync(dirname(resolve(options.output)), { recursive: true });
    writeFileSync(options.output, JSON.stringify(input, null, 2) + "\n", { flag: "wx" });
    process.stdout.write(`Recorded build inputs for ${input.runner.os}/${input.runner.arch} at ${sha}\n`);
    return;
  }
  if (command === "verify-default-inputs") {
    const targets = verifyDefaultFeatureInputs(options["ci-inputs"], options["default-inputs"], sha);
    process.stdout.write(`Default and all-feature verification inputs match for ${targets.join(", ")} at ${sha}\n`);
    return;
  }
  const api = async endpoint => {
    const token = process.env.GH_TOKEN;
    if (!token) throw new Error("GitHub read token is required");
    const response = await fetch(`https://api.github.com/repos/${repository}/${endpoint}`, {
      headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28" },
      signal: AbortSignal.timeout(30_000),
    });
    if (!response.ok) throw new Error(`GitHub read failed: HTTP ${response.status}`);
    return response.json();
  };
  if (command === "wait") {
    const run = await waitForMainCI({ sha, getRuns: async () => (await api(`actions/workflows/ci.yml/runs?event=push&branch=main&head_sha=${sha}&per_page=30`)).workflow_runs });
    writeFileSync(options.output, JSON.stringify(run, null, 2) + "\n");
    if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `run_id=${run.id}\nurl=${run.html_url}\n`);
    process.stdout.write(`Main CI passed for ${sha}: ${run.html_url}\n`);
  } else if (command === "prepare-assets") {
    const ciRun = await api(`actions/runs/${options["ci-run-id"]}`);
    const result = prepareAssets(options.directory, options.version, sha, ciRun, {
      ciInputs: options["ci-inputs"], packageInputs: options["package-inputs"],
    });
    const summary = `## Ready for release approval\n\nCommit: \`${sha}\`\n\n[All main CI checks passed](${result.ci_url}). All four platform builds and native installer checks passed.\n\n| Asset | Bytes | SHA-256 |\n|---|---:|---|\n${result.assets.map(asset => `| ${asset.name} | ${asset.bytes} | \`${asset.sha256}\` |`).join("\n")}\n\nThe nine payloads and LF checksums.txt are ready. Publication uses the existing release-publish approval. Assets remain unsigned; macOS is ad-hoc signed and not notarized. Dedicated engine/device checks, SmolVLM F09, overall Linux acceptance and original v0.3.1-to-v0.3.2 update/UI checks remain open.\n`;
    if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, summary);
    process.stdout.write(`Prepared ${result.assets.length} payloads and checksums for ${sha}\n`);
  } else throw new Error("Expected wait, record-inputs or prepare-assets");
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch(error => { process.stderr.write(`${error.message}\n`); process.exitCode = 1; });
}
