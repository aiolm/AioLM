// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import { readBoundedResponseText, requestJson, retryAfterMilliseconds } from "./http.ts";

describe("bounded HTTP responses", () => {
  it("decodes split UTF-8 and counts bytes before decoding", async () => {
    const bytes = new TextEncoder().encode("한글");
    const stream = () => new ReadableStream<Uint8Array>({ start(controller) {
      controller.enqueue(bytes.slice(0, 2)); controller.enqueue(bytes.slice(2)); controller.close();
    } });
    expect(await readBoundedResponseText(new Response(stream()), 6)).toBe("한글");
    await expect(readBoundedResponseText(new Response(stream()), 5)).rejects.toMatchObject({ code: "response_too_large" });
  });

  it("cancels an oversized response without reading it to completion", async () => {
    const cancel = vi.fn();
    const stream = new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(new Uint8Array(20)); }, cancel });
    await expect(readBoundedResponseText(new Response(stream), 10)).rejects.toThrow("size limit");
    expect(cancel).toHaveBeenCalledOnce();
  });

  it("exposes retry metadata without retaining remote diagnostics", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response("secret echoed here", { status: 429, headers: { "Retry-After": "7" } }));
    await expect(requestJson("https://example.test", (x) => x, { fetcher })).rejects.toMatchObject({ code: "http", status: 429, retryable: true, retryAfterMs: 7000, message: "HTTP 429" });
    expect(fetcher).toHaveBeenCalledOnce();
    expect(retryAfterMilliseconds("Tue, 01 Jan 2030 00:00:08 GMT", Date.UTC(2030, 0, 1))).toBe(8000);
    expect(retryAfterMilliseconds("invalid")).toBeUndefined();
  });

  it("distinguishes permanent HTTP errors, invalid JSON and cancellation", async () => {
    await expect(requestJson("https://example.test", (x) => x, { fetcher: async () => new Response("", { status: 401 }) })).rejects.toMatchObject({ status: 401, retryable: false });
    await expect(requestJson("https://example.test", (x) => x, { fetcher: async () => new Response("bad JSON") })).rejects.toMatchObject({ code: "invalid_response", retryable: false });
    const controller = new AbortController(); controller.abort();
    const fetcher = vi.fn<typeof fetch>();
    await expect(requestJson("https://example.test", (x) => x, { signal: controller.signal, fetcher })).rejects.toMatchObject({ code: "aborted", retryable: false });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("bounds stalled reads and clears the deadline after completion", async () => {
    const fetcher: typeof fetch = async (_url, init) => new Response(new ReadableStream({ start(controller) {
      init?.signal?.addEventListener("abort", () => controller.error(new Error("aborted")), { once: true });
    } }));
    await expect(requestJson("https://example.test", (x) => x, { fetcher, timeoutMs: 5 })).rejects.toMatchObject({ code: "timeout", retryable: true });
    expect(await requestJson("https://example.test", (x) => x, { fetcher: async () => new Response('{"ok":true}') })).toEqual({ ok: true });
  });
});
