// Agents that use the internet, phase 6: where a saved file came from. What is written down beside a file an agent
// saved from a page, and what never is.
import { describe, it, expect, beforeEach } from "vitest";
import { getDb } from "@/lib/db";
import { recordSource, sourceOf } from "@/lib/fileSources";

beforeEach(() => { getDb().exec("DELETE FROM task_file_sources;"); });

describe("where a saved file came from", () => {
  it("the page, its title, the kind of copy and the moment", () => {
    expect(recordSource("f_1", { url: "https://stripe.com/pricing#fees", title: "  Pricing &\n fees ", kind: "pdf" }, Date.UTC(2026, 9, 11, 14, 3))).toBe(true);
    expect(sourceOf("f_1")).toEqual({ url: "https://stripe.com/pricing#fees", title: "Pricing & fees", kind: "pdf", at: "2026-10-11T14:03:00.000Z" });
  });

  it("a file that was not saved from a page has none", () => {
    expect(sourceOf("f_none")).toBeNull();
  });

  it.each(["file:///etc/passwd", "javascript:alert(1)", "about:blank", "nonsense", "", "https://user:secret@a.example/"])("never keeps %s", (url) => {
    expect(recordSource("f_2", { url, kind: "picture" })).toBe(false);
    expect(sourceOf("f_2")).toBeNull();
  });

  it("only the kinds there are, and a second writing takes the first one's place", () => {
    expect(recordSource("f_3", { url: "https://a.example/", kind: "video" as never })).toBe(false);
    recordSource("f_3", { url: "https://a.example/", kind: "picture" });
    recordSource("f_3", { url: "https://b.example/", kind: "text" });
    expect(sourceOf("f_3")).toMatchObject({ url: "https://b.example/", kind: "text" });
  });

  it("a long address and title are cut", () => {
    recordSource("f_4", { url: `https://a.example/${"x".repeat(3000)}`, title: "T".repeat(500), kind: "picture" });
    expect(sourceOf("f_4")!.url.length).toBe(2000);
    expect(sourceOf("f_4")!.title.length).toBe(200);
  });
});
