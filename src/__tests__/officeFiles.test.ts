// Work with your agent, phase 8: Word, Excel and PowerPoint. An agent is handed the three kinds of Office file,
// every agent reads what one says, and a real one can come back. The three fixtures were written by python-docx,
// openpyxl and python-pptx, the libraries an agent's sandbox uses. No model is called here.
import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { NextRequest } from "next/server";

vi.mock("@/lib/embeddings", async (orig) => ({ ...(await orig<typeof import("@/lib/embeddings")>()), generateEmbedding: async () => null, scheduleAgentEmbedding: () => {} }));
vi.mock("@/lib/agentDescription", async (orig) => ({ ...(await orig<typeof import("@/lib/agentDescription")>()), scheduleAgentDescription: () => {} }));

import { getDb } from "@/lib/db";
import { createAgent } from "@/lib/agents";
import type { Agent } from "@/sdk/types";
import { completeTask, startTask } from "@/lib/tasks";
import { looksZip, zipEntries, zipRead, zipWrite, MAX_ENTRIES } from "@/lib/zip";
import { officeEnabled, officeText, officeType, officeTypeOf, wantsOffice, OFFICE, SHEET } from "@/lib/officeFiles";
import { sniff, storeFile, keepOutput, attachmentsForTask, filesOfTask, outputFileFor, type FileRow, type StoreResult } from "@/lib/agentFiles";
import { markRevision } from "@/lib/revisions";
import { getPublicReceipt } from "@/lib/receipts";
import { POST as hire } from "@/app/api/tasks/route";
import { GET as limits } from "@/app/api/files/route";

const fixture = (name: string) => fs.readFileSync(path.join(__dirname, "fixtures", "office", name));
const DOCX = fixture("plan.docx"), XLSX = fixture("revenue.xlsx"), PPTX = fixture("deck.pptx");
const TYPES = '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>';
let dir = "";
const saved = { ...process.env };
let n = 0;
const wallet = () => `0x${(++n + 1_100_000).toString(16).padStart(40, "0")}`;
const got = (r: StoreResult | null) => { if (!r || !r.ok) throw new Error(`refused: ${r ? r.reason : "nothing kept"}`); return r; };
const row = (id: string) => getDb().prepare("SELECT * FROM task_files WHERE id = ?").get(id) as FileRow;

function agent(id: string, over: Partial<Agent> = {}) {
  const a: Agent = { agentId: id, name: id, capabilities: ["analysis"], publicKey: `pk-${id}`, walletAddress: wallet().toLowerCase(), provider: "anthropic", reputation: 0, createdAt: new Date().toISOString(), ...over };
  createAgent(a, { describe: false });
  return a;
}
type Created = { taskId: string; claimToken?: string; context?: Record<string, unknown>; error?: string };
const hired = async (body: unknown) => {
  const res = await hire(new NextRequest("http://x/api/tasks", { method: "POST", headers: { "content-type": "application/json", "x-forwarded-for": "10.10.0.1" }, body: JSON.stringify(body) }));
  return { status: res.status, body: (await res.json()) as Created };
};

beforeAll(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), "axon-office-")); });
beforeEach(() => {
  Object.assign(process.env, { AGENT_FILES: "on", AGENT_OFFICE: "on", AGENT_FOLLOWUP: "on", AXON_FILES_DIR: dir, TRUST_PROXY_HEADERS: "true" });
  getDb().exec("DELETE FROM task_files; DELETE FROM rate_limit_windows; DELETE FROM tasks; DELETE FROM agent_capabilities; DELETE FROM agents; DELETE FROM api_keys;");
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
});
afterAll(() => {
  fs.rmSync(dir, { recursive: true, force: true });
  for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
  Object.assign(process.env, saved);
});

