import assert from "node:assert/strict";
import { copyFileSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { readCiWorkflowSources, verifyCiWorkflowContracts } from "./ci-workflow-contract.mjs";

/** @typedef {import("./ci-workflow-contract.mjs").WorkflowSources} WorkflowSources */
/** @typedef {(job: string) => string} JobChange */
// Windows checks out YAML with CRLF. Use one canonical mutation fixture so a
// literal replacement always changes the intended input on every host.
const sources = /** @type {WorkflowSources} */ (Object.fromEntries(Object.entries(readCiWorkflowSources()).map(([key, source]) => [key, source.replace(/\r\n/g, "\n")])));
/** @param {Partial<WorkflowSources>} [patch] */
const verify = patch => {
  for (const [key, source] of Object.entries(patch ?? {})) {
    assert.notEqual(source, sources[/** @type {keyof WorkflowSources} */ (key)], `Expected mutation of ${key} to change the fixture`);
  }
  return verifyCiWorkflowContracts({ ...sources, ...patch });
};
/** @param {string} source @param {string} name @param {JobChange} change */
const changeCiJob = (source, name, change) => {
  const start = source.indexOf(`  ${name}:\n`);
  assert.ok(start >= 0, `Expected ${name} job`);
  const next = source.slice(start + 1).search(/^ {2}[\w-]+:\n/m);
  const end = next < 0 ? source.length : start + 1 + next;
  return source.slice(0, start) + change(source.slice(start, end)) + source.slice(end);
};

test("all seven cached jobs preserve compiler isolation, cache purposes and matching effective environments", () => {
  assert.deepEqual(verify(), { guardedJobs: 7, rustPin: "1.98.0" });
});

test("the historical release/package backtrace mismatch is rejected", () => {
  assert.throws(() => verify({ packages: sources.packages.replace('      RUST_BACKTRACE: "1"\n', "") }), /Cache environment differs between package jobs/);
});

test("LF and Windows CRLF workflows enforce the same historical mismatch check", () => {
  for (const newline of ["\n", "\r\n"]) {
    const variant = /** @type {WorkflowSources} */ (Object.fromEntries(Object.entries(sources).map(([key, source]) => [key, source.replace(/\n/g, newline)])));
    assert.deepEqual(verifyCiWorkflowContracts(variant), verify());
    const packages = variant.packages.replace(/ {6}RUST_BACKTRACE: "1"\r?\n/, "");
    assert.notEqual(packages, variant.packages, "Expected backtrace removal in either line-ending format");
    assert.throws(() => verifyCiWorkflowContracts({ ...variant, packages }), /Cache environment differs between package jobs/);
    const ci = changeCiJob(sources.ci, "rust", job => job.replace("      - name: Download verified frontend inputs\n", "      - name: Download verified frontend inputs\n        if: runner.os == 'macOS'\n")).replace(/\n/g, newline);
    assert.notEqual(ci, variant.ci, "Expected conditional frontend mutation in either line-ending format");
    assert.throws(() => verifyCiWorkflowContracts({ ...variant, ci }), /Frontend artifact download must be unconditional and required/);
  }
});

test("native verification reuses the Linux artifact before its first Cargo compile", () => {
  for (const name of ["rust", "rust-portability"]) {
    for (const change of /** @type {JobChange[]} */ ([
      job => job.replace("name: frontend-dist", "name: unrelated"),
      job => job.replace("          path: dist", "          path: other"),
      job => job.replace("    needs: frontend-checks", "    needs: frontend-plan"),
      job => job.replace("      - name: Download verified frontend inputs\n", "      - name: Download verified frontend inputs\n        if: runner.os == 'macOS'\n"),
      job => job.replace("      - name: Download verified frontend inputs\n", "      - name: Download verified frontend inputs\n        continue-on-error: true\n"),
      job => job.replace("      - name: Download verified frontend inputs\n", "      - run: npm run build\n      - name: Download verified frontend inputs\n"),
      job => {
        const download = job.match(/^ {6}- name: Download verified frontend inputs\n(?: {8}.*\n)*/m)?.[0];
        assert.ok(download);
        return job.replace(download, "").replace(/^( {8}run: cargo clippy[^\n]*\n)/m, `$1${download}`);
      },
    ])) assert.throws(() => verify({ ci: changeCiJob(sources.ci, name, change) }), /Frontend artifact|must depend on frontend-checks|must reuse frontend inputs/);
  }
});

test("the default-feature Mac helper never regenerates frontend inputs", () => {
  const ci = changeCiJob(sources.ci, "macos-default", job => job.replace("      - name: Default-feature native tests", "      - run: npm run build\n      - name: Default-feature native tests"));
  assert.throws(() => verify({ ci }), /must reuse frontend inputs/);
});

test("the pinned installer default makes explicit and implicit incremental settings equivalent", () => {
  const release = sources.release.replace(/ {6}CARGO_INCREMENTAL: "0"\n/g, "");
  assert.deepEqual(verify({ release }), verify());
  assert.throws(() => verify({ packages: sources.packages.replace('      CARGO_INCREMENTAL: "0"', '      CARGO_INCREMENTAL: "1"') }), /Cache environment differs/);
});

test("additional cache-prefixed flags, step overrides and unsupported expressions cannot escape parity checks", () => {
  for (const line of ['      CFLAGS: "-O3"', '      RUSTFLAGS: "-C opt-level=3"', '      CARGO_BUILD_TARGET: ${{ matrix.target }}']) {
    assert.throws(() => verify({ packages: sources.packages.replace('      RUST_BACKTRACE: "1"', `      RUST_BACKTRACE: "1"\n${line}`) }), /Cache environment differs|Unsupported cache environment expression/);
  }
  const packages = sources.packages.replace('      - name: Restore Cargo dependencies (package)\n', '      - name: Restore Cargo dependencies (package)\n        env:\n          RUST_BACKTRACE: "0"\n');
  assert.throws(() => verify({ packages }), /Cache environment differs/);
  const persistent = sources.packages.replace('        run: node scripts/ci-rust-toolchain.mjs', '        run: node scripts/ci-rust-toolchain.mjs\n      - run: echo RUST_BACKTRACE=0 >> "$GITHUB_ENV"');
  assert.throws(() => verify({ packages: persistent }), /Persistent environment write before cache/);
});

test("cache recipes keep workspace dependencies separate and reject unreviewed broad cache settings", () => {
  for (const [before, after] of /** @type {[string, string][]} */ ([
    ['shared-key: "package-', 'shared-key: "verify-'],
    ["          cache-bin: false", "          cache-bin: true"],
    ["          cache-bin: false", "          cache-bin: false\n          cache-workspace-crates: true"],
    ["Swatinem/rust-cache@d1527c8f67ef9af357290475d4af4b0fab8f12e0", "Swatinem/rust-cache@v2"],
  ])) assert.throws(() => verify({ packages: sources.packages.replace(before, after) }), /cache recipe|Unreviewed/);
});

test("only main writers save caches and the Mac default helper remains restore-only", () => {
  assert.throws(() => verify({ packages: sources.packages.replace("save-if: ${{ github.ref == 'refs/heads/main' && github.event_name != 'pull_request' }}", "save-if: true") }), /Cache writes must stay main-only/);
  const ci = sources.ci.replace("          save-if: false", "          save-if: ${{ github.ref == 'refs/heads/main' }}");
  assert.throws(() => verify({ ci }), /helpers restore-only/);
});

test("each cache requires an unconditional pinned toolchain guard after its installer", () => {
  for (const packages of [
    sources.packages.replace("        run: node scripts/ci-rust-toolchain.mjs", "        run: node scripts/other-command.mjs"),
    sources.packages.replace("        run: node scripts/ci-rust-toolchain.mjs", "        if: runner.os == 'macOS'\n        run: node scripts/ci-rust-toolchain.mjs"),
    sources.packages.replace("        run: node scripts/ci-rust-toolchain.mjs", "        continue-on-error: true\n        run: node scripts/ci-rust-toolchain.mjs"),
    sources.packages.replace("      - name: Install Rust\n", "      - name: Install Rust\n        continue-on-error: true\n"),
    sources.packages.replace("      - name: Install Rust\n", "      - name: Install Rust\n        if: runner.os == 'macOS'\n"),
    sources.packages.replace("      - name: Install Rust\n", "      - name: Install Rust\n        env:\n          CARGO_INCREMENTAL: 1\n"),
    sources.packages.replace('          toolchain: "1.98.0"', '          toolchain: "stable"'),
  ]) assert.throws(() => verify({ packages }), /toolchain guard|manifest pin|installer/i);
});

test("ambiguous environment maps fail instead of silently losing cache inputs", () => {
  for (const line of ['      RUST_BACKTRACE: "0"', "      <<: *shared", "      CFLAGS: &flags -O3"]) {
    assert.throws(() => verify({ packages: sources.packages.replace('      RUST_BACKTRACE: "1"', `      RUST_BACKTRACE: "1"\n${line}`) }), /duplicate map key|Unsupported scalar/);
  }
});

test("new cache consumers must join a reviewed cache group", () => {
  const packages = `${sources.packages}\n  additional-cache:\n    steps:\n      - uses: Swatinem/rust-cache@d1527c8f67ef9af357290475d4af4b0fab8f12e0\n`;
  assert.throws(() => verify({ packages }), /Unreviewed additional Rust cache consumer/);
});

test("only the reviewed macOS-gated WebDriver use is found in native sources", () => {
  assert.match(sources.featureUses, /^src-tauri\/src\/lib\.rs:\d+: +#\[cfg\(all\(debug_assertions, target_os = "macos", feature = "macos-ui-smoke"\)\)\]$/);
});

test("Windows and Linux binaries reuse the all-feature test build while macOS keeps default features", () => {
  const linuxBuild = "        if: runner.os == 'Linux'\n        run: cargo build --locked --manifest-path src-tauri/Cargo.toml --bins --all-features --timings";
  const macBuild = "        if: runner.os == 'macOS'\n        run: cargo build --locked --manifest-path src-tauri/Cargo.toml --bins --timings";
  for (const [ci, error] of /** @type {[string, RegExp][]} */ ([
    [changeCiJob(sources.ci, "rust", job => job.replace("--bins --all-features", "--bins")), /Windows binaries must reuse/],
    [changeCiJob(sources.ci, "rust-portability", job => job.replace(linuxBuild, linuxBuild.replace(" --all-features", ""))), /Linux binaries must reuse/],
    [changeCiJob(sources.ci, "rust-portability", job => job.replace(linuxBuild, linuxBuild.replace("        if: runner.os == 'Linux'\n", ""))), /Expected one Linux and one macOS binary build/],
    [changeCiJob(sources.ci, "rust-portability", job => job.replace(macBuild, macBuild.replace("--bins", "--bins --all-features"))), /macOS binaries must keep the default features/],
    [changeCiJob(sources.ci, "rust-portability", job => job.replace(macBuild, macBuild.replace("--bins", "--bins --no-default-features"))), /macOS binaries must keep the default features/],
    // Cargo's short feature flag, separate or attached, also selects features.
    [changeCiJob(sources.ci, "rust-portability", job => job.replace(macBuild, macBuild.replace("--bins", "--bins -F macos-ui-smoke"))), /macOS binaries must keep the default features/],
    [changeCiJob(sources.ci, "rust-portability", job => job.replace(macBuild, macBuild.replace("--bins", "--bins -Fmacos-ui-smoke"))), /macOS binaries must keep the default features/],
    [changeCiJob(sources.ci, "rust-portability", job => job.replace(macBuild, macBuild.replace("--bins", "--bins --features=macos-ui-smoke"))), /macOS binaries must keep the default features/],
    [changeCiJob(sources.ci, "rust-portability", job => job.replace(linuxBuild, linuxBuild.replace("--bins", "--bins --release"))), /Linux binaries must reuse/],
  ])) assert.throws(() => verify({ ci }), error);
});

/** @param {string} job @param {string} name */
const stepText = (job, name) => {
  const text = job.match(new RegExp(`^ {6}- name: ${name}\\n(?: {8}.*\\n)*`, "m"))?.[0];
  assert.ok(text, `Expected step ${name}`);
  return text;
};
/** @param {string} job @param {string} name @param {string} anchor */
const moveStepAfter = (job, name, anchor) => {
  const without = job.replace(stepText(job, name), "");
  return without.replace(stepText(without, anchor), `${stepText(without, anchor)}${stepText(job, name)}`);
};
/** @param {string} job @param {string} name @param {string} lines */
const addToStep = (job, name, lines) => job.replace(`      - name: ${name}\n`, `      - name: ${name}\n${lines}`);
/** @param {string} job @param {string} name @param {string} step */
const insertBefore = (job, name, step) => job.replace(`      - name: ${name}\n`, `${step}      - name: ${name}\n`);

test("binary reuse needs the required all-feature tests first and binaries before their consumers", () => {
  for (const [name, tests, build, beforeTests, cli] of /** @type {[string, string, string, string, string][]} */ ([
    ["rust", "Rust tests", "Build desktop and CLI", "Clippy", "Native CLI with a clean home"],
    ["rust-portability", "Native tests", "Build desktop and CLI", "Lint native code", "Native CLI with a clean home"],
  ])) {
    for (const [change, error] of /** @type {[JobChange, RegExp][]} */ ([
      [job => job.replace("--all-targets --all-features --timings", "--all-targets --timings"), /must follow the required all-feature test build/],
      [job => moveStepAfter(job, build, beforeTests), /must follow the required all-feature test build/],
      [job => addToStep(job, tests, "        continue-on-error: true\n"), /All-feature tests must stay unconditional, required and compile-identical/],
      [job => addToStep(job, tests, "        if: runner.os != 'Linux'\n"), /All-feature tests must stay unconditional, required and compile-identical/],
      [job => job.replace("          AIOLM_CLI_FIXTURE_EVIDENCE:", "          RUSTFLAGS: \"-C debuginfo=2\"\n          AIOLM_CLI_FIXTURE_EVIDENCE:"), /All-feature tests must stay unconditional, required and compile-identical/],
      [job => addToStep(job, build, "        continue-on-error: true\n"), /Binary build must be required and keep the job compiler inputs/],
      [job => addToStep(job, build, "        env:\n          RUSTFLAGS: \"-C debuginfo=2\"\n"), /Binary build must be required and keep the job compiler inputs/],
      [job => addToStep(job, build, "        shell: env CARGO_PROFILE_DEV_DEBUG=2 bash -e {0}\n"), /Binary build must be required and keep the job compiler inputs/],
      [job => insertBefore(job, build, "      - name: Write compiler environment\n        run: echo RUSTFLAGS=-Cdebuginfo=2 >> \"$GITHUB_ENV\"\n"), /Only reviewed run steps may separate/],
      [job => moveStepAfter(job, build, cli), /Binaries must be built before their consumers/],
      [job => insertBefore(job, cli, "      - name: Rebuild CLI\n        run: cargo build --locked --manifest-path src-tauri/Cargo.toml --bin aiolm-cli -F macos-ui-smoke\n"), /Binaries must be built before their consumers/],
    ])) assert.throws(() => verify({ ci: changeCiJob(sources.ci, name, change) }), error, `${name}: ${String(change)}`);
  }
  // The macOS default binaries must also exist before the generated-input observer.
  const ci = changeCiJob(sources.ci, "rust-portability", job => moveStepAfter(job, "Observe generated inputs before the CPU compilation", "Native tests"));
  assert.throws(() => verify({ ci }), /Binaries must be built before their consumers/);
});

test("a Cargo feature or optional dependency outside the reviewed macOS-only set rejects the reuse", () => {
  for (const cargoManifest of [
    sources.cargoManifest.replace("test-fixtures = []\n", "test-fixtures = []\nlinux-extra = []\n"),
    sources.cargoManifest.replace("default = [\"test-fixtures\"]", "default = []"),
  ]) assert.throws(() => verify({ cargoManifest }), /Cargo features changed/);
  const webdriver = 'tauri-plugin-wdio-webdriver = { version = "=1.4.0", optional = true }\n';
  for (const cargoManifest of [
    sources.cargoManifest.replace(webdriver, "").replace("[dependencies]\n", `[dependencies]\n${webdriver}`),
    sources.cargoManifest.replace("[target.'cfg(target_os = \"linux\")'.dependencies]\n", "[target.'cfg(target_os = \"linux\")'.dependencies]\nextra = { version = \"1\", optional = true }\n"),
  ]) assert.throws(() => verify({ cargoManifest }), /only optional, macOS-only dependency/);
  for (const cargoManifest of [
    sources.cargoManifest.replace('[[bin]]\nname = "fake-llama-server"', '[[bin]]\nname = "webdriver-helper"\npath = "src/bin/webdriver-helper.rs"\nrequired-features = ["macos-ui-smoke"]\n\n[[bin]]\nname = "fake-llama-server"'),
    sources.cargoManifest.replace('path = "tests/smoke_fake.rs"\nrequired-features = ["test-fixtures"]', 'path = "tests/smoke_fake.rs"\nrequired-features = [\n  "test-fixtures",\n  "macos-ui-smoke",\n]'),
    `${sources.cargoManifest}\n[target.'cfg(feature = "macos-ui-smoke")'.dependencies]\n`,
  ]) assert.throws(() => verify({ cargoManifest }), /Only the reviewed feature entry may name macos-ui-smoke/);
});

test("WebDriver feature code must remain inside an all(..., target_os = macOS) gate", () => {
  for (const line of [
    'src-tauri/src/lib.rs:1: #[cfg(feature = "macos-ui-smoke")]',
    'src-tauri/src/lib.rs:1: #[cfg(all(any(windows, target_os = "macos"), feature = "macos-ui-smoke"))]',
    'src-tauri/src/lib.rs:1: #[cfg(all(not(target_os = "macos"), feature = "macos-ui-smoke"))]',
    'src-tauri/src/lib.rs:1:     if cfg!(feature = "macos-ui-smoke") { register(); }',
    'src-tauri/build.rs:1:     if std::env::var_os("CARGO_FEATURE_MACOS_UI_SMOKE").is_some() {}',
    // rustc accepts whitespace before the parenthesis of a nested predicate.
    'src-tauri/src/lib.rs:1: #[cfg(all(any (unix, target_os = "macos"), feature = "macos-ui-smoke"))]',
    'src-tauri/src/lib.rs:1: #[cfg(all(not (windows), target_os = "macos", feature = "macos-ui-smoke"))]',
    // A trailing comment or code must not make an ungated use look gated.
    'src-tauri/src/lib.rs:1:   if cfg!(feature = "macos-ui-smoke") { register(); } // #[cfg(all(target_os = "macos"))]',
    'src-tauri/src/lib.rs:1: #[cfg(all(target_os = "macos", feature = "macos-ui-smoke"))] fn a() {} #[cfg(feature = "macos-ui-smoke")] fn b() {}',
    'src-tauri/src/lib.rs:1: #[cfg_attr(all(target_os = "macos", feature = "macos-ui-smoke"), allow(dead_code))]',
    // An attribute split across lines is not interpreted.
    'src-tauri/src/lib.rs:2:     feature = "macos-ui-smoke",',
    'src-tauri/src/lib.rs:1: // macos-ui-smoke is reviewed',
  ]) assert.throws(() => verify({ featureUses: `${sources.featureUses}\n${line}` }), /macos-ui-smoke must stay gated to macOS/);
});

test("the source reader finds feature uses in nested modules, tests, examples and benches", () => {
  const root = mkdtempSync(join(tmpdir(), "aiolm-ci-contract-"));
  try {
    const repository = join(dirname(fileURLToPath(import.meta.url)), "..");
    for (const path of [".github/workflows/ci.yml", ".github/workflows/release.yml", ".github/workflows/desktop-packages.yml", "rust-toolchain.toml", "src-tauri/Cargo.toml", "src-tauri/build.rs"]) {
      mkdirSync(dirname(join(root, path)), { recursive: true });
      copyFileSync(join(repository, path), join(root, path));
    }
    mkdirSync(join(root, "src-tauri/src/nested"), { recursive: true });
    writeFileSync(join(root, "src-tauri/src/lib.rs"), "pub mod nested;\n");
    writeFileSync(join(root, "src-tauri/src/nested/mod.rs"), '#[cfg(all(target_os = "macos", feature = "macos-ui-smoke"))]\npub fn gated() {}\n');
    assert.deepEqual(verifyCiWorkflowContracts(readCiWorkflowSources(root)), verify());
    writeFileSync(join(root, "src-tauri/src/nested/mod.rs"), '#[cfg(feature = "macos-ui-smoke")]\npub fn ungated() {}\n');
    assert.throws(() => verifyCiWorkflowContracts(readCiWorkflowSources(root)), /must stay gated to macOS: src-tauri\/src\/nested\/mod\.rs:1:/);
    writeFileSync(join(root, "src-tauri/src/nested/mod.rs"), "pub fn plain() {}\n");
    // Integration tests, examples and benches are compiled by the all-target tests too.
    for (const path of ["tests/support/mod.rs", "examples/probe.rs", "benches/startup.rs"]) {
      mkdirSync(dirname(join(root, "src-tauri", path)), { recursive: true });
      writeFileSync(join(root, "src-tauri", path), '#[cfg(feature = "macos-ui-smoke")]\nfn ungated() {}\n');
      assert.throws(() => verifyCiWorkflowContracts(readCiWorkflowSources(root)), new RegExp(`must stay gated to macOS: src-tauri/${path}:1:`));
      rmSync(join(root, "src-tauri", path));
    }
    assert.deepEqual(verifyCiWorkflowContracts(readCiWorkflowSources(root)), verify());
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("platform-independent frontend gates run once and native jobs consume their dist", () => {
  const checksSource = sources.ci.split("  frontend-checks:\n")[1];
  assert.ok(checksSource);
  const checks = checksSource.split("  frontend-plan:\n")[0];
  assert.ok(checks);
  assert.match(checks, /runs-on: ubuntu-24\.04/);
  assert.doesNotMatch(checks, /matrix:/);
  for (const command of ["lint", "typecheck", "test:checks", "build"]) {
    assert.equal([...sources.ci.matchAll(new RegExp(`^ +npm run ${command}$`, "gm"))].length
      + [...sources.ci.matchAll(new RegExp(`^ +run: npm run ${command}$`, "gm"))].length, 1, command);
  }
  assert.match(checks, /npm audit --omit=dev --audit-level=high/);
  assert.match(checks, /npm audit --audit-level=high/);
  assert.match(checks, /cargo install cargo-audit --version \d+\.\d+\.\d+ --locked/);
  assert.match(checks, /cargo audit --file src-tauri\/Cargo\.lock/);
  assert.match(checks, /python3 -B -m unittest discover -s scripts\/runtime-adapters -p 'test_\*\.py'/);
  assert.match(checks, /python3 -B src-tauri\/src\/providers\/portable_python_tests\.py/);
  const macSource = sources.ci.split("  macos-default:\n")[1];
  assert.ok(macSource);
  const mac = macSource.split("  native:\n")[0];
  assert.ok(mac);
  assert.doesNotMatch(mac, /npm ci|npm rebuild|npm install|components: rustfmt, clippy/);
  assert.doesNotMatch(sources.release, /components: rustfmt, clippy/);
});

test("workflows discard checkout credentials and scope publication and concurrency", () => {
  const directory = new URL("../.github/workflows/", import.meta.url);
  const workflows = Object.fromEntries(readdirSync(directory).filter(file => /\.ya?ml$/.test(file))
    .map(file => [file, readFileSync(new URL(file, directory), "utf8").replace(/\r\n/g, "\n")]));
  for (const [file, source] of Object.entries(workflows)) {
    for (const block of source.split(/^ {6}- /m).filter(block => /uses: actions\/checkout@/.test(block))) {
      assert.match(block, /persist-credentials: false/, file);
    }
  }
  assert.ok(workflows["linux-desktop-acceptance.yml"]);
  assert.ok(workflows["pr-runtime.yml"]);
  assert.match(workflows["linux-desktop-acceptance.yml"], /cancel-in-progress: \$\{\{ github\.event_name == 'pull_request' \}\}/);
  assert.match(workflows["pr-runtime.yml"], /group: pr-runtime-\$\{\{ inputs\.pull_request \}\}\n {2}cancel-in-progress: false/);
  assert.match(workflows["pr-runtime.yml"], /target_commitish: \$\{\{ github\.ref_name \}\}/);
  assert.match(workflows["pr-runtime.yml"], /overwrite_files: false/);
  const releaseAction = sources.release.match(/uses: (softprops\/action-gh-release@\w+)/)?.[1];
  assert.ok(releaseAction);
  assert.ok(workflows["pr-runtime.yml"].includes(`uses: ${releaseAction}`));
  const packages = workflows["desktop-packages.yml"];
  assert.ok(packages);
  const packageHeader = packages.split("jobs:\n")[0];
  const installJob = packages.split("  install:\n")[1];
  assert.ok(packageHeader);
  assert.ok(installJob);
  assert.doesNotMatch(packageHeader, /actions: read/);
  assert.match(installJob, /permissions:\n {6}contents: read\n {6}actions: read/);
});
