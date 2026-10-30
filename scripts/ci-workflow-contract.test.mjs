import assert from "node:assert/strict";
import test from "node:test";
import { readCiWorkflowSources, verifyCiWorkflowContracts } from "./ci-workflow-contract.mjs";

// Windows checks out YAML with CRLF. Use one canonical mutation fixture so a
// literal replacement always changes the intended input on every host.
const sources = Object.fromEntries(Object.entries(readCiWorkflowSources()).map(([key, source]) => [key, source.replace(/\r\n/g, "\n")]));
const verify = patch => {
  for (const [key, source] of Object.entries(patch ?? {})) {
    assert.notEqual(source, sources[key], `Expected mutation of ${key} to change the fixture`);
  }
  return verifyCiWorkflowContracts({ ...sources, ...patch });
};
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
    const variant = Object.fromEntries(Object.entries(sources).map(([key, source]) => [key, source.replace(/\n/g, newline)]));
    assert.deepEqual(verifyCiWorkflowContracts(variant), verify());
    const packages = variant.packages.replace(/ {6}RUST_BACKTRACE: "1"\r?\n/, "");
    assert.notEqual(packages, variant.packages, "Expected backtrace removal in either line-ending format");
    assert.throws(() => verifyCiWorkflowContracts({ ...variant, packages }), /Cache environment differs between package jobs/);
    const ci = changeCiJob(sources.ci, "rust", job => job.replace("        run: npm run build", "        if: runner.os == 'macOS'\n        run: npm run build")).replace(/\n/g, newline);
    assert.notEqual(ci, variant.ci, "Expected conditional frontend mutation in either line-ending format");
    assert.throws(() => verifyCiWorkflowContracts({ ...variant, ci }), /Frontend build must be unconditional and required/);
  }
});

test("native verification builds frontend once and requires success before its first Cargo compile", () => {
  for (const name of ["rust", "rust-portability"]) {
    for (const change of [
      job => job.replace("        run: npm run build", "        run: npm run build:contracts"),
      job => job.replace("        run: npm run build", "        if: runner.os == 'macOS'\n        run: npm run build"),
      job => job.replace("        run: npm run build", "        continue-on-error: true\n        run: npm run build"),
      job => job.replace("        run: npm run build", "        run: npm run build\n      - run: npm run build"),
      job => {
        const build = job.match(/^ {6}- name: .*\n {8}run: npm run build\n/m)?.[0];
        assert.ok(build, "Expected frontend step to relocate");
        return job.replace(build, "").replace(/^( {8}run: cargo clippy[^\n]*\n)/m, `$1${build}`);
      },
    ]) assert.throws(() => verify({ ci: changeCiJob(sources.ci, name, change) }), /Frontend build must/);
  }
});

test("the default-feature Mac helper never regenerates frontend inputs", () => {
  const ci = changeCiJob(sources.ci, "macos-default", job => job.replace("      - name: Default-feature native tests", "      - run: npm run build\n      - name: Default-feature native tests"));
  assert.throws(() => verify({ ci }), /Mac default helper must not rebuild frontend inputs/);
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
  for (const [before, after] of [
    ['shared-key: "package-', 'shared-key: "verify-'],
    ["          cache-bin: false", "          cache-bin: true"],
    ["          cache-bin: false", "          cache-bin: false\n          cache-workspace-crates: true"],
    ["Swatinem/rust-cache@d1527c8f67ef9af357290475d4af4b0fab8f12e0", "Swatinem/rust-cache@v2"],
  ]) assert.throws(() => verify({ packages: sources.packages.replace(before, after) }), /cache recipe|Unreviewed/);
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