describe("reading an archive", () => {
  it("lists its parts and unpacks one at a time, stored or deflated", () => {
    for (const deflate of [false, true]) {
      const zip = zipWrite([{ name: "a.txt", data: "hello" }, { name: "dir/b.xml", data: "<x>ä</x>".repeat(100) }], { deflate });
      expect(looksZip(zip)).toBe(true);
      const entries = zipEntries(zip)!;
      expect(entries.map((e) => e.name)).toEqual(["a.txt", "dir/b.xml"]);
      expect(zipRead(zip, entries, "a.txt", 1000)!.toString()).toBe("hello");
      expect(zipRead(zip, entries, "dir/b.xml", 5000)!.toString()).toBe("<x>ä</x>".repeat(100));
      expect(zipRead(zip, entries, "missing", 1000)).toBeNull();
    }
    // real files from the real libraries
    for (const real of [DOCX, XLSX, PPTX]) expect(zipEntries(real)!.some((e) => e.name === "[Content_Types].xml")).toBe(true);
  });

  it("stops at its ceiling whatever the archive claims, and turns away what is not an archive it takes", () => {
    const bomb = zipWrite([{ name: "big.xml", data: Buffer.alloc(4_000_000, 0x61) }], { deflate: true });
    expect(bomb.length).toBeLessThan(20_000);
    const entries = zipEntries(bomb)!;
    expect(zipRead(bomb, entries, "big.xml", 1_000_000)).toBeNull();
    // a part that lies about its size is still stopped while it is being unpacked
    expect(zipRead(bomb, [{ ...entries[0], size: 10 }], "big.xml", 1_000_000)).toBeNull();
    expect(zipRead(bomb, entries, "big.xml", 5_000_000)!.length).toBe(4_000_000);

    expect(zipEntries(Buffer.from("not a zip at all, just words that go on for a while"))).toBeNull();
    const cut = zipWrite([{ name: "a.txt", data: "hello" }]).subarray(0, 30);
    expect(zipEntries(Buffer.concat([cut, Buffer.alloc(10)]))).toBeNull();
    const many = zipWrite(Array.from({ length: MAX_ENTRIES + 1 }, (_, i) => ({ name: `f${i}`, data: "" })));
    expect(zipEntries(many)).toBeNull();
    // a damaged part is no part
    const zip = zipWrite([{ name: "a.txt", data: Buffer.from([0xff, 0xff, 0xff, 0xff, 0xff, 0xff]) }]);
    expect(zipRead(zip, [{ ...zipEntries(zip)![0], method: 8 }], "a.txt", 100)).toBeNull();
    // and a way of packing this reader does not know is not guessed at
    expect(zipRead(zip, [{ ...zipEntries(zip)![0], method: 12 }], "a.txt", 100)).toBeNull();
  });
});

describe("which file it is", () => {
  it("one of the three, told from the bytes; never one with macros, another archive, or the old formats", () => {
    expect(officeType(DOCX)).toBe("docx");
    expect(officeType(XLSX)).toBe("xlsx");
    expect(officeType(PPTX)).toBe("pptx");
    expect(officeTypeOf(OFFICE.xlsx.mime)).toBe("xlsx");
    expect(officeTypeOf("text/plain")).toBeNull();
    const withMacros = zipWrite([{ name: "[Content_Types].xml", data: TYPES }, { name: "word/document.xml", data: "<w:document/>" }, { name: "word/vbaProject.bin", data: "x" }]);
    expect(officeType(withMacros)).toBeNull();
    expect(officeType(zipWrite([{ name: "readme.txt", data: "just a zip" }]))).toBeNull();
    expect(officeType(zipWrite([{ name: "[Content_Types].xml", data: TYPES }, { name: "something/else.xml", data: "<x/>" }]))).toBeNull();
    // an old .doc is a different container altogether
    expect(officeType(Buffer.concat([Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]), Buffer.alloc(600)]))).toBeNull();
  });

  it("is taken as a file only where Office files are switched on", () => {
    expect(officeEnabled({})).toBe(false);
    expect(officeEnabled({ AGENT_OFFICE: "on" })).toBe(false);
    expect(officeEnabled({ AGENT_FILES: "on", AGENT_OFFICE: "on" })).toBe(true);
    expect(sniff(DOCX, "plan.docx")).toEqual({ mime: OFFICE.docx.mime, kind: "office", ext: "docx" });
    // the name is not what decides: a workbook called .txt is a workbook
    expect(sniff(XLSX, "notes.txt")).toMatchObject({ kind: "office", ext: "xlsx" });
    expect(sniff(zipWrite([{ name: "readme.txt", data: "just a zip" }]), "plan.docx")).toBeNull();
    process.env.AGENT_OFFICE = "off";
    expect(sniff(DOCX, "plan.docx")).toBeNull();
    expect(storeFile({ bytes: DOCX, name: "plan.docx" })).toMatchObject({ ok: false, refused: "type" });
  });
});

