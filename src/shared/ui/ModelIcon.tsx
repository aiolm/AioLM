const families: Array<[RegExp, string]> = [
  [/(?:^|[^a-z])qwen/i, "qwen"],
  [/(?:^|[^a-z])(?:embedding)?gemma/i, "gemma"],
  [/(?:^|[^a-z])deepseek/i, "deepseek"],
  [/(?:^|[^a-z])(?:mistral|mixtral|ministral|magistral|devstral|codestral)/i, "mistral"],
  [/(?:^|[^a-z])llama/i, "meta"],
  [/(?:^|[^a-z])(?:chat)?glm/i, "chatglm"],
];

export function modelIconName(model: string): string {
  // Directory names must not override the family of a local model file.
  const parts = model.replace(/\\/g, "/").split("/").filter(Boolean);
  const name = parts.at(-1) ?? "";
  const owner = parts.length === 2 && !/\.gguf$/i.test(name) ? parts[0] : "";
  return families.find(([pattern]) => pattern.test(name))?.[1]
    ?? families.find(([pattern]) => pattern.test(owner))?.[1]
    ?? "huggingface";
}

export default function ModelIcon({ model, size = 20 }: { model: string; size?: 20 | 32 }) {
  if (!model.trim()) return null;
  return <img src={`/model-icons/${modelIconName(model)}.svg`} alt="" aria-hidden="true"
    width={size} height={size} className="model-family-icon" />;
}
