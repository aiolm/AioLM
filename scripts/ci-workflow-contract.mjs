// Guard the relationships that make the verification/package dependency caches
// reusable. This reads only the workflows' indented maps and step lists; it is
// deliberately not a general YAML parser. Unsupported cache/env syntax fails
// instead of silently omitting an input. Runner-inherited values remain the
// pinned cache action's responsibility, including its actual compiler hash.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const RUST_ACTION = "dtolnay/rust-toolchain@4360b52568e2003a75bf9bc1d59f33a8e3fc893c";
const CACHE_ACTION = "Swatinem/rust-cache@d1527c8f67ef9af357290475d4af4b0fab8f12e0";
const CACHE_PREFIXES = ["CARGO", "CC", "CFLAGS", "CXX", "CMAKE", "RUST"];
const EXTRA_PREFIXES = "AIOLM_BENCHMARK_API_URL CARGO_PROFILE_DEV_DEBUG CARGO_PROFILE_TEST_DEBUG CARGO_INCREMENTAL CFLAGS CXXFLAGS";
const MAIN_ONLY = "${{ github.ref == 'refs/heads/main' }}";
const MAIN_PUSH_ONLY = "${{ github.ref == 'refs/heads/main' && github.event_name != 'pull_request' }}";
const requireThat = (value, message) => { if (!value) throw new Error(message); };

function mapAt(lines, indent, context) {
  const result = new Map();
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
    const match = line.slice(indent).match(/^([A-Za-z0-9_.-]+):(?:\s+(.*))?$/);
    requireThat(match && !result.has(match[1]), `Unsupported or duplicate map key in ${context}`);
    entry = { value: match[2] ?? "", lines: [] };
    result.set(match[1], entry);
  }
  return result;
}

function scalar(entry, context) {
  requireThat(entry && entry.lines.length === 0, `Expected scalar ${context}`);
  const raw = entry.value;
  if (raw.startsWith('"')) {
    const match = raw.match(/^("(?:[^"\\]|\\.)*")\s*(?:#.*)?$/);
    requireThat(match, `Unsupported quoted scalar in ${context}`);
    const parsed = JSON.parse(match[1]);
    requireThat(typeof parsed === "string", `Expected string ${context}`);
    return parsed;
  }
  if (raw.startsWith("'")) {
    const match = raw.match(/^'((?:[^']|'')*)'\s*(?:#.*)?$/);
    requireThat(match, `Unsupported quoted scalar in ${context}`);
    return match[1].replaceAll("''", "'");
  }
  const value = raw.replace(/\s+#.*$/, "").trimEnd();
  requireThat(value && !["&", "*", "!", "|", ">", "[", "{"].some(prefix => value.startsWith(prefix)), `Unsupported scalar in ${context}`);
  return value;
}

function mapping(entry, indent, context) {
  if (!entry) return new Map();
  requireThat(entry.value === "", `Expected indented map ${context}`);
  return mapAt(entry.lines, indent, context);
}

function envMap(entry, indent, context) {
  return Object.fromEntries([...mapping(entry, indent, context)].map(([key, value]) => [key, scalar(value, `${context}.${key}`)]));
}

