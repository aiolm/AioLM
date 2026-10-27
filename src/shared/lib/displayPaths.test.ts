import { describe, expect, it } from "vitest";
import { isModelFilePath, modelDisplayName } from "./displayPaths";

const qwen = "Qwen3.8-Flash-Next-AD-4.27bpw-Q4_K_M-M64";

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
