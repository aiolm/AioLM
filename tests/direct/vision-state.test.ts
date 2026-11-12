// @vitest-environment node
import { test } from "vitest";
import { projectorChangeAllowed } from "../../src/features/chat/visionState.ts";

test("vision state contracts", async () => {
  if (!projectorChangeAllowed("stopped")) throw new Error("stopped server should allow projector changes");
  for (const state of ["starting", "running", "stopping"]) {
    if (projectorChangeAllowed(state)) throw new Error(`${state} server should block projector changes`);
  }
});
