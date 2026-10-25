/* global process, Buffer, console */
// The AppImage type2 runtime that Linux packaging embeds.
//
// The runtime upstream publishes (and linuxdeploy-plugin-appimage downloads by
// default) never removes its extracted tree after --appimage-extract-and-run,
// and two extract-and-run instances share one directory. Packaging therefore
// embeds the pinned source build of patches/ instead. pins.conf names the one
// accepted binary by SHA-256; every source of it (an operator-provided file,
// the build cache or a fresh build) has to match that hash before
// LDAI_RUNTIME_FILE hands it to appimagetool, and the finished AppImage is
// checked to embed it.

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { closeSync, copyFileSync, existsSync, fstatSync, mkdirSync, mkdtempSync, openSync, readdirSync, readFileSync, readSync, renameSync, rmSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const RUNTIME_DIRECTORY = dirname(fileURLToPath(import.meta.url));
const RUNTIME_FILE = "runtime-x86_64";
const BUILD_TOOLS = ["bwrap", "git", "curl", "gpg", "patch", "tar", "sha256sum"];
const ELF_MACHINE_X86_64 = 62;

/** Pinned inputs and the expected runtime hash from pins.conf. */
export function readPins(directory = RUNTIME_DIRECTORY) {
  const pins = {};
  for (const line of readFileSync(join(directory, "pins.conf"), "utf8").split("\n")) {
    const match = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (match) pins[match[1]] = match[2];
  }
  if (!/^[0-9a-f]{64}$/.test(pins.RUNTIME_SHA256 ?? "")) throw new Error("pins.conf has no valid RUNTIME_SHA256");
  return pins;
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function elfSections(bytes) {
  if (bytes.length < 64 || bytes.readUInt32BE(0) !== 0x7f454c46 || bytes[4] !== 2 || bytes[5] !== 1) return null;
  const shoff = Number(bytes.readBigUInt64LE(0x28));
  const shentsize = bytes.readUInt16LE(0x3a);
  const shnum = bytes.readUInt16LE(0x3c);
  const shstrndx = bytes.readUInt16LE(0x3e);
  const end = shoff + shentsize * shnum;
  if (shentsize < 64 || shstrndx >= shnum || end > bytes.length) return null;
  const header = (index) => shoff + index * shentsize;
  const names = Number(bytes.readBigUInt64LE(header(shstrndx) + 0x18));
  const sections = [];
  for (let index = 0; index < shnum; index += 1) {
    const at = header(index);
    const nameAt = names + bytes.readUInt32LE(at);
    const name = bytes.subarray(nameAt, bytes.indexOf(0, nameAt)).toString("latin1");
    sections.push({ name, offset: Number(bytes.readBigUInt64LE(at + 0x18)), size: Number(bytes.readBigUInt64LE(at + 0x20)) });
  }
  return { end, sections };
}

/**
 * Read a candidate runtime and require the pinned x86-64 AppImage type 2 runtime.
 * @returns {Buffer} the runtime bytes
 */
export function readVerifiedRuntime(path, pins = readPins()) {
  if (!existsSync(path) || !statSync(path).isFile()) throw new Error(`AppImage runtime ${path} is not a file`);
  const bytes = readFileSync(path);
  if (!elfSections(bytes) || bytes.readUInt16LE(0x12) !== ELF_MACHINE_X86_64) {
    throw new Error(`AppImage runtime ${path} is not an x86-64 ELF executable`);
  }
  if (bytes.subarray(8, 11).toString("latin1") !== "AI\u0002") {
    throw new Error(`AppImage runtime ${path} is not an AppImage type 2 runtime`);
  }
  const actual = sha256(bytes);
  if (actual !== pins.RUNTIME_SHA256) {
    throw new Error(`AppImage runtime ${path} has SHA-256 ${actual}; packaging requires the pinned ${pins.RUNTIME_SHA256} (scripts/appimage-runtime/pins.conf)`);
  }
  return bytes;
}

/** Why the pinned runtime cannot be used on this host, or null when it can. */
export function hostSupportProblem({ platform = process.platform, arch = process.arch } = {}) {
  if (platform !== "linux" || arch !== "x64") {
    return `the pinned AppImage runtime is built for Linux x86-64 only (this host is ${platform}/${arch})`;
  }
  return null;
}

/**
 * Host requirements of a runtime build. `which(name)` reports whether a
 * command exists; `probeNamespace()` whether bubblewrap can create an
 * unprivileged user namespace.
 */
export function buildPrerequisiteProblems({ platform = process.platform, arch = process.arch, which, probeNamespace }) {
  const unsupported = hostSupportProblem({ platform, arch });
  if (unsupported) return [unsupported];
  const missing = BUILD_TOOLS.filter((name) => !which(name));
  if (missing.length) return [`missing build tools: ${missing.join(", ")} (Debian/Ubuntu: bubblewrap git curl gnupg patch tar coreutils)`];
  if (!existsSync("/dev/fuse")) return ["/dev/fuse is missing; the runtime build binds it into the build namespace"];
  if (!probeNamespace()) {
    return ["bubblewrap cannot create an unprivileged user namespace (allow it with a bwrap AppArmor profile, or run `sudo sysctl -w kernel.apparmor_restrict_unprivileged_userns=0` on a disposable build host)"];
  }
  return [];
}

function hostWhich(name) {
  return spawnSync("sh", ["-c", 'command -v "$1" >/dev/null', "sh", name]).status === 0;
}

function hostProbeNamespace() {
  return spawnSync("bwrap", ["--unshare-user", "--uid", "0", "--ro-bind", "/", "/", "true"], { stdio: "ignore" }).status === 0;
}

/**
 * The verified runtime for this package build, in order of preference:
 * 1. LDAI_RUNTIME_FILE from the environment, accepted only if it is the pinned binary;
 * 2. `<cacheRoot>/<sha256>/runtime-x86_64`, re-hashed on every use and rebuilt if it differs;
 * 3. a fresh `build.sh` run, whose output must match the pin before it is cached.
 * @returns {string} absolute path for LDAI_RUNTIME_FILE
 */
export function provisionAppImageRuntime({
  env = process.env,
  cacheRoot,
  pins = readPins(),
  platform = process.platform,
  arch = process.arch,
  build = (workDirectory) => spawnSync("sh", [join(RUNTIME_DIRECTORY, "build.sh"), workDirectory], { stdio: "inherit" }).status === 0,
  prerequisites = () => buildPrerequisiteProblems({ platform, arch, which: hostWhich, probeNamespace: hostProbeNamespace }),
  log = (message) => console.error(`[appimage-runtime] ${message}`),
}) {
  // An operator override or a cache entry is only useful for an AppImage this
  // host can produce. Do not inject the x86-64 runtime into, say, an arm64 build.
  const unsupported = hostSupportProblem({ platform, arch });
  if (unsupported) throw new Error(`Linux AppImage packaging stopped: ${unsupported}`);
  if (env.LDAI_RUNTIME_FILE) {
    const provided = resolve(env.LDAI_RUNTIME_FILE);
    readVerifiedRuntime(provided, pins);
    log(`using LDAI_RUNTIME_FILE ${provided} (matches the pin)`);
    return provided;
  }
  const cached = join(cacheRoot, pins.RUNTIME_SHA256, RUNTIME_FILE);
  if (existsSync(cached)) {
    try {
      readVerifiedRuntime(cached, pins);
      log(`using cached ${cached}`);
      return cached;
    } catch (error) {
      log(`discarding cached runtime: ${error.message}`);
      rmSync(dirname(cached), { recursive: true, force: true });
    }
  }
  const problems = prerequisites();
  if (problems.length) {
    throw new Error(`cannot build the pinned AppImage runtime: ${problems.join("; ")}. Provide the pinned build through LDAI_RUNTIME_FILE instead.`);
  }
  mkdirSync(cacheRoot, { recursive: true });
  const scratch = mkdtempSync(join(cacheRoot, "build-"));
  try {
    const work = join(scratch, "work");
    log(`building the pinned runtime in ${work}`);
    if (!build(work)) throw new Error("the pinned AppImage runtime build failed; see the output above");
    const built = join(work, "out", RUNTIME_FILE);
    readVerifiedRuntime(built, pins);
    // Publish complete entries only: copy beside the target, then rename.
    const staging = join(scratch, "entry");
    mkdirSync(staging);
    for (const name of [RUNTIME_FILE, "inputs.sha256"]) copyFileSync(join(work, "out", name), join(staging, name));
    rmSync(dirname(cached), { recursive: true, force: true });
    renameSync(staging, dirname(cached));
    readVerifiedRuntime(cached, pins);
    return cached;
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

/**
 * Require an AppImage to start with exactly `runtime`. appimagetool only
 * fills the runtime's .digest_md5 section with the image's own digest, so
 * that section is compared as zeros.
 */
export function verifyEmbeddedRuntime(appImagePath, runtime) {
  const layout = elfSections(runtime);
  if (!layout) throw new Error(`${appImagePath} does not start with the pinned AppImage runtime`);
  let embedded;
  const descriptor = openSync(appImagePath, "r");
  try {
    if (fstatSync(descriptor).size <= layout.end) throw new Error(`${appImagePath} does not start with the pinned AppImage runtime`);
    // Only the runtime prefix participates in this check; the SquashFS payload
    // can be much larger and must not be loaded into memory to verify it.
    embedded = Buffer.alloc(layout.end);
    let offset = 0;
    while (offset < embedded.length) {
      const count = readSync(descriptor, embedded, offset, embedded.length - offset, offset);
      if (!count) throw new Error(`${appImagePath} does not start with the pinned AppImage runtime`);
      offset += count;
    }
  } finally {
    closeSync(descriptor);
  }
  for (const section of layout.sections.filter(({ name }) => name === ".digest_md5")) {
    embedded.fill(0, section.offset, section.offset + section.size);
  }
  if (!embedded.equals(runtime.subarray(0, layout.end)) || runtime.length !== layout.end) {
    throw new Error(`${appImagePath} does not embed the pinned AppImage runtime; LDAI_RUNTIME_FILE was not applied`);
  }
}

/** Every AppImage written in `bundleDirectory` since `since` (ms) must embed `runtime`. */
export function verifyBundledAppImages(bundleDirectory, runtime, since) {
  const images = existsSync(bundleDirectory)
    ? readdirSync(bundleDirectory).filter((name) => name.endsWith(".AppImage")).map((name) => join(bundleDirectory, name))
      .filter((path) => statSync(path).mtimeMs >= since)
    : [];
  if (!images.length) throw new Error(`no AppImage was written to ${bundleDirectory}`);
  for (const image of images) verifyEmbeddedRuntime(image, runtime);
  return images;
}
