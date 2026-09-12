import { describe, expect, it } from "vitest";
import { modelDisplayName } from "./displayPaths";

const qwen = "Qwen3.8-Flash-Next-AD-4.27bpw-Q4_K_M-M64";

describe("modelDisplayName", () => {
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
});
