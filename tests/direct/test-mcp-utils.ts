import assert from "node:assert/strict";
import { buildMcpFunctionNames, formatMcpCommand, requiresToolApproval, validateMcpServerDraft } from "../../src/features/mcp/mcpUtils.ts";

assert.equal(validateMcpServerDraft({ name: "Filesystem", command: "npx", args: ["-y", "server"], enabled: true }), null);
assert.match(validateMcpServerDraft({ name: "", command: "npx", args: [], enabled: true }) ?? "", /name/i);
assert.match(validateMcpServerDraft({ name: "Server", command: "npx && whoami", args: [], enabled: true }) ?? "", /command/i);
assert.equal(formatMcpCommand("npx", ["-y", "server"]), "npx -y server");
assert.equal(requiresToolApproval(false), true);
assert.equal(requiresToolApproval(true), true);
const longPrefix = "s".repeat(80);
const names = buildMcpFunctionNames([
  { serverId: longPrefix, toolName: `${"a".repeat(30)}-one` },
  { serverId: longPrefix, toolName: `${"a".repeat(30)}-two` },
]);
assert.equal(names.length, 2);
assert.notEqual(names[0], names[1]);
assert.ok(names.every((name) => name.length <= 96));
assert.deepEqual(buildMcpFunctionNames(['same', 'same_2', 'same', 'same_3', 'same', 'same_2', 'same', 'same_2_2', 'same_2']
  .map((toolName) => ({ serverId: 'catalog', toolName }))), [
  'catalog__same', 'catalog__same_2', 'catalog__same_3', 'catalog__same_3_2', 'catalog__same_4',
  'catalog__same_2_2', 'catalog__same_5', 'catalog__same_2_2_2', 'catalog__same_2_3',
]);
assert.deepEqual(buildMcpFunctionNames(['read.file', 'read/file', 'read_file_2', 'read file', 'read_file']
  .map((toolName) => ({ serverId: 'catalog', toolName }))), [
  'catalog__read_file', 'catalog__read_file_2', 'catalog__read_file_2_2', 'catalog__read_file_3', 'catalog__read_file_4',
]);
const truncatedBase = `${'s'.repeat(64)}__${'a'.repeat(30)}`;
const collisions = buildMcpFunctionNames(Array.from({ length: 120 }, (_, index) => ({
  serverId: 's'.repeat(64), toolName: `${'a'.repeat(40)}${index}`,
})));
assert.equal(collisions[0], truncatedBase);
assert.equal(collisions[1], `${truncatedBase.slice(0, 94)}_2`);
assert.equal(collisions[8], `${truncatedBase.slice(0, 94)}_9`);
assert.equal(collisions[9], `${truncatedBase.slice(0, 93)}_10`);
assert.equal(collisions[98], `${truncatedBase.slice(0, 93)}_99`);
assert.equal(collisions[99], `${truncatedBase.slice(0, 92)}_100`);
assert.equal(new Set(collisions).size, collisions.length);
assert.ok(collisions.every((name) => name.length <= 96));
console.log("mcp utility tests passed");
