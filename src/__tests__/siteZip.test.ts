// Agents that build, phase 7: take it with you. The files of a built page in one archive, as the agent wrote them,
// with a note in plain words; for whoever had the page built and for nobody else.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { NextRequest } from "next/server";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getDb } from "@/lib/db";
import { addVersion, createSite, hideSite, type SiteFileIn } from "@/lib/agentSites";
import { claimTokenFor } from "@/lib/mcpServer";
import { readme, siteZip, slugOf } from "@/lib/siteZip";
import { createTask } from "@/lib/tasks";
import { zipEntries, zipRead, zipWrite } from "@/lib/zip";
import { GET as takeZip } from "@/app/api/tasks/[taskId]/site/zip/route";

const saved = process.env.AGENT_SITES;
beforeEach(() => {
  process.env.AGENT_SITES = "on";
  getDb().exec("DELETE FROM built_site_answers; DELETE FROM built_site_files; DELETE FROM built_site_versions; DELETE FROM built_sites; DELETE FROM rate_limit_windows; DELETE FROM tasks;");
});
afterEach(() => { if (saved === undefined) delete process.env.AGENT_SITES; else process.env.AGENT_SITES = saved; });

const HTML = `<!doctype html><html><head><meta name="viewport" content="width=device-width, initial-scale=1"><title>Tips</title><link rel="stylesheet" href="style.css"></head><body><h1>Tip calculator</h1><script src="js/app.js"></script></body></html>`;
const FILES: SiteFileIn[] = [{ path: "index.html", content: HTML }, { path: "style.css", content: "h1{color:#111}" }, { path: "js/app.js", content: "const tip = (bill, pct) => bill * pct / 100;" }];
const job = () => createTask({ fromAgent: "buyer", toAgent: "deep-dive-ai", task: "Build me a tip calculator", initialStatus: "running", startedBy: "worker" }).taskId;
function built(taskId: string, files: SiteFileIn[] = FILES, title = "Tip Calculator"): string {
  const m = createSite({ taskId, agentId: "deep-dive-ai", ownerMark: "0xabc", title });
  if (!m.ok) throw new Error(m.why);
  const kept = addVersion(m.site.siteId, files, { taskId });
  if (!kept.ok) throw new Error(kept.problems.join("; "));
  return m.site.siteId;
}
const parts = (zip: Buffer) => { const e = zipEntries(zip)!; return Object.fromEntries(e.map((x) => [x.name, zipRead(zip, e, x.name, 2_000_000)!.toString("utf8")])); };
const ask = (taskId: string, o: { query?: string; claim?: string | null } = {}) =>
  takeZip(new NextRequest(`http://localhost/api/tasks/${taskId}/site/zip${o.query ?? ""}`, { headers: o.claim === null ? {} : { "x-claim-token": o.claim ?? claimTokenFor(taskId) } }), { params: Promise.resolve({ taskId }) });

