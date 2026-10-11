// Agents that use the internet, phase 4: where a job's browser went. What is written down, what never is, and that
// one job's pages are its own.
import { describe, it, expect, beforeEach } from "vitest";
import { getDb } from "@/lib/db";
import { recordPage, pagesOf, MAX_PAGES_PER_JOB } from "@/lib/taskPages";

beforeEach(() => { getDb().exec("DELETE FROM task_pages;"); });

describe("the pages a job's browser was on", () => {
  it("are kept in the order it got there, with their titles", () => {
    expect(recordPage("t1", { url: "https://stripe.com/pricing", title: "Pricing & fees" })).toBe(true);
    expect(recordPage("t1", { url: "https://paypal.com/fees", title: "  PayPal\n fees " })).toBe(true);
    expect(pagesOf("t1").map((p) => [p.n, p.url, p.title])).toEqual([[1, "https://stripe.com/pricing", "Pricing & fees"], [2, "https://paypal.com/fees", "PayPal fees"]]);
    expect(pagesOf("t1")[0].at).toMatch(/^\d{4}-\d\d-\d\dT/);
  });

  it("the page it is already on is not written twice, a place on the same page is the same page, coming back is a new visit", () => {
    recordPage("t1", { url: "https://a.example/docs" });
    expect(recordPage("t1", { url: "https://a.example/docs" })).toBe(false);
    expect(recordPage("t1", { url: "https://a.example/docs#install" })).toBe(false);
    recordPage("t1", { url: "https://b.example/" });
    expect(recordPage("t1", { url: "https://a.example/docs" })).toBe(true);
    expect(pagesOf("t1").map((p) => p.url)).toEqual(["https://a.example/docs", "https://b.example/", "https://a.example/docs"]);
  });

  it.each(["file:///etc/passwd", "javascript:alert(1)", "chrome://version", "about:blank", "not an address", "", "https://user:secret@a.example/"])("never keeps %s", (url) => {
    expect(recordPage("t1", { url })).toBe(false);
    expect(pagesOf("t1")).toEqual([]);
  });

  it("a very long address and title are cut, and a job keeps only so many", () => {
    recordPage("t1", { url: `https://a.example/${"x".repeat(3000)}`, title: "T".repeat(500) });
    expect(pagesOf("t1")[0].url.length).toBe(2000);
    expect(pagesOf("t1")[0].title.length).toBe(200);
    for (let i = 0; i < MAX_PAGES_PER_JOB + 5; i++) recordPage("t2", { url: `https://a.example/p${i}` });
    expect(pagesOf("t2").length).toBe(MAX_PAGES_PER_JOB);
  });

  it("one job's pages are never another's, and a job that never browsed has none", () => {
    recordPage("t1", { url: "https://a.example/" });
    expect(pagesOf("t2")).toEqual([]);
    expect(pagesOf("nope")).toEqual([]);
  });
});
