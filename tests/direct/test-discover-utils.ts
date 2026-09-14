import assert from "node:assert/strict";
import { estimateDownloadSpeed, formatBytes, formatSpeedBps, isGgufPath, isMmprojPath, quantLabel, validateHfRepoId, validateHfPath } from "../../src/features/discover/discoverUtils.ts";

assert.equal(validateHfRepoId("bartowski/Llama-3.2-3B-Instruct-GGUF"), true);
assert.equal(validateHfRepoId("https://huggingface.co/foo/bar"), false);
assert.equal(validateHfRepoId("foo/../bar"), false);
assert.equal(validateHfPath("Q4_K_M/model.gguf"), true);
assert.equal(validateHfPath("../model.gguf"), false);
assert.equal(validateHfPath("Q4_K_M\\model.gguf"), false);
assert.equal(isGgufPath("Q4_K_M/model.gguf"), true);
assert.equal(isGgufPath("README.md"), false);
assert.equal(isMmprojPath("mmproj-model-f16.gguf"), true);
assert.equal(quantLabel("Llama-3.2-3B-Q4_K_M.gguf"), "Q4_K_M");
assert.equal(formatBytes(1024 * 1024 * 1024), "1.00 GB");
assert.equal(formatSpeedBps(1536), "1.5 KB/s");
assert.equal(formatSpeedBps(Number.NaN), "unknown speed");
assert.equal(estimateDownloadSpeed([]), null);
assert.equal(estimateDownloadSpeed([{ received: 0, at: 1000 }]), null);
assert.equal(estimateDownloadSpeed([{ received: 0, at: 1000 }, { received: 1000, at: 1100 }]), null);
assert.equal(
  estimateDownloadSpeed([{ received: 0, at: 1000 }, { received: 2 * 1024 * 1024, at: 3000 }]),
  1024 * 1024,
);
console.log("discover utility tests passed");
