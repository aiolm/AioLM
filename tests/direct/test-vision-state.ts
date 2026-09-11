import { projectorChangeAllowed } from "../../src/features/chat/visionState.ts";

if (!projectorChangeAllowed("stopped")) throw new Error("stopped server should allow projector changes");
for (const state of ["starting", "running", "stopping"]) {
  if (projectorChangeAllowed(state)) throw new Error(`${state} server should block projector changes`);
}
console.log("vision state tests passed");
