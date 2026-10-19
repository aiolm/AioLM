import assert from "node:assert/strict";
import { buildChatRequestBody } from "../../src/shared/api/index.ts";
import { assertUnmanagedServerArgs, parseChatOptions } from "../../src/shared/config/tuningValidation.ts";

assert.deepEqual(
  assertUnmanagedServerArgs(["--min-p", "0.05", "--chat-template", "qwen"]),
  ["--min-p", "0.05", "--chat-template", "qwen"],
);
assert.throws(() => assertUnmanagedServerArgs(["--host", "0.0.0.0"]), /app-managed/);
assert.throws(() => assertUnmanagedServerArgs(["--api-key=secret"]), /app-managed/);
assert.throws(() => assertUnmanagedServerArgs(["--no-api-key"]), /app-managed/);
assert.throws(() => assertUnmanagedServerArgs(["--mmproj", "projector.gguf"]), /app-managed/);
assert.throws(() => assertUnmanagedServerArgs(["-mm", "projector.gguf"]), /app-managed/);
for (const flag of [
  "--n-gpu-layers",
  "-ngl",
  "--ctx-size",
  "-c",
  "--flash-attn",
  "--n-cpu-moe",
  "--threads",
  "-t",
  "--spec-type",
  "--spec-draft-n-max",
  "--reasoning",
  "--reasoning-format",
  "--reasoning-effort",
  "--reasoning-budget",
  "--reasoning-budget-message",
  "--reasoning-preserve",
  "--no-reasoning-preserve",
]) {
  assert.throws(() => assertUnmanagedServerArgs([flag, "value"]), /app-managed/);
}

assert.deepEqual(parseChatOptions('{"min_p":0.05,"dry_sequence_breakers":["\\n",":"]}'), {
  min_p: 0.05,
  dry_sequence_breakers: ["\n", ":"],
});
assert.throws(() => parseChatOptions("[]"), /JSON object/);
assert.throws(() => parseChatOptions('{"stream":false}'), /reserved/);

const body = buildChatRequestBody(
  "selected-model",
  [{ role: "user", content: "hello" }],
  {
    temperature: 0.7,
    top_p: 0.9,
    top_k: 40,
    reasoning_effort: "high",
    options: { min_p: 0.05, max_tokens: 128, stream: false, model: "wrong-model" },
  },
);
assert.equal(body.model, "selected-model");
assert.equal(body.stream, true);
assert.equal(body.temperature, 0.7);
assert.equal(body.top_p, 0.9);
assert.equal(body.top_k, 40);
assert.equal(body.min_p, 0.05);
assert.equal(body.max_tokens, 128);
assert.equal(body.reasoning_effort, "high");

const noThinkingBody = buildChatRequestBody(
  "selected-model",
  [{ role: "user", content: "hello" }],
  { temperature: 0.7, top_p: 0.9, top_k: 40, reasoning_effort: "none" },
);
assert.equal(noThinkingBody.reasoning_effort, "none");

const dedicatedOffBody = buildChatRequestBody(
  "selected-model",
  [{ role: "user", content: "hello" }],
  {
    temperature: 0.7,
    top_p: 0.9,
    top_k: 40,
    reasoning: "off",
    reasoning_effort: "xhigh",
    options: { chat_template_kwargs: { enable_thinking: true } },
  },
);
assert.equal(dedicatedOffBody.reasoning_effort, "none");
assert.equal((dedicatedOffBody.chat_template_kwargs as { enable_thinking: boolean }).enable_thinking, false);
assert.deepEqual(
  buildChatRequestBody(
    "selected-model",
    [{ role: "user", content: "hello" }],
    {
      temperature: 1,
      top_p: 0.95,
      top_k: 20,
      reasoning_effort: "high",
      options: {
        min_p: 0.0,
        repeat_penalty: 1.0,
        presence_penalty: 0.0,
        max_tokens: 131072,
        chat_template_kwargs: {
          enable_thinking: true,
          preserve_thinking: true,
        },
      },
    },
  ).chat_template_kwargs,
  {
    enable_thinking: true,
    preserve_thinking: true,
    reasoning_effort: "high",
  },
);

console.log("advanced settings tests passed");