describe("what a file says", () => {
  it("a document: headings, paragraphs and tables in the order they stand", () => {
    const text = officeText(DOCX, "docx")!;
    expect(text).toContain("# Launch plan\n# Timeline\nThe bottle ships on 14 November. Price: 24 dollars & free shipping.");
    expect(text).toContain("First bullet\nSecond bullet");
    expect(text).toContain("Region | Units | Revenue\nSouth | 5548 | 129034\nEast | 4410 | 98221");
    expect(text.endsWith("Closing note with <angle> brackets.")).toBe(true);
    expect(text).not.toMatch(/<w:|&amp;/);
  });

  it("a workbook: each sheet as rows, with dates as dates, numbers without float noise, and formulas shown", () => {
    const text = officeText(XLSX, "xlsx")!;
    expect(text).toContain('Sheet "Revenue":\nRegion,Units,Revenue,Launch,Active,Note\nSouth,5548,129034.1,2026-11-14,TRUE,"Top, by far"\nEast,4410,98221.1,2026-12-01,FALSE,"He said ""wait"""\n,,=SUM(C2:C3)');
    expect(text).toContain('Sheet "Notes":\n,Only one cell here');
    expect(text).toContain('Sheet "Empty" (empty):');
  });

  it("a very long sheet is cut and says so", () => {
    const rows = Array.from({ length: SHEET.rows + 25 }, (_, i) => `<row r="${i + 1}"><c r="A${i + 1}"><v>${i + 1}</v></c></row>`).join("");
    const big = zipWrite([
      { name: "[Content_Types].xml", data: TYPES },
      { name: "xl/workbook.xml", data: '<workbook><sheets><sheet name="Long" sheetId="1" r:id="rId1"/></sheets></workbook>' },
      { name: "xl/_rels/workbook.xml.rels", data: '<Relationships><Relationship Id="rId1" Target="worksheets/sheet1.xml"/></Relationships>' },
      { name: "xl/worksheets/sheet1.xml", data: `<worksheet><sheetData>${rows}</sheetData></worksheet>` },
    ], { deflate: true });
    const text = officeText(big, "xlsx")!;
    expect(text.split("\n")).toHaveLength(SHEET.rows + 2);
    expect(text.endsWith("[25 more rows are left out here.]")).toBe(true);
  });

  it("a deck: its slides in the order it shows them, each with its own notes", () => {
    const text = officeText(PPTX, "pptx")!;
    expect(text).toBe("Slide 1:\n- Tarn launch\n- The steel bottle\n\nSlide 2:\n- Numbers\n- South leads with 129,034\nSpeaker notes: Say this slowly.\n\nSlide 3:\n- Next steps\n- Ship on 14 November");
    // a deck reordered after it was made: the order is the deck's, not the file names'
    const slide = (t: string) => `<p:sld><p:cSld><p:spTree><p:sp><p:txBody><a:p><a:r><a:t>${t}</a:t></a:r></a:p></p:txBody></p:sp></p:spTree></p:cSld></p:sld>`;
    const reordered = zipWrite([
      { name: "[Content_Types].xml", data: TYPES },
      { name: "ppt/presentation.xml", data: '<p:presentation><p:sldIdLst><p:sldId id="257" r:id="rId3"/><p:sldId id="256" r:id="rId2"/></p:sldIdLst></p:presentation>' },
      { name: "ppt/_rels/presentation.xml.rels", data: '<Relationships><Relationship Id="rId2" Target="slides/slide1.xml"/><Relationship Id="rId3" Target="slides/slide2.xml"/></Relationships>' },
      { name: "ppt/slides/slide1.xml", data: slide("Made first") },
      { name: "ppt/slides/slide2.xml", data: slide("Shown first") },
    ]);
    expect(officeText(reordered, "pptx")).toBe("Slide 1:\n- Shown first\n\nSlide 2:\n- Made first");
  });

  it("a file that is one kind in name only says nothing, not something wrong", () => {
    expect(officeText(DOCX, "xlsx")).toBeNull();
    expect(officeText(Buffer.from("no archive"), "docx")).toBeNull();
  });
});

