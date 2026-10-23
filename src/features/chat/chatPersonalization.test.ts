import { describe, expect, it } from "vitest";
import type { ChatSkill } from "../../shared/api/personalization";
import { findSkillReferences, isSafeSkillId, parseSkillToolCall, resolveSkillSelection } from "./chatPersonalization";

const pdf: ChatSkill = { id: "aiolm:pdf", name: "pdf", description: "PDF", source: "aiolm", path: "synthetic/pdf" };
const creator: ChatSkill = { id: "agents:skill-creator", name: "skill-creator", description: "Make skills", source: "agents", path: "synthetic/creator" };

describe("skill references", () => {
  it("finds $name references in prose, in order and once each", () => {
    expect(findSkillReferences("Use $pdf, then $skill-creator. Again: $pdf!")).toEqual(["pdf", "skill-creator"]);
    expect(findSkillReferences(`Use $${"Re\u0301sume\u0301"} then $résumé and $Résumé.`)).toEqual(["Résumé"]);
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
    const resolved = resolveSkillSelection("Use $Pdf, $Skill-Creator and $nope, $Nope, $later", ["aiolm:pdf", "aiolm:gone"], [pdf, creator]);
    expect(resolved.skills.map((skill) => skill.id)).toEqual(["aiolm:pdf", "agents:skill-creator"]);
    expect(resolved.unknownNames).toEqual(["nope", "later"]);
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

describe("catalog-name resolution boundaries", () => {
  it("keeps exact NFC matches ahead of earlier folded names and preserves first winners and original objects", () => {
    const exact: ChatSkill = { ...pdf, id: "aiolm:exact", name: "Pdf" };
    const nfdFirst: ChatSkill = { ...pdf, id: "aiolm:nfd-first", name: "cafe\u0301" };
    const nfcLater: ChatSkill = { ...pdf, id: "aiolm:nfc-later", name: "café" };
    const foldedFirst: ChatSkill = { ...pdf, id: "aiolm:fold-first", name: "Reader" };
    const foldedLater: ChatSkill = { ...pdf, id: "aiolm:fold-later", name: "reader" };
    const catalog = [pdf, exact, nfdFirst, nfcLater, foldedFirst, foldedLater];
    const cases: Array<{ text: string; skills: ChatSkill[] }> = [
      { text: "$Pdf", skills: [exact] },
      { text: "$Pdf $café $rEaDeR", skills: [exact, nfdFirst, foldedFirst] },
    ];
    const before = structuredClone(catalog);
    for (const scenario of cases) {
      const result = resolveSkillSelection(scenario.text, [], catalog);
      expect(result).toEqual({ skills: scenario.skills, unknownNames: [], missingIds: [] });
      result.skills.forEach((skill, index) => expect(skill).toBe(scenario.skills[index]));
      expect(catalog).toEqual(before);
    }
  });

  it("retains selected-id priority, duplicate missing IDs and textual error order without conflating different objects sharing an id", () => {
    const alpha: ChatSkill = { ...pdf, id: "aiolm:shared-id", name: "alpha" };
    const beta: ChatSkill = { ...pdf, id: "aiolm:shared-id", name: "beta", description: "Second object" };
    const catalog = [alpha, beta, creator, pdf];
    const selected = [alpha.id, "aiolm:gone", "aiolm:gone", creator.id, alpha.id];
    const before = structuredClone({ catalog, selected });
    const result = resolveSkillSelection("$beta $pdf $nope $Nope $later", selected, catalog);
    expect(result).toEqual({ skills: [alpha, creator, pdf], unknownNames: ["nope", "later"], missingIds: ["aiolm:gone", "aiolm:gone"] });
    expect(result.skills[0]).toBe(alpha);
    expect(result.skills[1]).toBe(creator);
    expect(result.skills[2]).toBe(pdf);
    const textual = resolveSkillSelection("$beta $pdf", [], catalog);
    expect(textual).toEqual({ skills: [beta, pdf], unknownNames: [], missingIds: [] });
    expect(textual.skills[0]).toBe(beta);
    expect({ catalog, selected }).toEqual(before);
  });

  it("observes renamed and reordered objects on a fresh call and preserves empty and selection-only results", () => {
    const first: ChatSkill = { ...pdf, id: "aiolm:first", name: "alpha" };
    const second: ChatSkill = { ...creator, id: "aiolm:second", name: "beta" };
    const catalog = [first, second];
    const before = structuredClone(catalog);
    expect(resolveSkillSelection("$alpha $beta", [], catalog)).toEqual({ skills: [first, second], unknownNames: [], missingIds: [] });
    expect(catalog).toEqual(before);
    first.name = "gamma";
    second.name = "delta";
    catalog.reverse();
    const changed = structuredClone(catalog);
    const result = resolveSkillSelection("$gamma $delta $alpha", [], catalog);
    expect(result).toEqual({ skills: [first, second], unknownNames: ["alpha"], missingIds: [] });
    expect(result.skills[0]).toBe(first);
    expect(result.skills[1]).toBe(second);
    expect(resolveSkillSelection("No references", [], catalog)).toEqual({ skills: [], unknownNames: [], missingIds: [] });
    const selected = resolveSkillSelection("No references", [second.id, "aiolm:missing"], catalog);
    expect(selected).toEqual({ skills: [second], unknownNames: [], missingIds: ["aiolm:missing"] });
    expect(selected.skills[0]).toBe(second);
    expect(catalog).toEqual(changed);
  });
});
