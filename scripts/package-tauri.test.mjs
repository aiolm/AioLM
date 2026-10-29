/* global Buffer */
import assert from "node:assert/strict";
import { test } from "node:test";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { URL } from "node:url";
import {
  buildPrerequisiteProblems, provisionAppImageRuntime, readPins, readVerifiedRuntime, RUNTIME_DIRECTORY, verifyBundledAppImages, verifyEmbeddedRuntime,
} from "./appimage-runtime/runtime.mjs";
import { bundleTargets, packagingArgs, packagingEnv, preparePackagingEnv, runPackaging } from "./package-tauri.mjs";

test("desktop packaging selects formats that the host can build", () => {
  assert.equal(bundleTargets("win32"), "nsis,msi");
  assert.equal(bundleTargets("linux"), "deb,appimage");
  assert.equal(bundleTargets("darwin"), "app,dmg");
  assert.throws(() => bundleTargets("freebsd"), /not supported/);
  assert.deepEqual(packagingArgs("linux"), [
    "build", "--config", "src-tauri/tauri-package.conf.json", "--features", "tauri/custom-protocol", "--no-bundle",
    "--", "--locked", "--no-default-features", "--timings",
  ]);
  assert.deepEqual(packagingArgs("linux", "bundle"), [
    "bundle", "--config", "src-tauri/tauri-package.conf.json", "--features", "tauri/custom-protocol", "--bundles", "deb,appimage",
  ]);
});

