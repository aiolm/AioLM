import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { URL } from "node:url";
import { bundleTargets, packagingArgs } from "./package-tauri.mjs";

test("desktop packaging selects formats that the host can build", () => {
  assert.equal(bundleTargets("win32"), "nsis,msi");
  assert.equal(bundleTargets("linux"), "deb,appimage");
  assert.equal(bundleTargets("darwin"), "app,dmg");
  assert.throws(() => bundleTargets("freebsd"), /not supported/);
  assert.deepEqual(packagingArgs("linux"), [
    "build", "--config", "src-tauri/tauri-package.conf.json", "--bundles", "deb,appimage",
    "--", "--no-default-features",
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
    assert.deepEqual(packagingArgs(platform).slice(-2), ["--", "--no-default-features"]);
  }
});

test("direct Tauri builds use host formats and CLI builds never bundle", () => {
  const read = (name) => JSON.parse(readFileSync(new URL(`../src-tauri/${name}`, import.meta.url), "utf8"));
  assert.equal(read("tauri.conf.json").bundle.targets, "all");
  assert.equal(read("tauri-cli-build.conf.json").bundle.active, false);
});
