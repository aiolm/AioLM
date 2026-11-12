// Guard the relationships that make the verification/package dependency caches
// reusable. This reads only the workflows' indented maps and step lists; it is
// deliberately not a general YAML parser. Unsupported cache/env syntax fails
// instead of silently omitting an input. Runner-inherited values remain the
// pinned cache action's responsibility, including its actual compiler hash.
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const RUST_ACTION = "dtolnay/rust-toolchain@4360b52568e2003a75bf9bc1d59f33a8e3fc893c";
const CACHE_ACTION = "Swatinem/rust-cache@d1527c8f67ef9af357290475d4af4b0fab8f12e0";
const CACHE_PREFIXES = ["CARGO", "CC", "CFLAGS", "CXX", "CMAKE", "RUST"];
const EXTRA_PREFIXES = "AIOLM_BENCHMARK_API_URL CARGO_PROFILE_DEV_DEBUG CARGO_PROFILE_TEST_DEBUG CARGO_INCREMENTAL CFLAGS CXXFLAGS";
const MAIN_ONLY = "${{ github.ref == 'refs/heads/main' }}";
const MAIN_PUSH_ONLY = "${{ github.ref == 'refs/heads/main' && github.event_name != 'pull_request' }}";
/**
 * @typedef {{ value: string, lines: string[] }} Entry
 * @typedef {Map<string, Entry>} Step
 * @typedef {{ step: Step, script: string }} ScriptStep
 * @typedef {{ ci: string, release: string, packages: string, rustManifest: string, cargoManifest: string, featureUses: string }} WorkflowSources
 */
/** @type {(value: unknown, message: string) => asserts value} */
const requireThat = (value, message) => { if (!value) throw new Error(message); };

/** @param {string[]} lines @param {number} indent @param {string} context */
function mapAt(lines, indent, context) {
  const result = new Map(/** @type {[string, Entry][]} */ ([]));
  /** @type {Entry | undefined} */
  let entry;
  for (const line of lines) {
    if (!line.trim() || line.trimStart().startsWith("#")) continue;
    requireThat(!line.includes("\t"), `Unsupported tab in ${context}`);
    const spaces = line.length - line.trimStart().length;
    requireThat(spaces >= indent, `Unsupported indentation in ${context}`);
    if (spaces > indent) {
      requireThat(entry, `Unexpected nested content in ${context}`);
      entry.lines.push(line);
      continue;
    }
    const match = /** @type {([string, string, string?] & RegExpMatchArray) | null} */ (line.slice(indent).match(/^([A-Za-z0-9_.-]+):(?:\s+(.*))?$/));
    requireThat(match && !result.has(match[1]), `Unsupported or duplicate map key in ${context}`);
    entry = { value: match[2] ?? "", lines: [] };
    result.set(match[1], entry);
  }
  return result;
}