function stepsFrom(entry, context) {
  requireThat(entry && entry.value === "", `Expected step list in ${context}`);
  const blocks = [];
  for (const line of entry.lines) {
    if (!line.trim() || line.trimStart().startsWith("#")) continue;
    const start = line.match(/^ {6}- (.*)$/);
    if (start) blocks.push([`        ${start[1]}`]);
    else {
      requireThat(blocks.length > 0 && /^ {8}/.test(line), `Unsupported step syntax in ${context}`);
      blocks.at(-1).push(line);
    }
  }
  return blocks.map((lines, index) => mapAt(lines, 8, `${context}.steps[${index}]`));
}

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
    const builds = scripts.flatMap((script, index) => [...script.matchAll(/^\s*npm\s+run\s+build(?:\s|$)/gm)].map(() => index));
    if (name === "macos-default") {
      requireThat(builds.length === 0, "Mac default helper must not rebuild frontend inputs");
      continue;
    }
    const firstCompile = scripts.findIndex(script => /^\s*cargo\s+(?:\+\S+\s+)?(?:clippy|test|build)(?:\s|$)/m.test(script));
    requireThat(builds.length === 1 && firstCompile >= 0 && builds[0] < firstCompile,
      `Frontend build must run once before the first Cargo compile in ${name}`);
    requireThat(!["if", "continue-on-error"].some(key => steps[builds[0]].has(key)),
      `Frontend build must be unconditional and required in ${name}`);
  }
}

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
  const cacheIndex = caches[0];
  const installIndex = installers[0];
  requireThat(uses[cacheIndex] === CACHE_ACTION && uses[installIndex] === RUST_ACTION, `Unreviewed Rust/cache action in ${jobName}`);
  requireThat(!["if", "env", "continue-on-error"].some(key => steps[installIndex].has(key)), `Pinned Rust installer must be unconditional and required in ${jobName}`);
  const guards = steps.flatMap((step, index) => step.get("run")?.value === "node scripts/ci-rust-toolchain.mjs" ? [index] : []);
  requireThat(guards.length === 1 && installIndex < guards[0] && guards[0] < cacheIndex,
    `Pinned hosted toolchain guard must run between install and cache in ${jobName}`);
  requireThat(!["if", "env", "continue-on-error"].some(key => steps[guards[0]].has(key)), `Toolchain guard must be unconditional and required in ${jobName}`);
  for (let index = 0; index < steps.length; index += 1) {
    if (steps[index].get("run")?.value.includes("scripts/release-ci.mjs record-inputs")) {
      requireThat(guards[0] < index && index < cacheIndex, `Compiler input recording must follow isolation and precede cache in ${jobName}`);
    }
  }
  const install = mapping(steps[installIndex].get("with"), 10, "Rust inputs");
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
    const run = steps[index].get("run");
    const script = run && [run.value, ...run.lines].join("\n");
    requireThat(!script || !script.includes("GITHUB_ENV"), `Persistent environment write before cache requires review in ${jobName}`);
  }
  Object.assign(env, envMap(steps[cacheIndex].get("env"), 10, `${jobName}.cache.env`));
  const prefixes = [...CACHE_PREFIXES, ...EXTRA_PREFIXES.split(" ")];
  const effective = Object.fromEntries(Object.entries(env).filter(([key, value]) => value && prefixes.some(prefix => key.startsWith(prefix))).sort(([a], [b]) => a.localeCompare(b)));
  for (const [key, value] of Object.entries(effective)) {
    requireThat(!value.includes("${{") || key === "AIOLM_BENCHMARK_API_URL" && value === "${{ vars.AIOLM_BENCHMARK_API_URL }}",
      `Unsupported cache environment expression ${jobName}.${key}`);
  }
  const inputs = Object.fromEntries([...mapping(steps[cacheIndex].get("with"), 10, `${jobName}.cache.with`)]
    .map(([key, value]) => [key, scalar(value, `${jobName}.cache.${key}`)]));
  const expected = {
    workspaces: "src-tauri -> ../.codex-target", "shared-key": `${purpose}-\${{ runner.os }}-\${{ runner.arch }}`,
    "env-vars": EXTRA_PREFIXES, "cache-bin": "false",
  };
  requireThat(JSON.stringify(Object.keys(inputs).sort()) === JSON.stringify([...Object.keys(expected), "save-if"].sort()), `Changed cache recipe fields in ${jobName}`);
  for (const [key, value] of Object.entries(expected)) requireThat(inputs[key] === value, `Changed cache recipe ${jobName}.${key}`);
  requireThat(helper ? inputs["save-if"] === "false" : [MAIN_ONLY, MAIN_PUSH_ONLY].includes(inputs["save-if"]),
    `Cache writes must stay main-only and helpers restore-only in ${jobName}`);
  return { purpose, env: effective };
}

export function verifyCiWorkflowContracts({ ci, release, packages, rustManifest }) {
  const match = rustManifest.match(/^channel\s*=\s*"([0-9]+\.[0-9]+\.[0-9]+)"\s*$/m);
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
    requireThat(group.every(recipe => JSON.stringify(recipe) === reference), `Cache environment differs between ${group[0].purpose} jobs`);
  }
  // Keep frontend inputs stable while build-time context generation is reused.
  frontendBeforeNativeCompile(ci);
  return { guardedJobs: verification.length + packaging.length, rustPin: pin };
}

export function readCiWorkflowSources(root = ROOT) {
  const read = path => readFileSync(join(root, path), "utf8");
  return {
    ci: read(".github/workflows/ci.yml"), release: read(".github/workflows/release.yml"),
    packages: read(".github/workflows/desktop-packages.yml"), rustManifest: read("rust-toolchain.toml"),
  };
}
