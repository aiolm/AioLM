import assert from "node:assert/strict";
import { storageSchema } from "../../src/shared/storage/storageAdapter.ts";

assert.deepEqual(storageSchema(), { name: "aiolm-storage", version: 1, store: "values" });
console.log("storage schema validation passed");