/** @param {Entry | undefined} entry @param {string} context @returns {string} */
function scalar(entry, context) {
  requireThat(entry && entry.lines.length === 0, `Expected scalar ${context}`);
  const raw = entry.value;
  if (raw.startsWith('"')) {
    const match = /** @type {([string, string] & RegExpMatchArray) | null} */ (raw.match(/^("(?:[^"\\]|\\.)*")\s*(?:#.*)?$/));
    requireThat(match, `Unsupported quoted scalar in ${context}`);
    const parsed = /** @type {unknown} */ (JSON.parse(match[1]));
    requireThat(typeof parsed === "string", `Expected string ${context}`);
    return parsed;
  }
  if (raw.startsWith("'")) {
    const match = /** @type {([string, string] & RegExpMatchArray) | null} */ (raw.match(/^'((?:[^']|'')*)'\s*(?:#.*)?$/));
    requireThat(match, `Unsupported quoted scalar in ${context}`);
    return match[1].replaceAll("''", "'");
  }
  const value = raw.replace(/\s+#.*$/, "").trimEnd();
  requireThat(value && !["&", "*", "!", "|", ">", "[", "{"].some(prefix => value.startsWith(prefix)), `Unsupported scalar in ${context}`);
  return value;
}

/** @param {Entry | undefined} entry @param {number} indent @param {string} context @returns {Step} */
function mapping(entry, indent, context) {
  if (!entry) return new Map();
  requireThat(entry.value === "", `Expected indented map ${context}`);
  return mapAt(entry.lines, indent, context);
}

/** @param {Entry | undefined} entry @param {number} indent @param {string} context */
function envMap(entry, indent, context) {
  return Object.fromEntries([...mapping(entry, indent, context)].map(([key, value]) => [key, scalar(value, `${context}.${key}`)]));
}

/** @param {Entry | undefined} entry @param {string} context */
function stepsFrom(entry, context) {
  requireThat(entry && entry.value === "", `Expected step list in ${context}`);
  /** @type {string[][]} */
  const blocks = [];
  for (const line of entry.lines) {
    if (!line.trim() || line.trimStart().startsWith("#")) continue;
    const start = line.match(/^ {6}- (.*)$/);
    if (start) blocks.push([`        ${start[1]}`]);
    else {
      requireThat(blocks.length > 0 && /^ {8}/.test(line), `Unsupported step syntax in ${context}`);
      /** @type {string[]} */ (blocks.at(-1)).push(line);
    }
  }
  return blocks.map((lines, index) => mapAt(lines, 8, `${context}.steps[${index}]`));
}

/** @param {string} source */
function frontendBeforeNativeCompile(source) {
  const workflow = mapAt(source.replace(/\r\n/g, "\n").split("\n"), 0, "workflow");
  const jobs = mapping(workflow.get("jobs"), 2, "jobs");
  for (const name of ["rust", "rust-portability", "macos-default"]) {
    const job = mapping(jobs.get(name), 4, `jobs.${name}`);
    const steps = stepsFrom(job.get("steps"), name);
    const scripts = steps.map(step => {
      const run = step.get("run");
      return !run ? "" : run.lines.length ? [run.value, ...run.lines].join("\n") : scalar(run, `${name}.run`);
    });
    const builds = scripts.filter(script => /^\s*npm\s+run\s+build(?:\s|$)/m.test(script));
    requireThat(builds.length === 0, `Native verification must reuse frontend inputs, not rebuild them in ${name}`);
    if (name === "macos-default") continue;
    requireThat(scalar(job.get("needs"), `${name}.needs`) === "frontend-checks",
      `Native verification must depend on frontend-checks in ${name}`);
    const downloads = steps.flatMap((step, index) => step.get("uses")?.value.startsWith("actions/download-artifact@")
      && mapping(step.get("with"), 10, `${name}.download`).get("name")?.value === "frontend-dist" ? [index] : []);
    const firstCompile = scripts.findIndex(script => /^\s*cargo\s+(?:\+\S+\s+)?(?:clippy|test|build)(?:\s|$)/m.test(script));
    const downloadIndex = /** @type {number} */ (downloads[0]);
    requireThat(downloads.length === 1 && firstCompile >= 0 && downloadIndex < firstCompile,
      `Frontend artifact must be downloaded once before the first Cargo compile in ${name}`);
    const download = /** @type {Step} */ (steps[downloadIndex]);
    requireThat(!["if", "continue-on-error"].some(key => download.has(key))
      && scalar(mapping(download.get("with"), 10, `${name}.download`).get("path"), "frontend path") === "dist",
      `Frontend artifact download must be unconditional and required in ${name}`);
  }
}

// Windows and Linux build their binaries from the all-feature units their tests
// already compiled. That is the default-feature code only while every
// non-default feature stays macOS-only, so check the manifest and each use.
const REVIEWED_FEATURES = JSON.stringify(['default=["test-fixtures"]', 'macos-ui-smoke=["dep:tauri-plugin-wdio-webdriver"]', 'test-fixtures=[]']);
const MACOS_DEPENDENCIES = `target.'cfg(target_os = "macos")'.dependencies`;
const FEATURE_USE = /macos[-_]ui[-_]smoke/i;
// Exact commands: any other flag, including -F/-Ffoo, a profile or a target,
// changes which units are compiled and needs review.
const ALL_FEATURE_TESTS = "cargo test --locked --manifest-path src-tauri/Cargo.toml --all-targets --all-features --timings";
const ALL_FEATURE_BINS = "cargo build --locked --manifest-path src-tauri/Cargo.toml --bins --all-features --timings";
const DEFAULT_BINS = "cargo build --locked --manifest-path src-tauri/Cargo.toml --bins --timings";
const NATIVE_CLI = /^\s*npm\s+run\s+test:native-cli(?:\s|$)/m;
const INPUTS_BEFORE_CPU = /scripts\/native-build-inputs\.mjs\s[^\n]*--phase\s+before(?:\s|$)/;

/** @param {string} ci @param {string} cargoManifest @param {string} featureUses */
function nativeFeatureReuse(ci, cargoManifest, featureUses) {
  const workflow = mapAt(ci.replace(/\r\n/g, "\n").split("\n"), 0, "workflow");
  const jobs = mapping(workflow.get("jobs"), 2, "jobs");
  /** @param {string} name */
  const jobSteps = name => stepsFrom(mapping(jobs.get(name), 4, `jobs.${name}`).get("steps"), name).map(step => {
    const run = step.get("run");
    return { step, script: !run ? "" : run.lines.length ? [run.value, ...run.lines].join("\n") : scalar(run, `${name}.run`) };
  });
  /** @param {ScriptStep[]} steps @param {RegExp} pattern */
  const find = (steps, pattern) => steps.flatMap(({ script }, index) => pattern.test(script) ? [index] : []);
  /** @param {ScriptStep} build */
  const condition = build => build.step.has("if") ? scalar(build.step.get("if"), "binary build if") : "";
  /** @param {ScriptStep[]} steps */
  const binaryBuilds = steps => find(steps, /^\s*cargo\s+build\s[^\n]*--bins(?:\s|$)/m);
  // Each binary build is required (no continue-on-error) and inherits exactly
  // the job's compiler environment, and nothing but the OS-exclusive binary
  // builds may compile between it and the steps that run its binaries.
  /** @param {string} name @param {ScriptStep[]} steps @param {number} build @param {string[]} keys @param {RegExp[]} consumers */
  const checkBinaries = (name, steps, build, keys, consumers) => {
    const builds = binaryBuilds(steps);
    requireThat([.../** @type {ScriptStep} */ (steps[build]).step.keys()].every(key => keys.includes(key)), `Binary build must be required and keep the job compiler inputs in ${name}`);
    for (const pattern of consumers) {
      const uses = find(steps, pattern);
      const use = /** @type {number} */ (uses[0]);
      requireThat(uses.length === 1 && build < use && steps.slice(build + 1, use)
        .every(({ script }, offset) => builds.includes(build + 1 + offset) || !/^\s*cargo\s/m.test(script)),
      `Binaries must be built before their consumers in ${name}`);
    }
  };
  // Reuse needs the one all-target, all-feature test compile to run first,
  // unconditionally, with only the runtime fixture directory added to its
  // environment and no later step able to change compiler inputs.
  /** @param {string} name @param {ScriptStep[]} steps @param {number} build */
  const checkReuse = (name, steps, build) => {
    const tests = find(steps, /^\s*cargo\s+test\s[^\n]*--all-targets(?:\s|$)/m);
    const testIndex = /** @type {number} */ (tests[0]);
    requireThat(tests.length === 1 && /** @type {ScriptStep} */ (steps[testIndex]).script === ALL_FEATURE_TESTS && testIndex < build,
      `Binaries must follow the required all-feature test build in ${name}`);
    const test = /** @type {ScriptStep} */ (steps[testIndex]).step;
    requireThat([...test.keys()].every(key => ["name", "env", "run"].includes(key))
      && [...mapping(test.get("env"), 10, `${name}.tests.env`).keys()].every(key => key === "AIOLM_CLI_FIXTURE_EVIDENCE"),
    `All-feature tests must stay unconditional, required and compile-identical in ${name}`);
    requireThat(steps.slice(testIndex + 1, build).every(({ step, script }) => !step.has("uses") && !/GITHUB_(?:ENV|PATH)/.test(script)),
      `Only reviewed run steps may separate the all-feature tests and binaries in ${name}`);
  };

  const rust = jobSteps("rust");
  const windows = binaryBuilds(rust);
  const windowsBuild = /** @type {number} */ (windows[0]);
  requireThat(windows.length === 1 && /** @type {ScriptStep} */ (rust[windowsBuild]).script === ALL_FEATURE_BINS, "Windows binaries must reuse the all-feature test build");
  checkReuse("rust", rust, windowsBuild);
  checkBinaries("rust", rust, windowsBuild, ["name", "run"], [NATIVE_CLI]);
  const unix = jobSteps("rust-portability");
  const unixBuilds = binaryBuilds(unix);
  const linux = unixBuilds.filter(index => condition(/** @type {ScriptStep} */ (unix[index])) === "runner.os == 'Linux'");
  const mac = unixBuilds.filter(index => condition(/** @type {ScriptStep} */ (unix[index])) === "runner.os == 'macOS'");
  requireThat(unixBuilds.length === 2 && linux.length === 1 && mac.length === 1, "Expected one Linux and one macOS binary build");
  const linuxBuild = /** @type {number} */ (linux[0]);
  const macBuild = /** @type {number} */ (mac[0]);
  requireThat(/** @type {ScriptStep} */ (unix[linuxBuild]).script === ALL_FEATURE_BINS, "Linux binaries must reuse the all-feature test build");
  requireThat(/** @type {ScriptStep} */ (unix[macBuild]).script === DEFAULT_BINS, "macOS binaries must keep the default features");
  checkReuse("rust-portability", unix, linuxBuild);
  checkBinaries("rust-portability", unix, linuxBuild, ["name", "if", "run"], [NATIVE_CLI]);
  checkBinaries("rust-portability", unix, macBuild, ["name", "if", "run"], [NATIVE_CLI, INPUTS_BEFORE_CPU]);

  let table = "";
  const features = [];
  const optional = [];
  const named = [];
  for (const line of cargoManifest.split(/\r?\n/)) {
    // A target's required-features or a cfg(feature) table would change the
    // all-feature target set, so only the feature's own entry may name it.
    if (FEATURE_USE.test(line) && !line.trimStart().startsWith("#")) named.push(table);
    const header = /** @type {([string, string] & RegExpMatchArray) | null} */ (line.match(/^\s*\[\[?([^\]]+)\]\]?\s*(?:#.*)?$/));
    if (header) { table = header[1].trim(); continue; }
    if (table === "features" && line.trim() && !line.trimStart().startsWith("#")) features.push(line.replace(/\s+#.*$/, "").replace(/\s+/g, ""));
    // Any other optional dependency would add an implicit Cargo feature.
    if (/\boptional\s*=\s*true\b/.test(line)) optional.push(`${table}:${line.match(/^\s*([A-Za-z0-9_-]+)\s*=/)?.[1]}`);
  }
  requireThat(JSON.stringify(features.sort()) === REVIEWED_FEATURES, "Cargo features changed; review the all-feature build reuse");
  requireThat(JSON.stringify(optional) === JSON.stringify([`${MACOS_DEPENDENCIES}:tauri-plugin-wdio-webdriver`]),
    "The WebDriver feature dependency must stay the only optional, macOS-only dependency");
  requireThat(JSON.stringify(named) === JSON.stringify(["features"]), "Only the reviewed feature entry may name macos-ui-smoke in Cargo.toml");
  // A use counts only when its whole line is a cfg(all(...)) attribute with
  // flat predicates that include the macOS target. Nested any/not, code,
  // comments and split attributes are rejected rather than interpreted.
  for (const use of featureUses.split(/\r?\n/).filter(line => FEATURE_USE.test(line))) {
    const gate = /** @type {([string, string] & RegExpMatchArray) | null} */ (use.match(/^[^:]+:\d+:\s*#\[cfg\(all\(([^()]*)\)\)\]\s*$/))?.[1].split(",").map(term => term.replace(/\s+/g, "")).filter(Boolean) ?? [];
    requireThat(gate.includes('target_os="macos"') && gate.includes('feature="macos-ui-smoke"') && gate.every(term => /^\w+(?:="[\w-]*")?$/.test(term)),
      `macos-ui-smoke must stay gated to macOS: ${use.trim()}`);
  }
}

/** @param {string} source @param {string} jobName @param {string} purpose @param {boolean} helper @param {string} pin */
function cacheRecipe(source, jobName, purpose, helper, pin) {
  const workflow = mapAt(source.replace(/\r\n/g, "\n").split("\n"), 0, "workflow");
  const jobs = mapping(workflow.get("jobs"), 2, "jobs");
  const job = mapping(jobs.get(jobName), 4, `jobs.${jobName}`);
  requireThat(job.size > 0, `Missing guarded job ${jobName}`);
  const steps = stepsFrom(job.get("steps"), jobName);
  const uses = steps.map(step => step.has("uses") ? scalar(step.get("uses"), "uses") : "");
  const caches = uses.flatMap((value, index) => value.startsWith("Swatinem/rust-cache@") ? [index] : []);
  const installers = uses.flatMap((value, index) => value.startsWith("dtolnay/rust-toolchain@") ? [index] : []);
  requireThat(caches.length === 1 && installers.length === 1, `Expected one cache and Rust install in ${jobName}`);
  const cacheIndex = /** @type {number} */ (caches[0]);
  const installIndex = /** @type {number} */ (installers[0]);
  const cacheStep = /** @type {Step} */ (steps[cacheIndex]);
  const installStep = /** @type {Step} */ (steps[installIndex]);
  requireThat(uses[cacheIndex] === CACHE_ACTION && uses[installIndex] === RUST_ACTION, `Unreviewed Rust/cache action in ${jobName}`);
  requireThat(!["if", "env", "continue-on-error"].some(key => installStep.has(key)), `Pinned Rust installer must be unconditional and required in ${jobName}`);
  const guards = steps.flatMap((step, index) => step.get("run")?.value === "node scripts/ci-rust-toolchain.mjs" ? [index] : []);
  const guardIndex = /** @type {number} */ (guards[0]);
  requireThat(guards.length === 1 && installIndex < guardIndex && guardIndex < cacheIndex,
    `Pinned hosted toolchain guard must run between install and cache in ${jobName}`);
  requireThat(!["if", "env", "continue-on-error"].some(key => /** @type {Step} */ (steps[guardIndex]).has(key)), `Toolchain guard must be unconditional and required in ${jobName}`);
  for (let index = 0; index < steps.length; index += 1) {
    if (/** @type {Step} */ (steps[index]).get("run")?.value.includes("scripts/release-ci.mjs record-inputs")) {
      requireThat(guardIndex < index && index < cacheIndex, `Compiler input recording must follow isolation and precede cache in ${jobName}`);
    }
  }
  const install = mapping(installStep.get("with"), 10, "Rust inputs");
  requireThat(scalar(install.get("toolchain"), "toolchain") === pin, `Rust action and manifest pin differ in ${jobName}`);
  const env = {
    ...envMap(workflow.get("env"), 2, "workflow.env"),
    ...envMap(job.get("env"), 6, `${jobName}.env`),
  };
  // The reviewed dtolnay action writes these only if the variable is unset.
  // In particular Windows release builds inherit CARGO_INCREMENTAL=0 even
  // though their job does not declare it explicitly.
  env.CARGO_INCREMENTAL ??= "0";
  env.CARGO_TERM_COLOR ??= "always";
  for (let index = 0; index <= cacheIndex; index += 1) {
    const run = /** @type {Step} */ (steps[index]).get("run");
    const script = run && [run.value, ...run.lines].join("\n");
    requireThat(!script || !script.includes("GITHUB_ENV"), `Persistent environment write before cache requires review in ${jobName}`);
  }
  Object.assign(env, envMap(cacheStep.get("env"), 10, `${jobName}.cache.env`));
  const prefixes = [...CACHE_PREFIXES, ...EXTRA_PREFIXES.split(" ")];
  const effective = Object.fromEntries(Object.entries(env).filter(([key, value]) => value && prefixes.some(prefix => key.startsWith(prefix))).sort(([a], [b]) => a.localeCompare(b)));
  for (const [key, value] of Object.entries(effective)) {
    requireThat(!value.includes("${{") || key === "AIOLM_BENCHMARK_API_URL" && value === "${{ vars.AIOLM_BENCHMARK_API_URL }}",
      `Unsupported cache environment expression ${jobName}.${key}`);
  }
  const inputs = Object.fromEntries([...mapping(cacheStep.get("with"), 10, `${jobName}.cache.with`)]
    .map(([key, value]) => [key, scalar(value, `${jobName}.cache.${key}`)]));
  const expected = {
    workspaces: "src-tauri -> ../.codex-target", "shared-key": `${purpose}-\${{ runner.os }}-\${{ runner.arch }}`,
    "env-vars": EXTRA_PREFIXES, "cache-bin": "false",
  };
  requireThat(JSON.stringify(Object.keys(inputs).sort()) === JSON.stringify([...Object.keys(expected), "save-if"].sort()), `Changed cache recipe fields in ${jobName}`);
  for (const [key, value] of Object.entries(expected)) requireThat(inputs[key] === value, `Changed cache recipe ${jobName}.${key}`);
  requireThat(helper ? inputs["save-if"] === "false" : [MAIN_ONLY, MAIN_PUSH_ONLY].includes(inputs["save-if"] ?? ""),
    `Cache writes must stay main-only and helpers restore-only in ${jobName}`);
  return { purpose, env: effective };
}

/** @param {WorkflowSources} sources */
export function verifyCiWorkflowContracts({ ci, release, packages, rustManifest, cargoManifest, featureUses }) {
  const match = /** @type {([string, string] & RegExpMatchArray) | null} */ (rustManifest.match(/^channel\s*=\s*"([0-9]+\.[0-9]+\.[0-9]+)"\s*$/m));
  requireThat(match, "Missing exact Rust manifest pin");
  const pin = match[1];
  const verification = ["rust", "rust-portability", "macos-default"].map(job => cacheRecipe(ci, job, "verify", job === "macos-default", pin));
  const packaging = [cacheRecipe(packages, "package", "package", false, pin),
    ...["build", "build-linux", "build-macos"].map(job => cacheRecipe(release, job, "package", false, pin))];
  // Adding another cache consumer must also add it to the reviewed group;
  // otherwise the new job could silently escape the relationships above.
  const cacheMentions = [ci, release, packages].reduce((count, source) => count
    + [...source.matchAll(/^\s+(?:- )?uses:\s+["']?Swatinem\/rust-cache@/gm)].length, 0);
  requireThat(cacheMentions === verification.length + packaging.length, "Unreviewed additional Rust cache consumer");
  for (const group of [verification, packaging]) {
    const reference = JSON.stringify(group[0]);
    requireThat(group.every(recipe => JSON.stringify(recipe) === reference), `Cache environment differs between ${/** @type {{ purpose: string }} */ (group[0]).purpose} jobs`);
  }
  // Keep frontend inputs stable while build-time context generation is reused.
  frontendBeforeNativeCompile(ci);
  nativeFeatureReuse(ci, cargoManifest, featureUses);
  return { guardedJobs: verification.length + packaging.length, rustPin: pin };
}

/** @returns {WorkflowSources} */
export function readCiWorkflowSources(root = ROOT) {
  /** @param {string} path */
  const read = path => readFileSync(join(root, path), "utf8");
  // Only the lines naming the feature are kept, labelled with their file. Every
  // package Rust file outside the build output is read, so tests, examples and
  // benches are covered along with the build script, library and binaries.
  const rust = readdirSync(join(root, "src-tauri"), { withFileTypes: true }).filter(entry => entry.name !== "target")
    .flatMap(entry => entry.isDirectory()
      ? readdirSync(join(root, "src-tauri", entry.name), { recursive: true }).map(path => `${entry.name}/${String(path).replaceAll("\\", "/")}`)
      : [entry.name])
    .filter(path => path.endsWith(".rs")).map(path => `src-tauri/${path}`).sort();
  const featureUses = rust.flatMap(path => read(path).split(/\r?\n/).flatMap((line, index) => FEATURE_USE.test(line) ? [`${path}:${index + 1}: ${line}`] : []));
  return {
    ci: read(".github/workflows/ci.yml"), release: read(".github/workflows/release.yml"),
    packages: read(".github/workflows/desktop-packages.yml"), rustManifest: read("rust-toolchain.toml"),
    cargoManifest: read("src-tauri/Cargo.toml"), featureUses: featureUses.join("\n"),
  };
}