describe("on a hire", () => {
  it("the agent is given what the file says, every agent, and the job lists the file", async () => {
    agent("gpt-agent", { provider: "openai" });
    const sheet = got(storeFile({ bytes: XLSX, name: "revenue.xlsx" }));
    expect(sheet.file).toMatchObject({ kind: "office", type: OFFICE.xlsx.mime, name: "revenue.xlsx" });
    const job = await hired({ from: "anonymous", to: "gpt-agent", task: "Which region is ahead?", files: [{ id: sheet.file.id, token: sheet.token }] });
    expect(job.status).toBe(201);
    expect((job.body.context?.attachedFiles as { name: string; type: string }[])[0]).toMatchObject({ name: "revenue.xlsx", type: OFFICE.xlsx.mime });
    const handed = await attachmentsForTask(job.body.taskId);
    expect(handed.attachments).toEqual([]);
    expect(handed.text).toContain("Attached file: revenue.xlsx (Excel workbook, ");
    expect(handed.text).toContain("South,5548,129034.1,2026-11-14,TRUE");
    expect(handed.files.map((f) => f.kind)).toEqual(["office"]);
  });

  it("a real file comes back and is kept, and a changed one is the next version of the one handed over", async () => {
    agent("data-agent");
    const sheet = got(storeFile({ bytes: XLSX, name: "revenue.xlsx" }));
    const job = await hired({ from: "anonymous", to: "data-agent", task: "Add a totals row", files: [{ id: sheet.file.id, token: sheet.token }] });
    // the agent's sandbox saved the workbook again with a change, and made a deck
    const changed = zipWrite([...zipEntries(XLSX)!.map((e) => ({ name: e.name, data: zipRead(XLSX, zipEntries(XLSX)!, e.name, 1e7)! })), { name: "docProps/custom.xml", data: "<changed/>" }]);
    expect(officeType(changed)).toBe("xlsx");
    const back = got(keepOutput({ taskId: job.body.taskId, bytes: changed, name: "revenue.xlsx", wallet: null }));
    expect(markRevision(job.body.taskId, back.file.id)).toMatchObject({ version: 2, first: { taskId: null } });
    got(keepOutput({ taskId: job.body.taskId, bytes: PPTX, name: "summary.pptx", wallet: null }));
    startTask(job.body.taskId, "test");
    completeTask(job.body.taskId, "Done.");
    expect(filesOfTask(job.body.taskId, "out").map((f) => [f.name, f.kind])).toEqual([["revenue.xlsx", "office"], ["summary.pptx", "office"]]);
    expect(outputFileFor(row(back.file.id))).toMatchObject({ kind: "office", type: OFFICE.xlsx.mime, version: 2 });
    expect(getPublicReceipt(job.body.taskId)!.outputFiles!.map((f) => f.type)).toEqual([OFFICE.xlsx.mime, OFFICE.pptx.mime]);
  });

  it("the page is told Office files are taken only where they are", async () => {
    const on = (await (await limits(new NextRequest("http://x/api/files"))).json()) as { office?: boolean; types: string[] };
    expect(on.office).toBe(true);
    expect(on.types).toContain(OFFICE.docx.mime);
    process.env.AGENT_OFFICE = "off";
    const off = (await (await limits(new NextRequest("http://x/api/files"))).json()) as { office?: boolean; types: string[] };
    expect(off.office).toBeUndefined();
    expect(off.types).not.toContain(OFFICE.docx.mime);
  });

  it("a job that asks for an Office file by its own words is one", () => {
    for (const yes of ["Make me a PowerPoint about our launch", "put it in an Excel sheet", "I need a spreadsheet of this", "Write it as a Word document", "a 5-slide deck please, as slides", "save as report.docx", "export to xlsx", "put it in excel for me", "an excel file with the numbers"]) expect(wantsOffice(yes), yes).toBe(true);
    for (const no of ["Write a two-sentence description", "What is the word for house in Swedish?", "Give me three words", "Explain how to excel at chess"]) expect(wantsOffice(no), no).toBe(false);
  });
});
