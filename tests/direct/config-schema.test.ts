// @vitest-environment node
import { expectTypeOf, test } from "vitest";
import type { AppConfig } from "../../src/shared/api/types.ts";
import configKeys from "./app-config-keys.json";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

test("serialized Rust config keys match the TypeScript config contract", () => {
  expectTypeOf<keyof typeof configKeys>().toEqualTypeOf<keyof AppConfig>();
});

test("desktop CSP permits local session ports without remote or arbitrary origins", () => {
  for (const filename of ["tauri.conf.json", "tauri-cli-build.conf.json"]) {
    const config: unknown = JSON.parse(readFileSync(new URL(`../../src-tauri/${filename}`, import.meta.url), "utf8"));
    assert.ok(config && typeof config === "object" && "app" in config);
    const app = config.app;
    assert.ok(app && typeof app === "object" && "security" in app);
    const security = app.security;
    assert.ok(security && typeof security === "object" && "csp" in security);
    assert.ok(typeof security.csp === "string");
    const connect = security.csp.split(";").find(part => part.trim().startsWith("connect-src "));
    assert.ok(connect?.includes("http://127.0.0.1:*"), `${filename} must allow custom local session ports`);
    assert.ok(connect?.includes("http://localhost:*"), `${filename} must allow localhost session ports`);
    assert.ok(!connect?.split(/\s+/).includes("*"), `${filename} must not permit arbitrary origins`);
    // Remote services (GitHub, Hugging Face, benchmark sharing) are reached only through Rust IPC.
    assert.deepEqual(connect?.split(/\s+/).filter((source: string) => source.startsWith("https:")), [], `${filename} must not permit remote origins`);
  }
});
