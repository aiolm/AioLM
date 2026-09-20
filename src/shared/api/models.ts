import { readBoundedResponseText } from "./http.ts";
import { trackInitialRead } from "../ui/initialLayout.ts";
import type { LocalModelInfo, ServerLoraAdapter } from "./types.ts";

export const localModels = (baseUrl: string, apiKey: string) => trackInitialRead(() => readLocalModels(baseUrl, apiKey));
async function readLocalModels(baseUrl: string, apiKey: string): Promise<LocalModelInfo[]> {
  if (!baseUrl || !apiKey) throw new Error("The local server is not ready.");
  const url = baseUrl.replace(/\/v1\/?$/, "") + "/v1/models";
  const response = await fetch(url, { headers: { Authorization: `Bearer ${apiKey}` } });
  const body = await readBoundedResponseText(response);
  if (!response.ok) throw new Error(`HTTP ${response.status}: ${body.slice(0, 500)}`);
  const parsed = JSON.parse(body) as { data?: LocalModelInfo[] };
  return Array.isArray(parsed.data) ? parsed.data : [];
}

export const nativeModels = (baseUrl: string, apiKey: string) => trackInitialRead(() => readNativeModels(baseUrl, apiKey));
async function readNativeModels(baseUrl: string, apiKey: string): Promise<LocalModelInfo[]> {
  if (!baseUrl || !apiKey) throw new Error("The local server is not ready.");
  const response = await fetch(`${baseUrl.replace(/\/+$/, "").replace(/\/v1$/, "")}/api/v1/models`, {
    headers: { Authorization: `Bearer ${apiKey}` },
  });
  const body = await readBoundedResponseText(response);
  if (!response.ok) throw new Error(`Native API HTTP ${response.status}: ${body.slice(0, 500)}`);
  const parsed = JSON.parse(body) as { data?: LocalModelInfo[]; models?: LocalModelInfo[] };
  return Array.isArray(parsed.data) ? parsed.data : Array.isArray(parsed.models) ? parsed.models : [];
}

export async function embedText(
  baseUrl: string,
  apiKey: string,
  model: string,
  input: string[],
  signal?: AbortSignal,
): Promise<number[][]> {
  const response = await fetch(`${baseUrl.replace(/\/$/, "")}/embeddings`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({ model, input }),
    signal,
  });
  if (!response.ok) throw new Error(`Embedding endpoint HTTP ${response.status}: ${(await readBoundedResponseText(response)).slice(0, 300)}`);
  const payload = JSON.parse(await readBoundedResponseText(response, 32 * 1024 * 1024)) as { data?: Array<{ embedding?: unknown }> };
  const vectors = (payload.data ?? []).map((entry) => entry.embedding);
  if (vectors.length !== input.length || vectors.some((vector) => !Array.isArray(vector) || vector.some((value) => typeof value !== "number" || !Number.isFinite(value)))) {
    throw new Error("Embedding endpoint returned an invalid vector payload.");
  }
  return vectors as number[][];
}

export const listServerLoraAdapters = (baseUrl: string, apiKey: string) => trackInitialRead(() => readServerLoraAdapters(baseUrl, apiKey));
async function readServerLoraAdapters(baseUrl: string, apiKey: string): Promise<ServerLoraAdapter[]> {
  const response = await fetch(`${baseUrl.replace(/\/$/, "").replace(/\/v1$/, "")}/lora-adapters`, {
    headers: { Authorization: `Bearer ${apiKey}` },
  });
  const body = await readBoundedResponseText(response);
  if (!response.ok) throw new Error(`LoRA endpoint HTTP ${response.status}: ${body.slice(0, 500)}`);
  const parsed = JSON.parse(body) as unknown;
  if (!Array.isArray(parsed)) throw new Error("LoRA endpoint returned an invalid adapter list.");
  return parsed.filter((value): value is ServerLoraAdapter => {
    if (!value || typeof value !== "object") return false;
    const item = value as Record<string, unknown>;
    return typeof item.id === "number" && typeof item.path === "string" && typeof item.scale === "number";
  });
}

export async function setServerLoraAdapters(baseUrl: string, apiKey: string, adapters: Array<{ id: number; scale: number }>): Promise<void> {
  const response = await fetch(`${baseUrl.replace(/\/$/, "").replace(/\/v1$/, "")}/lora-adapters`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify(adapters),
  });
  const body = await readBoundedResponseText(response);
  if (!response.ok) throw new Error(`LoRA apply HTTP ${response.status}: ${body.slice(0, 500)}`);
}
