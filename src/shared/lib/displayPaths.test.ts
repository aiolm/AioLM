// @vitest-environment node
import { describe, expect, it } from "vitest";
import { formatModelLabel, formatModelShardPart, isModelFilePath, modelDisplayName, normalizeDisplayPath, parseModelShardSuffix, restoreDisplayPath, stripModelShardSuffix, stripWindowsVerbatimPrefixArg } from "./displayPaths";

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
    ["org/model-0001-of-0004.gguf", "org/model.gguf"],
    ["org/model-0004-of-0004.safetensors", "org/model.safetensors"],
    ["model-0002-of-0004", "model"],
    ["variants · 4bit/model-0001-of-0002.safetensors", "variants · 4bit/model.safetensors"],
    ["org/model", "org/model"],
    ["org/model.gguf", "org/model.gguf"],
    ["org/model-00000-of-00004.gguf", "org/model-00000-of-00004.gguf"],
    ["org/model-00005-of-00004.gguf", "org/model-00005-of-00004.gguf"],
    ["org/model-00001-of-00001.gguf", "org/model-00001-of-00001.gguf"],
    ["org/model-0001-of-0001.gguf", "org/model-0001-of-0001.gguf"],
    ["org/model-00001-of-0004.gguf", "org/model-00001-of-0004.gguf"],
    ["org/model-00001-OF-00004.gguf", "org/model-00001-OF-00004.gguf"],
    ["org/model-1-of-4.gguf", "org/model-1-of-4.gguf"],
    ["org/model-00001-of-00004.bin", "org/model-00001-of-00004.bin"],
    ["org/model-00001-of-00004.gguf-extra", "org/model-00001-of-00004.gguf-extra"],
    ["org/-00001-of-00004.gguf", "org/-00001-of-00004.gguf"],
  ])("groups only valid shard suffixes without shortening model IDs: %s", (value, expected) => {
    expect(stripModelShardSuffix(value)).toBe(expected);
  });
});

describe("shared model labels", () => {
  it.each([
    ["C:\\models\\Qwen-Q4_K_M-0001-of-0004.gguf", "Qwen-Q4_K_M.gguf"],
    ["/models/Qwen-Q4_K_M-00001-of-00004.gguf", "Qwen-Q4_K_M.gguf"],
    ["/models/model-0001-of-0003.safetensors", "model.safetensors"],
    ["variants · 4bit/model-0001-of-0002.safetensors", "variants · 4bit/model.safetensors"],
    ["variants · 4bit/model.safetensors", "variants · 4bit/model.safetensors"],
  ])("names %s the same way as the native side", (value, expected) => {
    expect(modelDisplayName(value)).toBe(expected);
    expect(formatModelLabel(value)).toBe(expected);
  });

  it.each([
    ["Q4/model-00001-of-00002.gguf", "Q4/model.gguf"],
    [`hf/owner/gemma/snapshots/${"a".repeat(40)}`, "gemma"],
    ["openai/whisper-large-v3", "openai/whisper-large-v3"],
    ["llama.cpp · ROCm (AMD) · b11029", "llama.cpp · ROCm (AMD) · b11029"],
    ["AioLM 1.2.0", "AioLM 1.2.0"],
    ["\\\\?\\C:\\models\\a-0001-of-0002.gguf", "a.gguf"],
  ])("shortens explicit paths only and groups parts in %s", (value, expected) => {
    expect(formatModelLabel(value)).toBe(expected);
  });

  it("parses part syntax with the width the repository used", () => {
    const four = parseModelShardSuffix("m-0002-of-0010.gguf")!;
    expect(four).toMatchObject({ base: "m", index: 2, total: 10, width: 4, extension: "gguf" });
    expect(formatModelShardPart(four, 10)).toBe("m-0010-of-0010.gguf");
    const five = parseModelShardSuffix("m-00002-of-00010")!;
    expect(formatModelShardPart(five, 1)).toBe("m-00001-of-00010");
    expect(parseModelShardSuffix("m-0002-of-0010.safetensors", { extensions: ["gguf"] })).toBeNull();
    expect(parseModelShardSuffix("m-0002-of-0010", { allowExtensionless: false })).toBeNull();
    expect(parseModelShardSuffix("m-0002-of-0010.SAFETENSORS", { exactExtensionCase: true })).toBeNull();
  });
});

describe("stripWindowsVerbatimPrefixArg", () => {
  it.each([
    ["\\\\?\\C:\\한글 모델\\sub dir\\weights.gguf", "C:\\한글 모델\\sub dir\\weights.gguf"],
    ["\\\\?\\D:/models/draft model.gguf", "D:/models/draft model.gguf"],
    ["\\\\?\\UNC\\server\\share\\한글 폴더\\mmproj.gguf", "\\\\server\\share\\한글 폴더\\mmproj.gguf"],
    ["\\\\?\\unc\\fileserver\\models\\mtp-draft.gguf", "\\\\fileserver\\models\\mtp-draft.gguf"],
    ["--model=\\\\?\\C:\\한글 모델\\model.gguf", "--model=C:\\한글 모델\\model.gguf"],
    ["--mmproj=\\\\?\\UNC\\server\\share\\mmproj.gguf", "--mmproj=\\\\server\\share\\mmproj.gguf"],
    ["-md=\\\\?\\unc\\nas\\models\\draft.gguf", "-md=\\\\nas\\models\\draft.gguf"],
  ])("strips Windows verbatim prefix in arg token %s", (value, expected) => {
    expect(stripWindowsVerbatimPrefixArg(value)).toBe(expected);
  });

  it.each([
    "C:\\models\\ordinary.gguf",
    "\\\\server\\share\\ordinary.gguf",
    "/synthetic/models/model.gguf",
    "https://example.invalid/models?v=1",
    "\\\\?\\Volume{01234567-89ab-cdef-0123-456789abcdef}\\models\\a.gguf",
    "\\\\?\\Global\\PIPE\\synthetic",
    "\\\\?\\한글",
    "--literal=http://example.invalid?x=1",
    "\\\\?\\UNC\\",
  ])("leaves non-drive/device/URL token untouched: %s", (value) => {
    expect(stripWindowsVerbatimPrefixArg(value)).toBe(value);
  });
});
