// Agents that use the internet, phase 5: what a job's browser sent. Each form is written down with the job, field
// by field, for the person to see; what is kept, what is cut, and that one job's record is its own.
import { describe, it, expect, beforeEach } from "vitest";
import { getDb } from "@/lib/db";
import { recordSent, sentOf, MAX_SENT_PER_JOB, MAX_SENT_FIELDS } from "@/lib/taskSent";

beforeEach(() => { getDb().exec("DELETE FROM task_sent;"); });

describe("what a job's browser sent", () => {
  it("is kept in the order it was sent: the page, the button, and each field with what was in it", () => {
    expect(recordSent("t1", { url: "https://shop.example/contact?ref=ad#form", button: "Send message", fields: [{ label: "Your name", value: "Ada Lovelace" }, { label: "Message", value: "Do you   ship\nto Canada?" }] })).toBe(true);
    recordSent("t1", { url: "https://shop.example/news", fields: [{ label: "Email", value: "ada@example.org" }] });
    const sent = sentOf("t1");
    expect(sent.map((s) => [s.n, s.url, s.button])).toEqual([[1, "https://shop.example/contact", "Send message"], [2, "https://shop.example/news", ""]]);
    expect(sent[0].fields).toEqual([{ label: "Your name", value: "Ada Lovelace" }, { label: "Message", value: "Do you ship to Canada?" }]);
    expect(sent[0].at).toMatch(/^\d{4}-\d\d-\d\dT/);
  });

  it("a long value is cut, an empty field is dropped, and only so many fields and forms are kept", () => {
    recordSent("t1", { url: "https://a.example/f", fields: [{ label: "Essay", value: "x".repeat(900) }, { label: "", value: "" }, ...Array.from({ length: 50 }, (_, i) => ({ label: `f${i}`, value: "v" }))] });
    const f = sentOf("t1")[0].fields;
    expect(f[0].value.length).toBe(400);
    expect(f.length).toBe(MAX_SENT_FIELDS - 1); // the empty one of the first thirty is dropped
    for (let i = 0; i < MAX_SENT_PER_JOB + 3; i++) recordSent("t2", { url: "https://a.example/f", fields: [] });
    expect(sentOf("t2").length).toBe(MAX_SENT_PER_JOB);
  });

  it("something that looks like a key is not kept as it was typed", () => {
    recordSent("t1", { url: "https://a.example/f", fields: [{ label: "Notes", value: "my key is sk-ant-api03-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA" }] });
    expect(sentOf("t1")[0].fields[0].value).not.toContain("sk-ant-api03-AAAAAAAA");
  });

  it.each(["file:///etc/passwd", "javascript:alert(1)", "about:blank", "nonsense", ""])("nothing is kept for %s", (url) => {
    expect(recordSent("t1", { url, fields: [{ label: "a", value: "b" }] })).toBe(false);
    expect(sentOf("t1")).toEqual([]);
  });

  it("one job's record is never another's, and a row that cannot be read shows no fields", () => {
    recordSent("t1", { url: "https://a.example/f", fields: [{ label: "a", value: "b" }] });
    expect(sentOf("t2")).toEqual([]);
    getDb().prepare("UPDATE task_sent SET fields = 'not json' WHERE task_id = 't1'").run();
    expect(sentOf("t1")[0].fields).toEqual([]);
  });
});
