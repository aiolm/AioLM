// @vitest-environment node
import { describe, expect, it } from "vitest";
import { isModelFilePath, modelDisplayName, normalizeDisplayPath, restoreDisplayPath, stripModelShardSuffix } from "./displayPaths";

const qwen = "Qwen3.8-Flash-Next-AD-4.27bpw-Q4_K_M-M64";

describe("normalizeDisplayPath", () => {
  it.each([
    ["C:\\models\\hf/owner/model/model.gguf", "C:\\models\\hf\\owner\\model\\model.gguf"],
    ["D:/documents/two.txt", "D:\\documents\\two.txt"],
    ["\\\\?\\C:\\runtime\\lib/x64\\cudart.dll", "C:\\runtime\\lib\\x64\\cudart.dll"],
    ["\\\\?\\UNC\\server\\share\\models/a.gguf", "\\\\server\\share\\models\\a.gguf"],
    ["\\\\server\\share/models/a.gguf", "\\\\server\\share\\models\\a.gguf"],
  ])("shows one separator in Windows path %s", (value, expected) => {
    expect(normalizeDisplayPath(value)).toBe(expected);
  });

  it.each([
    "/synthetic/models/hf/owner/model.gguf",
    "//host/share/model.gguf",
    "owner/model",
    "hf/owner/model",
    "https://example.invalid/models/a.gguf",
    "native-speech-model",
  ])("keeps the forward slashes of POSIX paths, URLs and model IDs: %s", value => {
    expect(normalizeDisplayPath(value)).toBe(value);
  });

  it("keeps a stored mixed-separator path when the shown text is not edited", () => {
    const stored = "C:/models/hf/owner/model.gguf";
    expect(restoreDisplayPath(stored, normalizeDisplayPath(stored))).toBe(stored);
  });
});

describe("modelDisplayName", () => {
  it.each([
    ['/synthetic/cache/models--example--Qwen-model/snapshots/' + 'a'.repeat(40), 'Qwen-model'],
    ['C:\\cache\\models--example--model--variant\\snapshots\\' + 'b'.repeat(40) + '\\', 'model--variant'],
    ['/synthetic/library/hf/example/gemma-model/snapshots/' + 'c'.repeat(40), 'gemma-model'],
    ['/synthetic/models--example--Qwen-model/snapshots/not-a-revision', 'not-a-revision'],
    ['/synthetic/ordinary/snapshots/' + 'a'.repeat(40), 'a'.repeat(40)],
    ['/synthetic/cache/models--example--Qwen-model/snapshots/' + 'a'.repeat(40) + '/unknown.gguf', 'unknown.gguf'],
    ['/synthetic/models/plain-model/', 'plain-model'],
  ])('names immutable snapshots without mistaking local files or arbitrary directories for repositories: %s', (value, expected) => {
    expect(modelDisplayName(value)).toBe(expected);
  });
  it.each([
    [`${qwen}-00001-of-00033`, qwen],
    [`C:\\models\\${qwen}-00001-of-00033.gguf`, `${qwen}.gguf`],
    [`/models/${qwen}-00033-of-00033.gguf`, `${qwen}.gguf`],
    [`\\\\?\\UNC\\server\\models\\${qwen}-00001-of-00033.GGUF`, `${qwen}.GGUF`],
  ])("groups the model label for %s", (value, expected) => {
    expect(modelDisplayName(value)).toBe(expected);
  });

  it.each([
    qwen, `${qwen}.gguf`, "model-00001-of-00001.gguf", "model-00000-of-00033.gguf",
    "model-00034-of-00033.gguf", "model-1-of-33.gguf", "model-00001-of-00033.txt", "",
  ])("preserves ordinary names and non-shard suffixes: %s", value => {
    expect(modelDisplayName(value)).toBe(value);
  });

  it.each([
    ["C:/models/whisper-large-v3.gguf", true],
    ["C:\\models\\whisper-large-v3.bin", true],
    ["/synthetic/models/whisper-large-v3", true],
    ["./models/voice.custom", true],
    ["models/whisper-large-v3.gguf", false],
    ["native-speech-model", false],
    ["openai/whisper-large-v3", false],
    ["Systran/faster-whisper-large-v3", false],
    ["acme/voice.gguf", false],
    ["acme/voice.bin", false],
    ["https://example.invalid/models/voice.bin", false],
  ])("recognizes explicit path syntax without guessing native model IDs: %s", (value, expected) => {
    expect(isModelFilePath(value)).toBe(expected);
  });
});

describe("stripModelShardSuffix", () => {
  it.each([
    ["org/model-00001-of-00004.gguf", "org/model.gguf"],
    ["org/model-00004-of-00004.GGUF", "org/model.GGUF"],
    ["model-00001-of-00004", "model"],
    ["org/model", "org/model"],
    ["org/model.gguf", "org/model.gguf"],
    ["org/model-00000-of-00004.gguf", "org/model-00000-of-00004.gguf"],
    ["org/model-00005-of-00004.gguf", "org/model-00005-of-00004.gguf"],
    ["org/model-00001-of-00001.gguf", "org/model-00001-of-00001.gguf"],
    ["org/model-1-of-4.gguf", "org/model-1-of-4.gguf"],
    ["org/model-00001-of-00004.bin", "org/model-00001-of-00004.bin"],
    ["org/model-00001-of-00004.gguf-extra", "org/model-00001-of-00004.gguf-extra"],
  ])("groups only valid shard suffixes without shortening model IDs: %s", (value, expected) => {
    expect(stripModelShardSuffix(value)).toBe(expected);
  });
});
