import assert from "node:assert/strict";
import test from "node:test";
import { readCiWorkflowSources, verifyCiWorkflowContracts } from "./ci-workflow-contract.mjs";

const sources = readCiWorkflowSources();
const verify = patch => verifyCiWorkflowContracts({ ...sources, ...patch });

test("all seven cached jobs preserve compiler isolation, cache purposes and matching effective environments", () => {
  assert.deepEqual(verify(), { guardedJobs: 7, rustPin: "1.98.0" });
});

test("the historical release/package backtrace mismatch is rejected", () => {
  assert.throws(() => verify({ packages: sources.packages.replace('      RUST_BACKTRACE: "1"\n', "") }), /Cache environment differs between package jobs/);
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
