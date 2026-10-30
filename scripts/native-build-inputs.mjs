/* global process, console */
// Observe only declared generated inputs of the default normal library. This
// never asks Cargo to rebuild or emits raw dep-info/fingerprint environment data.
import { spawnSync } from "node:child_process";
import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import { closeSync, constants, fstatSync, lstatSync, mkdirSync, openSync, readSync, readdirSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SHA = /^[a-f0-9]{40}$/;
const UNIT = /^aiolm-([a-f0-9]{16})$/;
const GENERATED = /^debug\/build\/aiolm-[a-f0-9]{16}\/out\/[a-f0-9]{64}$/;
const FEATURES = Object.freeze(["default", "test-fixtures"]);
const MAX_GENERATED_BYTES = 16_777_216;
const TOTAL_GENERATED_BYTES = 33_554_432;

class Unavailable extends Error {}
const unavailable = reason => { throw new Unavailable(reason); };

function regular(path, maxBytes, bytes = true) {
  if (realpathSync(path) !== resolve(path) || !lstatSync(path).isFile()) unavailable("unsafe-input-file");
  const fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const before = fstatSync(fd, { bigint: true });
    if (!before.isFile() || before.size > BigInt(maxBytes)) unavailable("invalid-input-size");
    const content = bytes ? Buffer.alloc(Number(before.size)) : null;
    if (content) {
      let offset = 0;
      while (offset < content.length) {
        const count = readSync(fd, content, offset, content.length - offset, offset);
        if (!count) unavailable("input-changed-during-observation");
        offset += count;
      }
    }
    const after = fstatSync(fd, { bigint: true });
    if (before.mtimeNs !== after.mtimeNs || before.size !== after.size) unavailable("input-changed-during-observation");
    return { content, mtime: after.mtimeNs, size: Number(after.size) };
  } finally { closeSync(fd); }
}

