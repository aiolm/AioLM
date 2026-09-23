import { describe, expect, it } from "vitest";
import { modelIconName } from "./ModelIcon";
import ModelIcon from "./ModelIcon";
import { render } from "@testing-library/react";

describe("model family icons", () => {
  it("keeps icons decorative and updates them when the selected model changes", () => {
    const { container, rerender } = render(<ModelIcon model="Qwen3-8B.gguf" />);
    expect(container.querySelector('img')).toHaveAttribute('src', '/model-icons/qwen.svg');
    expect(container.querySelector('img')).toHaveAttribute('alt', '');
    rerender(<ModelIcon model="gemma-3-4b.gguf" />);
    expect(container.querySelector('img')).toHaveAttribute('src', '/model-icons/gemma.svg');
    rerender(<ModelIcon model="" />);
    expect(container.querySelector('img')).toBeNull();
  });
  it.each([
    ["community/Qwen3-8B-GGUF", "qwen"],
    ["community/gemma-3-4b-it-GGUF", "gemma"],
    ["community/EmbeddingGemma-300m", "gemma"],
    ["community/DeepSeek-R1-GGUF", "deepseek"],
    ["community/Devstral-GGUF", "mistral"],
    ["community/Llama-3-GGUF", "meta"],
    ["community/GLM-4-GGUF", "chatglm"],
    ["Qwen/gemma-3-GGUF", "gemma"],
    ["community/unknown", "huggingface"],
    ["C:\\models\\Qwen3-8B-Q4_K_M.gguf", "qwen"],
    ["/models/gemma/gemma-3-4b.gguf", "gemma"],
    ["/models/qwen/unknown.gguf", "huggingface"],
    ["Qwen/unknown.gguf", "huggingface"],
    ["Qwen/QwQ-32B", "qwen"],
  ])("identifies %s", (id, expected) => {
    expect(modelIconName(id)).toBe(expected);
  });
});
