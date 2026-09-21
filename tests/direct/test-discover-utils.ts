import assert from "node:assert/strict";
import { estimateDownloadSpeed, formatBytes, formatSpeedBps, isGgufPath, isMmprojPath, markInstalled, quantLabel, shardTotal, validateHfRepoId, validateHfPath } from "../../src/features/discover/discoverUtils.ts";

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
// Every byte count the app reports is binary, so the labels are binary too.
assert.equal(formatBytes(512), "512 B");
assert.equal(formatBytes(1024), "1.0 KiB");
assert.equal(formatBytes(1024 * 1024), "1.0 MiB");
assert.equal(formatBytes(1024 * 1024 * 1024), "1.00 GiB");
assert.equal(formatBytes(3 * 1024 ** 4), "3.00 TiB");
assert.equal(formatBytes(-1), "unknown size");
assert.equal(formatSpeedBps(1536), "1.5 KiB/s");
assert.equal(formatSpeedBps(Number.NaN), "unknown speed");
assert.equal(estimateDownloadSpeed([]), null);
assert.equal(estimateDownloadSpeed([{ received: 0, at: 1000 }]), null);
assert.equal(estimateDownloadSpeed([{ received: 0, at: 1000 }, { received: 1000, at: 1100 }]), null);
assert.equal(
  estimateDownloadSpeed([{ received: 0, at: 1000 }, { received: 2 * 1024 * 1024, at: 3000 }]),
  1024 * 1024,
);
assert.equal(shardTotal("big-00001-of-00003.gguf"), 3);
assert.equal(shardTotal("model.gguf"), null);
assert.equal(shardTotal("big-00001-of-00001.gguf"), null);

// A finished download marks its own row installed and strikes itself from the
// parts its siblings are still waiting on.
const beforeDownload = {
  "big-00001-of-00003.gguf": {
    path: "big-00001-of-00003.gguf",
    local_path: "/models/hf/owner/model/big-00001-of-00003.gguf",
    size_bytes: 10,
    missing_shards: ["big-00002-of-00003.gguf", "big-00003-of-00003.gguf"],
  },
};
const afterDownload = markInstalled(
  beforeDownload,
  "big-00002-of-00003.gguf",
  "/models/hf/owner/model/big-00002-of-00003.gguf",
  20,
);
assert.deepEqual(afterDownload["big-00001-of-00003.gguf"].missing_shards, ["big-00003-of-00003.gguf"]);
assert.deepEqual(afterDownload["big-00002-of-00003.gguf"], {
  path: "big-00002-of-00003.gguf",
  local_path: "/models/hf/owner/model/big-00002-of-00003.gguf",
  size_bytes: 20,
  missing_shards: ["big-00003-of-00003.gguf"],
});
assert.deepEqual(beforeDownload["big-00001-of-00003.gguf"].missing_shards, ["big-00002-of-00003.gguf", "big-00003-of-00003.gguf"]);
assert.deepEqual(markInstalled({}, "solo.gguf", "/models/hf/owner/model/solo.gguf", 5)["solo.gguf"].missing_shards, []);

console.log("discover utility tests passed");