/** Rust make dep-info supports escaped spaces, punctuation and continuations. */
export function rustDependencyPaths(text) {
  const paths = [];
  for (const line of text.replace(/\\\r?\n/g, "").split(/\r?\n/)) {
    if (!line.trim() || line.trimStart().startsWith("#")) continue;
    let colon = -1, wordStart = 0;
    for (let index = 0; index < line.length; index += 1) {
      if (/\s/.test(line[index])) wordStart = index + 1;
      if (line[index] === "\\" && /[\s#:\\$]/.test(line[index + 1] ?? "")) { index += 1; continue; }
      if (line[index] !== ":") continue;
      if (index === wordStart + 1 && /[A-Za-z]/.test(line[wordStart]) && /[/\\]/.test(line[index + 1] ?? "")) continue;
      colon = index; break;
    }
    if (colon < 0) continue;
    let word = "";
    const finish = () => { if (word) paths.push(word); word = ""; };
    for (let index = colon + 1; index < line.length; index += 1) {
      const character = line[index];
      if (character === "#") break;
      if (character === "\\" && /[\s#:\\$]/.test(line[index + 1] ?? "")) { word += line[++index]; continue; }
      if (character === "$" && line[index + 1] === "$") { word += "$"; index += 1; continue; }
      if (/\s/.test(character)) finish(); else word += character;
    }
    finish();
  }
  return [...new Set(paths)];
}

function integerId(text, key) {
  const values = [...text.matchAll(new RegExp(`"${key}"\\s*:\\s*(0|[1-9][0-9]{0,19})\\s*(?=,|})`, "g"))];
  if (values.length !== 1) unavailable("invalid-library-fingerprint");
  return values[0][1];
}

function gitSource(root) {
  const result = spawnSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8", timeout: 10_000, maxBuffer: 65_536, stdio: ["ignore", "pipe", "pipe"], shell: false });
  if (result.error || result.status !== 0 || !SHA.test(result.stdout.trim())) throw new Error("Cannot verify native observation source");
  return result.stdout.trim();
}

export function observeNativeBuildInputs({ root = ROOT, targetDirectory = resolve(root, process.env.CARGO_TARGET_DIR ?? ".codex-target"), sourceSha, phase, readSource = gitSource }) {
  if (!SHA.test(sourceSha ?? "") || !["before", "after"].includes(phase)) throw new Error("Invalid native observation arguments");
  if (readSource(root) !== sourceSha) throw new Error("Native observation source does not match checkout");
  const base = { formatVersion: 1, sourceSha, phase };
  try {
    const target = resolve(targetDirectory);
    if (realpathSync(target) !== target || !lstatSync(target).isDirectory()) unavailable("unsafe-target-directory");
    const fingerprint = join(target, "debug", ".fingerprint");
    const candidates = [];
    const entries = readdirSync(fingerprint);
    if (entries.length > 10_000) unavailable("too-many-fingerprint-entries");
    const packageUnits = entries.filter(name => UNIT.test(name)).sort();
    let libraryRecords = 0;
    let remainingFingerprintBytes = 8_388_608;
    for (const name of packageUnits) {
      const folder = join(fingerprint, name);
      if (realpathSync(folder) !== folder || !lstatSync(folder).isDirectory()) unavailable("unsafe-library-directory");
      const file = join(folder, "lib-aiolm_lib.json");
      let text;
      try {
        // Bins, integration tests and library tests share the package prefix.
        // Only an actual normal-library record consumes this record budget.
        if (!lstatSync(file).isFile()) unavailable("unsafe-input-file");
        if (++libraryRecords > 64) unavailable("too-many-library-entries");
        const value = regular(file, Math.min(1_048_576, remainingFingerprintBytes));
        remainingFingerprintBytes -= value.size;
        text = value.content.toString("utf8");
      }
      catch (error) { if (error.code === "ENOENT") continue; throw error; }
      const metadata = JSON.parse(text);
      const features = JSON.parse(metadata.features);
      if (!Array.isArray(features) || JSON.stringify([...features].sort()) !== JSON.stringify(FEATURES)) continue;
      candidates.push({ id: UNIT.exec(name)[1], features: [...FEATURES], profileId: integerId(text, "profile"), compilerId: integerId(text, "rustc"), configId: integerId(text, "config"), compileKind: integerId(text, "compile_kind"), invocationNs: regular(join(folder, "invoked.timestamp"), 65_536, false).mtime.toString() });
    }
    if (candidates.length !== 1) return { ...base, status: "unavailable", reason: candidates.length ? "ambiguous-default-library" : "missing-default-library", unitIds: candidates.map(unit => unit.id) };
    const unit = candidates[0];
    const depInfo = regular(join(target, "debug", "deps", `aiolm_lib-${unit.id}.d`), 4_194_304).content.toString("utf8");
    const dependencies = [...new Set(rustDependencyPaths(depInfo).map(path => resolve(root, path))
      .filter(path => isAbsolute(path) && GENERATED.test(relative(target, path).replaceAll("\\", "/"))))].sort();
    if (!dependencies.length) unavailable("no-generated-inputs");
    if (dependencies.length > 32) unavailable("too-many-generated-inputs");
    let remainingBytes = TOTAL_GENERATED_BYTES;
    const inputs = dependencies.map(path => {
      const value = regular(path, Math.min(MAX_GENERATED_BYTES, remainingBytes));
      remainingBytes -= value.size;
      return { path: relative(target, path).replaceAll("\\", "/"), sizeBytes: value.size, sha256: createHash("sha256").update(value.content).digest("hex"), mtimeNs: value.mtime.toString(), newerThanInvocation: value.mtime > BigInt(unit.invocationNs), deltaNs: (value.mtime - BigInt(unit.invocationNs)).toString() };
    });
    return { ...base, status: "observed", unit, generatedInputs: inputs };
  } catch (error) {
    // Do not echo filesystem/JSON diagnostics: they can contain local paths or
    // compiler environment values. Missing observations cannot satisfy a proof.
    return { ...base, status: "unavailable", reason: error instanceof Unavailable ? error.message : "unreadable-native-inputs" };
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const args = process.argv.slice(2);
    const options = {};
    for (let index = 0; index < args.length; index += 2) {
      const name = args[index];
      if (!["--source", "--phase", "--output"].includes(name) || options[name] !== undefined || !args[index + 1]) throw new Error("Invalid native observation arguments");
      options[name] = args[index + 1];
    }
    if (!options["--output"]) throw new Error("Missing native observation output");
    const result = observeNativeBuildInputs({ sourceSha: options["--source"], phase: options["--phase"] });
    const output = resolve(ROOT, options["--output"]);
    mkdirSync(dirname(output), { recursive: true });
    writeFileSync(output, JSON.stringify(result, null, 2) + "\n");
    console.log(`Native ${result.phase} inputs: ${result.status}${result.reason ? ` (${result.reason})` : ""}.`);
  } catch {
    console.error("Native build input observation failed.");
    process.exitCode = 1;
  }
}