describe("the files of a built page in one archive", () => {
  it("holds every file as the agent wrote it, in one folder named after the page, with a note", () => {
    const id = built(job());
    const got = siteZip(id, { origin: "https://axon-agents.com/" })!;
    expect(got).toMatchObject({ name: "tip-calculator-v1.zip", version: 1, files: 3 });
    const p = parts(got.bytes);
    expect(Object.keys(p)).toEqual(["tip-calculator/index.html", "tip-calculator/js/app.js", "tip-calculator/style.css", "tip-calculator/README.txt"]);
    // as written: not the sealed copy the link shows, so it works by itself anywhere
    expect(p["tip-calculator/index.html"]).toBe(HTML);
    expect(p["tip-calculator/index.html"]).not.toMatch(/Content-Security-Policy|axon:"form"/);
    expect(p["tip-calculator/style.css"]).toBe("h1{color:#111}");
    expect(p["tip-calculator/js/app.js"]).toBe("const tip = (bill, pct) => bill * pct / 100;");
    const note = p["tip-calculator/README.txt"];
    expect(note).toMatch(/^Tip Calculator\r\n\r\nBuilt by .+ on Axon\. This is version 1, kept on \d{4}-\d\d-\d\d\.\r\nIts link on Axon: https:\/\/axon-agents\.com\/s\//);
    expect(note).toContain(`https://axon-agents.com/s/${id}`);
    expect(note).toMatch(/index\.html is the page that opens\. The other files \(js\/app\.js, style\.css\) are what it uses/);
    expect(note).toMatch(/Upload this folder as it is to any place that serves files\. It needs nothing else: no server code, no database, no account\./);
    expect(note).toMatch(/Fingerprint of this version: [0-9a-f]{64}\r\n$/);
    expect(note).not.toMatch(/THE FORM|—/);
  });

  it("is a real archive: another program unpacks it into a folder that holds the page", () => {
    const got = siteZip(built(job()))!;
    const dir = mkdtempSync(join(tmpdir(), "site-zip-"));
    try {
      writeFileSync(join(dir, got.name), got.bytes);
      execFileSync("unzip", ["-q", got.name], { cwd: dir });
      expect(readdirSync(join(dir, "tip-calculator")).sort()).toEqual(["README.txt", "index.html", "js", "style.css"]);
      expect(readFileSync(join(dir, "tip-calculator", "index.html"), "utf8")).toBe(HTML);
      expect(readFileSync(join(dir, "tip-calculator", "js", "app.js"), "utf8")).toContain("const tip");
      // the files carry the day the version was kept, not 1980
      expect(execFileSync("unzip", ["-l", got.name], { cwd: dir }).toString()).toMatch(new RegExp(String(new Date().getUTCFullYear())));
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it("says what stays behind when the page has a form that collects answers", () => {
    const id = built(job(), [{ path: "index.html", content: `<form data-collect name="rsvp"><input name="Name"><button>Send</button></form>` }], "Party RSVP");
    const note = parts(siteZip(id)!.bytes)["party-rsvp/README.txt"];
    expect(note).toMatch(/THE FORM\r\nThe form on this page collects answers only at its link on Axon, where they are listed for whoever had the page built\. Opened from these files, the form sends nothing\./);
    // a page of one file names no other files, and with no address given it names no link
    expect(note).toMatch(/index\.html is the page that opens\.\r\n/);
    expect(note).not.toMatch(/Its link on Axon/);
  });

  it("gives the version asked for, the one shown otherwise, and nothing for a version that is not kept", () => {
    const taskId = job(), id = built(taskId);
    addVersion(id, [{ path: "index.html", content: "<h1>Two</h1>" }], { taskId });
    expect(siteZip(id)).toMatchObject({ name: "tip-calculator-v2.zip", version: 2, files: 1 });
    expect(parts(siteZip(id)!.bytes)["tip-calculator/index.html"]).toBe("<h1>Two</h1>");
    expect(parts(siteZip(id, { version: 1 })!.bytes)["tip-calculator/index.html"]).toBe(HTML);
    expect(siteZip(id, { version: 9 })).toBeNull();
    expect(siteZip("no-such-page")).toBeNull();
    const empty = createSite({ taskId: "t9", agentId: "a", ownerMark: null, title: "Empty" });
    expect(empty.ok && siteZip(empty.site.siteId)).toBeNull();
  });

  it("names the folder and the file from what the page is called, whatever that is", () => {
    expect(slugOf("Tip Calculator")).toBe("tip-calculator");
    expect(slugOf("  Café \"Luna\": Menü & Preise!  ")).toBe("cafe-luna-menu-preise");
    expect(slugOf("../../etc/passwd")).toBe("etc-passwd");
    expect(slugOf("日本語")).toBe("page");
    expect(slugOf("x".repeat(200)).length).toBe(60);
    expect(readme({ title: "T", agentName: "A", version: 3, keptAt: "2026-10-12T10:00:00.000Z", link: "", sha256: "ab", names: ["index.html"], form: false })).toBe("T\r\n\r\nBuilt by A on Axon. This is version 3, kept on 2026-10-12.\r\n\r\nWHAT IS HERE\r\nindex.html is the page that opens.\r\n\r\nTO LOOK AT IT\r\nOpen index.html in a browser.\r\n\r\nTO PUT IT ON THE WEB\r\nUpload this folder as it is to any place that serves files. It needs nothing else: no server code, no database, no account.\r\n\r\nFingerprint of this version: ab\r\n");
  });

  it("the writer gives its files the date it is told, and none before 1980", () => {
    const e = (zip: Buffer) => ({ time: zip.readUInt16LE(10), date: zip.readUInt16LE(12) });
    const dated = e(zipWrite([{ name: "a.txt", data: "a" }], { at: new Date(Date.UTC(2026, 9, 12, 14, 25, 30)) }));
    expect(dated.date).toBe(((2026 - 1980) << 9) | (10 << 5) | 12);
    expect(dated.time).toBe((14 << 11) | (25 << 5) | 15);
    expect(e(zipWrite([{ name: "a.txt", data: "a" }]))).toEqual({ time: 0, date: 0x21 });
    expect(e(zipWrite([{ name: "a.txt", data: "a" }], { at: new Date(Date.UTC(1975, 0, 1)) }))).toEqual({ time: 0, date: 0x21 });
  });
});

describe("taking the files", () => {
  it("is for whoever hired the job, and for nobody else", async () => {
    const taskId = job(), id = built(taskId);
    const res = await ask(taskId);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/zip");
    expect(res.headers.get("content-disposition")).toBe('attachment; filename="tip-calculator-v1.zip"');
    const zip = Buffer.from(await res.arrayBuffer());
    expect(Number(res.headers.get("content-length"))).toBe(zip.length);
    expect(parts(zip)["tip-calculator/README.txt"]).toContain(`http://localhost/s/${id}`);
    expect((await ask(taskId, { claim: "wrong" })).status).toBe(403);
    expect((await ask(taskId, { claim: null })).status).toBe(401);
    const other = job();
    expect((await ask(taskId, { claim: claimTokenFor(other) })).status).toBe(403);
    expect((await ask(other)).status).toBe(404);
  });

  it("gives an earlier version when asked, refuses nonsense, and gives nothing for a page that was taken down", async () => {
    const taskId = job(), id = built(taskId);
    addVersion(id, [{ path: "index.html", content: "<h1>Two</h1>" }], { taskId });
    expect((await ask(taskId)).headers.get("content-disposition")).toContain("tip-calculator-v2.zip");
    expect((await ask(taskId, { query: "?v=1" })).headers.get("content-disposition")).toContain("tip-calculator-v1.zip");
    for (const bad of ["?v=9", "?v=abc", "?v=-1", "?v=1.5", "?v="]) expect((await ask(taskId, { query: bad })).status, bad).toBe(404);
    hideSite(id, "reported");
    expect((await ask(taskId)).status).toBe(410);
    expect(siteZip(id)).toBeNull();
    process.env.AGENT_SITES = "off";
    expect((await ask(taskId)).status).toBe(404);
  });
});
