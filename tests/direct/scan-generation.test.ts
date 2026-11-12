// @vitest-environment node
import { test } from "vitest";
import { isCurrentScan, nextScanGeneration } from "../../src/features/models/scanGeneration.ts";

test("scan generation contracts", async () => {
  const invalidated = nextScanGeneration(7);
  if (invalidated !== 8) throw new Error(`unexpected next generation: ${invalidated}`);
  if (isCurrentScan(7, invalidated)) throw new Error("stale scan was not invalidated");
  if (!isCurrentScan(invalidated, invalidated)) throw new Error("current scan was rejected");
});
