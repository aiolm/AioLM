import { describe, expect, it } from "vitest";
import type { ChatSkill } from "../../shared/api/personalization";
import { findSkillReferences, isSafeSkillId, parseSkillToolCall, resolveSkillSelection } from "./chatPersonalization";

const pdf: ChatSkill = { id: "aiolm:pdf", name: "pdf", description: "PDF", source: "aiolm", path: "synthetic/pdf" };
const creator: ChatSkill = { id: "agents:skill-creator", name: "skill-creator", description: "Make skills", source: "agents", path: "synthetic/creator" };

describe("skill references", () => {
  it("finds $name references in prose, in order and once each", () => {
    expect(findSkillReferences("Use $pdf, then $skill-creator. Again: $pdf!")).toEqual(["pdf", "skill-creator"]);
  });

  it("ignores amounts, escapes, inline math, env-style names and code", () => {
    const text = [
      "It costs $5 or $1,000.50 (US$20).",
      "Escaped \\$pdf and inline math $x^2$ or $y$.",
      "Set $PATH and $USD.",
      "Inline `$pdf` code.",
      "```sh",
      "echo $pdf",
      "```",
    ].join("\n");
    expect(findSkillReferences(text)).toEqual([]);
  });

  it("finds Korean and other Unicode skill names, including before CJK punctuation", () => {
    expect(findSkillReferences("$요약-도우미 스킬로 정리하고, $résumé_writer, $日本語。 then $ελληνικά.")).toEqual(["요약-도우미", "résumé_writer", "日本語", "ελληνικά"]);
  });

  it("keeps the exclusions for Unicode text", () => {
    const text = [
      "가격$요약 and 비용 $5,000원.",
      "Inline `$요약` and math $α^2$ or $β$.",
      "Env-style $ÉTAT stays literal.",
      "~~~",
      "$요약",
      "~~~",
    ].join("\n");
    expect(findSkillReferences(text)).toEqual([]);
  });

  it("matches a decomposed (NFD) reference to a composed catalog name", () => {
    const korean: ChatSkill = { id: "aiolm:summary", name: "요약", description: "요약", source: "aiolm", path: "synthetic/summary" };
    expect(resolveSkillSelection(`Use $${"요약".normalize("NFD")} now`, [], [korean]).skills).toEqual([korean]);
  });

  it("matches picker ids and $names against the catalog and reports unknown names", () => {
    const resolved = resolveSkillSelection("Use $Pdf, $Skill-Creator and $nope", ["aiolm:pdf", "aiolm:gone"], [pdf, creator]);
    expect(resolved.skills.map((skill) => skill.id)).toEqual(["aiolm:pdf", "agents:skill-creator"]);
    expect(resolved.unknownNames).toEqual(["nope"]);
    expect(resolved.missingIds).toEqual(["aiolm:gone"]);
  });
});

describe("skill tool calls", () => {
  const call = (args: string) => ({ id: "c", type: "function" as const, function: { name: "aiolm_read_skill", arguments: args } });

  it("accepts only an exact catalog id", () => {
    expect(parseSkillToolCall(call('{"id":"aiolm:pdf"}'), [pdf])).toEqual({ skill: pdf });
    expect(parseSkillToolCall(call('{"id":"aiolm:PDF"}'), [pdf])).toHaveProperty("error");
  });

  it.each(["../pdf", "aiolm/pdf", "aiolm\\pdf", "a\u0000b", "x".repeat(201), ""])("rejects unsafe id %j", (id) => {
    expect(isSafeSkillId(id)).toBe(false);
    expect(parseSkillToolCall(call(JSON.stringify({ id })), [{ ...pdf, id }])).toHaveProperty("error");
  });
});
