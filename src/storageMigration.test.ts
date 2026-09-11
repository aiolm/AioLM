import { beforeEach, describe, expect, it, vi } from "vitest";
import { migrateBrowserStorage, migrateStoredValue } from "./storageMigration";

describe("AioLM first-run browser migration", () => {
  beforeEach(() => { localStorage.clear(); vi.restoreAllMocks(); });
  it("starts fresh and never resurrects old data on later launches", async () => {
    await migrateBrowserStorage();
    localStorage.setItem("llama-board-theme", "dark");
    await migrateBrowserStorage();
    expect(localStorage.getItem("aiolm-theme")).toBeNull();
  });
  it("copies structured data while preserving original and external paths", async () => {
    const old = JSON.stringify({documents:[{path:"C:\\Data\\llama-board\\docs\\one.txt",text:"preserve me"},{path:"D:/documents/two.txt"}]});
    localStorage.setItem("llama-board-theme", "dark");
    localStorage.setItem("llama-board.projects.v1", old);
    await migrateBrowserStorage([{from:"C:/Data/llama-board",to:"C:/Data/aiolm"}]);
    expect(localStorage.getItem("aiolm-theme")).toBe("dark");
    expect(JSON.parse(localStorage.getItem("aiolm.projects.v1")!).documents).toEqual([{path:"C:/Data/aiolm/docs/one.txt",text:"preserve me"},{path:"D:/documents/two.txt"}]);
    expect(localStorage.getItem("llama-board.projects.v1")).toBe(old);
  });
  it("uses an existing AioLM workspace without merging previous preferences", async () => {
    localStorage.setItem("aiolm-theme", "light");
    localStorage.setItem("llama-board-theme", "dark");
    localStorage.setItem("llama-board.projects.v1", "[]");
    await migrateBrowserStorage();
    expect(localStorage.getItem("aiolm-theme")).toBe("light");
    expect(localStorage.getItem("aiolm.projects.v1")).toBeNull();
  });
  it("blocks corrupt structured input and retries after repair", async () => {
    localStorage.setItem("llama-board.projects.v1", "{broken");
    await expect(migrateBrowserStorage()).rejects.toThrow();
    expect(localStorage.getItem("aiolm.migration.v1")).toBeNull();
    localStorage.setItem("llama-board.projects.v1", "[]");
    await migrateBrowserStorage();
    expect(localStorage.getItem("aiolm.projects.v1")).toBe("[]");
  });
  it("resumes a partial copy after a quota failure", async () => {
    localStorage.setItem("llama-board-theme", "dark");
    localStorage.setItem("llama-board-locale", "ko");
    const set = Storage.prototype.setItem;
    const spy = vi.spyOn(Storage.prototype,"setItem").mockImplementation(function(this:Storage,key,value){
      if (key === "aiolm-locale") throw new DOMException("Disk full", "QuotaExceededError");
      set.call(this,key,value);
    });
    await expect(migrateBrowserStorage()).rejects.toThrow("Disk full");
    expect(localStorage.getItem("aiolm.migration.v1")).toBe("copying");
    spy.mockRestore();
    await migrateBrowserStorage();
    expect(localStorage.getItem("aiolm-locale")).toBe("ko");
    expect(localStorage.getItem("aiolm.migration.v1")).toBe("complete");
  });
  it.each(["damaged", "null", "42"])("blocks non-structured settings without saving defaults: %s", async raw => {
    localStorage.setItem("llama-board-preferences", raw);
    await expect(migrateBrowserStorage()).rejects.toThrow();
    expect(localStorage.getItem("llama-board-preferences")).toBe(raw);
    expect(localStorage.getItem("aiolm-preferences")).toBeNull();
    expect(localStorage.getItem("aiolm.migration.v1")).toBeNull();
  });
  it("preserves damaged new data and never imports over it", async () => {
    localStorage.setItem("aiolm-preferences", "damaged");
    localStorage.setItem("llama-board-preferences", '{"version":1,"values":{"theme":"dark"}}');
    await expect(migrateBrowserStorage()).rejects.toThrow();
    expect(localStorage.getItem("aiolm-preferences")).toBe("damaged");
    expect(localStorage.getItem("aiolm.migration.v1")).toBeNull();
  });
  it("keeps binary attachments intact and rewrites only rooted managed paths", () => {
    const attachment=new Blob(["document"]); const bytes=new Uint8Array([1,2,3]);
    const result=migrateStoredValue({attachment,bytes,external:"C:/Data/llama-board-archive/a.txt",schema:"llama-board.project.v1"},[{from:"C:/Data/llama-board",to:"C:/Data/aiolm"}]) as Record<string,unknown>;
    expect(result.attachment).toBe(attachment);expect(result.bytes).toBe(bytes);
    expect(result.external).toBe("C:/Data/llama-board-archive/a.txt");expect(result.schema).toBe("aiolm.project.v1");
  });
});
