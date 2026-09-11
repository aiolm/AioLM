import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const rust = readFileSync(new URL("../../src-tauri/src/config.rs", import.meta.url), "utf8");
const ts = readFileSync(new URL("../../src/shared/api/types.ts", import.meta.url), "utf8");
const rustBlock = rust.match(/pub struct AppConfig \{([\s\S]*?)\n\}/)?.[1] ?? "";
const tsBlock = ts.match(/export interface AppConfig \{([\s\S]*?)\n\}/)?.[1] ?? "";
const rustFields = [...rustBlock.matchAll(/^\s*pub ([a-z_][a-z0-9_]*):/gm)].map((match) => match[1]).sort();
const tsFields = [...tsBlock.matchAll(/^\s*([a-z_][a-z0-9_]*)(?:\?)?:/gm)].map((match) => match[1]).sort();

assert.ok(rustFields.length > 0, "Rust AppConfig schema was not found");
assert.ok(tsFields.length > 0, "TypeScript AppConfig schema was not found");
assert.deepEqual(tsFields, rustFields, "Rust and TypeScript AppConfig fields drifted");
console.log(`config schema parity passed (${rustFields.length} fields)`);

for (const filename of ["tauri.conf.json", "tauri-cli-build.conf.json"]) {
  const config = JSON.parse(readFileSync(new URL(`../../src-tauri/${filename}`, import.meta.url), "utf8"));
  const connect = config.app.security.csp.split(";").find((part: string) => part.trim().startsWith("connect-src "));
  assert.ok(connect?.includes("http://127.0.0.1:*"), `${filename} must allow custom local session ports`);
  assert.ok(connect?.includes("http://localhost:*"), `${filename} must allow localhost session ports`);
  assert.ok(!connect?.split(/\s+/).includes("*"), `${filename} must not permit arbitrary origins`);
}
