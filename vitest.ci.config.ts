import { defineConfig } from "vitest/config";
import { readFileSync } from "node:fs";
import base from "./vitest.config";

const planPath = process.env.AIOLM_FRONTEND_PLAN;
const shard = Number(process.env.AIOLM_FRONTEND_SHARD);
const output = process.env.AIOLM_FRONTEND_OUTPUT;
if (!planPath || !Number.isInteger(shard) || shard < 1 || !output) {
  throw new Error("Run CI shards through scripts/frontend-ci.mjs");
}
const plan = JSON.parse(readFileSync(planPath, "utf8"));
const include = plan.assignments[shard - 1];
if (!Array.isArray(include) || !include.length) throw new Error("Empty or unknown frontend shard");

export default defineConfig({
  ...base,
  test: {
    ...base.test,
    include,
    coverage: {
      ...base.test?.coverage,
      // A partial shard cannot meet the whole-suite threshold. The merge uses
      // the original config and enforces the unchanged aggregate thresholds.
      thresholds: undefined,
      reportsDirectory: `${output}/coverage`,
    },
  },
});