test("smoke fixtures stay enabled for normal tests and excluded from packaging", () => {
  const manifest = readFileSync(new URL("../src-tauri/Cargo.toml", import.meta.url), "utf8");
  const featureSection = manifest.match(/\[features\]([\s\S]*?)(?=\n\[|$)/)?.[1];
  assert.match(featureSection, /default\s*=\s*\["test-fixtures"\]/);
  for (const [kind, name] of [["bin", "fake-llama-server"], ["test", "smoke_fake"]]) {
    const sections = manifest.split(new RegExp(`\\[\\[${kind}\\]\\]`)).slice(1);
    const target = sections.map((section) => section.split(/\n\[/)[0])
      .find((section) => section.includes(`name = "${name}"`));
    assert.match(target, /required-features\s*=\s*\["test-fixtures"\]/);
  }
  for (const platform of ["win32", "linux", "darwin"]) {
    assert.ok(packagingArgs(platform).includes("--no-default-features"));
    assert.ok(!packagingArgs(platform, "bundle").includes("test-fixtures"));
  }
});

function packagingFixture(t, platform = "win32") {
  const root = mkdtempSync(join(tmpdir(), "aiolm-desktop-package-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const directory = join(root, ".codex-target", "release");
  const writeExecutable = (name) => {
    mkdirSync(directory, { recursive: true });
    writeFileSync(join(directory, name + (platform === "win32" ? ".exe" : "")), `synthetic ${name}`);
  };
  return { root, platform, env: { SYNTHETIC_BUILD: "1" }, cli: join(root, "tauri.js"), writeExecutable };
}

test("one production build produces both executables before bundle-only packaging", (t) => {
  const fixture = packagingFixture(t);
  const calls = [];
  const result = runPackaging({ ...fixture, spawn(command, args, options) {
    calls.push({ command, args, options });
    if (args[1] === "build") {
      fixture.writeExecutable("aiolm");
      fixture.writeExecutable("aiolm-cli");
    }
    return { status: 0 };
  } });
  assert.equal(result, 0);
  assert.deepEqual(calls.map(({ args }) => args[1]), ["build", "bundle"]);
  assert.equal(calls.filter(({ args }) => args.includes("--no-bundle")).length, 1);
  assert.equal(calls[0].options.env, calls[1].options.env);
  assert.equal(calls[0].options.cwd, fixture.root);
  assert.equal(calls[1].options.cwd, fixture.root);
  assert.equal(calls[1].options.env.SYNTHETIC_BUILD, "1");
});

test("a failed production build never packages existing executables", (t) => {
  const fixture = packagingFixture(t);
  fixture.writeExecutable("aiolm");
  fixture.writeExecutable("aiolm-cli");
  const calls = [];
  assert.equal(runPackaging({ ...fixture, spawn(_command, args) {
    calls.push(args[1]);
    return { status: 17 };
  } }), 17);
  assert.deepEqual(calls, ["build"]);
});

test("packaging stops when a successful runner has not produced the auxiliary CLI", (t) => {
  const fixture = packagingFixture(t);
  const calls = [];
  assert.throws(() => runPackaging({ ...fixture, spawn(_command, args) {
    calls.push(args[1]);
    fixture.writeExecutable("aiolm");
    return { status: 0 };
  } }), /did not create aiolm-cli/);
  assert.deepEqual(calls, ["build"]);
});

test("bundle failures propagate without reporting verified AppImages", (t) => {
  const fixture = packagingFixture(t, "linux");
  const calls = [];
  const result = runPackaging({ ...fixture,
    provisionRuntime: () => "/synthetic/pinned-runtime",
    readRuntime: () => assert.fail("no successful bundle to verify"),
    spawn(_command, args) {
      calls.push(args[1]);
      fixture.writeExecutable("aiolm");
      fixture.writeExecutable("aiolm-cli");
      return { status: args[1] === "build" ? 0 : 23 };
    },
  });
  assert.equal(result, 23);
  assert.deepEqual(calls, ["build", "bundle"]);
});

test("early AppImage preparation uses the same cache as normal packaging", (t) => {
  const fixture = packagingFixture(t, "linux");
  const options = [];
  const prepare = () => preparePackagingEnv({ ...fixture, provisionRuntime(value) {
    options.push(value);
    return "/synthetic/pinned-runtime";
  } });
  assert.equal(prepare().LDAI_RUNTIME_FILE, "/synthetic/pinned-runtime");
  assert.equal(prepare().LDAI_RUNTIME_FILE, "/synthetic/pinned-runtime");
  assert.equal(options[0].cacheRoot, join(fixture.root, ".codex-target", "appimage-runtime"));
  assert.equal(options[0].cacheRoot, options[1].cacheRoot);
});

test("direct Tauri builds use host formats and CLI builds never bundle", () => {
  const read = (name) => JSON.parse(readFileSync(new URL(`../src-tauri/${name}`, import.meta.url), "utf8"));
  assert.equal(read("tauri.conf.json").bundle.targets, "all");
  assert.equal(read("tauri-cli-build.conf.json").bundle.active, false);
});

// A minimal x86-64 AppImage type 2 runtime image: an ELF header carrying the
// "AI\x02" magic, a section name table and appimagetool's .digest_md5 section.
function syntheticRuntime({ machine = 62, magic = "AI\u0002", body = "runtime code" } = {}) {
  const names = Buffer.from("\0.shstrtab\0.digest_md5\0", "latin1");
  const code = Buffer.from(body, "latin1");
  const namesAt = 64;
  const digestAt = namesAt + names.length;
  const codeAt = digestAt + 16;
  const shoff = codeAt + code.length;
  const header = Buffer.alloc(64);
  header.writeUInt32BE(0x7f454c46, 0);
  header[4] = 2;
  header[5] = 1;
  header[6] = 1;
  header.write(magic, 8, "latin1");
  header.writeUInt16LE(3, 0x10);
  header.writeUInt16LE(machine, 0x12);
  header.writeBigUInt64LE(BigInt(shoff), 0x28);
  header.writeUInt16LE(64, 0x3a);
  header.writeUInt16LE(3, 0x3c);
  header.writeUInt16LE(1, 0x3e);
  const section = (name, offset, size) => {
    const row = Buffer.alloc(64);
    row.writeUInt32LE(name, 0);
    row.writeBigUInt64LE(BigInt(offset), 0x18);
    row.writeBigUInt64LE(BigInt(size), 0x20);
    return row;
  };
  return Buffer.concat([header, names, Buffer.alloc(16), code, Buffer.alloc(64),
    section(1, namesAt, names.length), section(11, digestAt, 16)]);
}

function runtimeFixture(t) {
  const directory = mkdtempSync(join(tmpdir(), "aiolm-appimage-runtime-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const runtime = syntheticRuntime();
  const pins = { RUNTIME_SHA256: createHash("sha256").update(runtime).digest("hex") };
  const write = (name, bytes) => {
    const path = join(directory, name);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, bytes);
    return path;
  };
  const noBuild = () => assert.fail("no runtime build is expected");
  const ready = () => [];
  return { directory, runtime, pins, write, noBuild, ready, log: () => {} };
}

test("packaging re-verifies the pinned runtime after the bundle command", (t) => {
  const fixture = packagingFixture(t, "linux");
  const { runtime, pins, write } = runtimeFixture(t);
  const path = write("provided/runtime", runtime);
  assert.throws(() => runPackaging({ ...fixture,
    provisionRuntime: () => path,
    readRuntime: (candidate) => readVerifiedRuntime(candidate, pins),
    spawn(_command, args) {
      fixture.writeExecutable("aiolm");
      fixture.writeExecutable("aiolm-cli");
      if (args[1] === "bundle") writeFileSync(path, syntheticRuntime({ body: "changed during packaging" }));
      return { status: 0 };
    },
  }), /requires the pinned/);
});

test("Linux packaging hands appimagetool the pinned runtime; other hosts are unchanged", () => {
  const base = { PATH: "/usr/bin" };
  const seen = [];
  const env = packagingEnv("linux", base, (environment) => {
    seen.push(environment);
    return "/cache/runtime-x86_64";
  });
  assert.equal(env.LDAI_RUNTIME_FILE, "/cache/runtime-x86_64");
  assert.deepEqual(seen, [base]);
  for (const platform of ["win32", "darwin"]) {
    assert.equal(packagingEnv(platform, base, () => assert.fail("no AppImage runtime off Linux")), base);
  }
});

test("the committed runtime pin names the reviewed upstream revision, both patches and its license", () => {
  const pins = readPins();
  assert.equal(pins.TYPE2_RUNTIME_COMMIT, "fedfad51acc2860b2916a1eef32ba4a500ff31ef");
  assert.match(pins.RUNTIME_SHA256, /^[0-9a-f]{64}$/);
  const build = readFileSync(join(RUNTIME_DIRECTORY, "build.sh"), "utf8");
  const patches = [...build.matchAll(/patches\/[\w.-]+\.patch/g)].map(([path]) => path);
  assert.deepEqual(patches.map((path) => path.split("/")[1].slice(0, 4)), ["0001", "0002"]);
  for (const path of patches) assert.match(readFileSync(join(RUNTIME_DIRECTORY, path), "utf8"), /^diff --git a\/src\/runtime\/runtime\.c/);
  assert.match(readFileSync(join(RUNTIME_DIRECTORY, "LICENSE.type2-runtime"), "utf8"), /^MIT License\n\nCopyright \(c\) 2004-23 probonopd/);
  assert.match(readFileSync(join(RUNTIME_DIRECTORY, "apk.lock"), "utf8"), /^musl-1\.2\.5-r12$/m);
});

test("an operator-provided LDAI_RUNTIME_FILE is used only when it is the pinned x86-64 runtime", (t) => {
  const { directory, runtime, pins, write, noBuild, ready, log } = runtimeFixture(t);
  const options = {
    cacheRoot: join(directory, "cache"), pins, build: noBuild, prerequisites: ready, log,
    platform: "linux", arch: "x64",
  };
  const pinned = write("provided/runtime", runtime);
  assert.equal(provisionAppImageRuntime({ ...options, env: { LDAI_RUNTIME_FILE: pinned } }), pinned);
  for (const [bytes, reason] of [
    [syntheticRuntime({ machine: 183 }), /not an x86-64 ELF/],
    [syntheticRuntime({ magic: "\0\0\0" }), /not an AppImage type 2 runtime/],
    [syntheticRuntime({ body: "upstream runtime" }), /requires the pinned/],
    [Buffer.from("MZ not an ELF"), /not an x86-64 ELF/],
  ]) {
    const candidate = write("provided/other", bytes);
    assert.throws(() => provisionAppImageRuntime({ ...options, env: { LDAI_RUNTIME_FILE: candidate } }), reason);
  }
  assert.throws(() => provisionAppImageRuntime({ ...options, env: { LDAI_RUNTIME_FILE: join(dirname(pinned), "missing") } }), /is not a file/);
});

test("the build cache is re-verified on use and a changed entry is rebuilt, never reused", (t) => {
  const { directory, runtime, pins, write, ready, log } = runtimeFixture(t);
  const cacheRoot = join(directory, "cache");
  let builds = 0;
  const build = (work) => {
    builds += 1;
    write(join("cache", work.slice(cacheRoot.length + 1), "out", "runtime-x86_64"), runtime);
    write(join("cache", work.slice(cacheRoot.length + 1), "out", "inputs.sha256"), "inputs\n");
    return true;
  };
  const options = { env: {}, cacheRoot, pins, build, prerequisites: ready, log, platform: "linux", arch: "x64" };
  const first = provisionAppImageRuntime(options);
  assert.equal(first, join(cacheRoot, pins.RUNTIME_SHA256, "runtime-x86_64"));
  assert.equal(provisionAppImageRuntime(options), first);
  assert.equal(builds, 1);
  writeFileSync(first, syntheticRuntime({ body: "stale runtime" }));
  assert.equal(provisionAppImageRuntime(options), first);
  assert.equal(builds, 2);
  assert.ok(readFileSync(first).equals(runtime));
  assert.deepEqual(readdirSync(cacheRoot), [pins.RUNTIME_SHA256], "no scratch build directories remain");
});

test("a build whose output drifts from the pin fails and caches nothing", (t) => {
  const { directory, pins, write, ready, log } = runtimeFixture(t);
  const cacheRoot = join(directory, "cache");
  const build = (work) => {
    write(join("cache", work.slice(cacheRoot.length + 1), "out", "runtime-x86_64"), syntheticRuntime({ body: "drifted toolchain" }));
    return true;
  };
  const options = { env: {}, cacheRoot, pins, build, prerequisites: ready, log, platform: "linux", arch: "x64" };
  assert.throws(() => provisionAppImageRuntime(options), /requires the pinned/);
  assert.throws(() => provisionAppImageRuntime({ ...options, build: () => false }), /build failed/);
  assert.deepEqual(readdirSync(cacheRoot), []);
});

test("missing build prerequisites stop packaging before any build", (t) => {
  const { directory, pins, noBuild, log } = runtimeFixture(t);
  const options = { env: {}, cacheRoot: join(directory, "cache"), pins, build: noBuild, log, platform: "linux", arch: "x64" };
  const present = () => true;
  assert.match(buildPrerequisiteProblems({ platform: "linux", arch: "arm64", which: present, probeNamespace: present })[0], /x86-64 only/);
  assert.match(buildPrerequisiteProblems({ platform: "darwin", arch: "x64", which: present, probeNamespace: present })[0], /Linux x86-64 only/);
  assert.match(buildPrerequisiteProblems({ platform: "linux", arch: "x64", which: (name) => name !== "bwrap" && name !== "gpg", probeNamespace: present })[0],
    /missing build tools: bwrap, gpg/);
  if (existsSync("/dev/fuse")) {
    assert.match(buildPrerequisiteProblems({ platform: "linux", arch: "x64", which: present, probeNamespace: () => false })[0], /unprivileged user namespace/);
  }
  assert.throws(() => provisionAppImageRuntime({ ...options, prerequisites: () => ["missing build tools: bwrap"] }),
    /cannot build the pinned AppImage runtime: missing build tools: bwrap.*LDAI_RUNTIME_FILE/);
});

test("an x86-64 runtime is never injected into an unsupported host, even from cache or override", (t) => {
  const { directory, runtime, pins, write, noBuild, ready, log } = runtimeFixture(t);
  const cacheRoot = join(directory, "cache");
  write(join("cache", pins.RUNTIME_SHA256, "runtime-x86_64"), runtime);
  const options = { cacheRoot, pins, build: noBuild, prerequisites: ready, log };
  assert.throws(() => provisionAppImageRuntime({ ...options, env: {}, platform: "linux", arch: "arm64" }), /x86-64 only/);
  assert.throws(() => provisionAppImageRuntime({
    ...options,
    env: { LDAI_RUNTIME_FILE: write("provided/runtime", runtime) },
    platform: "darwin",
    arch: "arm64",
  }), /x86-64 only/);
  assert.throws(() => provisionAppImageRuntime({ ...options, env: {}, platform: "win32", arch: "x64" }), /x86-64 only/);
});

test("finished AppImages must embed the pinned runtime, apart from appimagetool's image digest", (t) => {
  const { directory, runtime, write } = runtimeFixture(t);
  const embedded = Buffer.from(runtime);
  embedded.fill(0xab, 64 + "\0.shstrtab\0.digest_md5\0".length, 64 + "\0.shstrtab\0.digest_md5\0".length + 16);
  const bundle = join(directory, "bundle");
  const since = Date.now() - 1000;
  write("bundle/AioLM.AppImage", Buffer.concat([embedded, Buffer.from("hsqs payload")]));
  write("bundle/AioLM.deb", "not an AppImage");
  assert.deepEqual(verifyBundledAppImages(bundle, runtime, since), [join(bundle, "AioLM.AppImage")]);
  const upstream = syntheticRuntime({ body: "upstream runtime" });
  write("bundle/AioLM.AppImage", Buffer.concat([upstream, Buffer.from("hsqs payload")]));
  assert.throws(() => verifyBundledAppImages(bundle, runtime, since), /does not embed the pinned AppImage runtime/);
  assert.throws(() => verifyBundledAppImages(bundle, runtime, Date.now() + 60_000), /no AppImage was written/);
});

test("embedded runtime verification rejects incomplete images and changed runtime headers", (t) => {
  const { runtime, write } = runtimeFixture(t);
  for (const length of [0, runtime.length - 1, runtime.length]) {
    const image = write(`incomplete-${length}.AppImage`, runtime.subarray(0, length));
    assert.throws(() => verifyEmbeddedRuntime(image, runtime), /does not start with the pinned AppImage runtime/);
  }
  const valid = write("complete.AppImage", Buffer.concat([runtime, Buffer.from("hsqs")]));
  verifyEmbeddedRuntime(valid, runtime);
  assert.throws(() => verifyEmbeddedRuntime(valid, Buffer.concat([runtime, Buffer.from("extra")])),
    /does not embed the pinned AppImage runtime/);
  const wrongArchitecture = Buffer.from(runtime);
  wrongArchitecture.writeUInt16LE(183, 0x12);
  const changed = write("wrong-architecture.AppImage", Buffer.concat([wrongArchitecture, Buffer.from("hsqs")]));
  assert.throws(() => verifyEmbeddedRuntime(changed, runtime), /does not embed the pinned AppImage runtime/);
  assert.throws(() => verifyEmbeddedRuntime(`${valid}.missing`, runtime), { code: "ENOENT" });
});
