// @vitest-environment node
import { test } from "vitest";
import assert from "node:assert/strict";
import { storageSchema } from "../../src/shared/storage/storageAdapter.ts";

test("storage contracts", async () => {
  assert.deepEqual(storageSchema(), { name: "aiolm-storage", version: 1, store: "values" });
});
