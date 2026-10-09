// Files for agents, the groundwork: what may be handed over, how it is kept, who may read it back, and when it goes.
// Everything is behind AGENT_FILES. The store writes into a temporary folder here, never beside a real database.
import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { NextRequest } from "next/server";
import { getDb } from "@/lib/db";
import { createApiKey } from "@/lib/identity";
import {
  sniff, cleanName, storeFile, getFile, mayRead, readBytes, deleteFile, purgeExpiredFiles, storeBytes, fileTokenFor,
  fileTokenValid, filesEnabled, maxFileBytes, guestBytesAllowed, sha256Of, reserveFor, MIN_FREE_BYTES, DAILY, KEEP_MS, UNATTACHED_MS, type StoreResult,
} from "@/lib/agentFiles";
import { POST as upload } from "@/app/api/files/route";
import { GET as meta, DELETE as remove } from "@/app/api/files/[fileId]/route";
import { GET as content } from "@/app/api/files/[fileId]/content/route";
import { runRetentionCleanup } from "@/lib/retention";

const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(40, 7)]);
const JPG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(40, 3)]);
const GIF = Buffer.concat([Buffer.from("GIF89a"), Buffer.alloc(20, 1)]);
const WEBP = Buffer.concat([Buffer.from("RIFF"), Buffer.from([4, 0, 0, 0]), Buffer.from("WEBPVP8 "), Buffer.alloc(20, 2)]);
const PDF = Buffer.concat([Buffer.from("%PDF-1.7\n"), Buffer.alloc(60, 0x20), Buffer.from("\n%%EOF\n")]);
const TEXT = Buffer.from("Quarter,Revenue\nQ1,120\nQ2,180\n");
const EXE = Buffer.concat([Buffer.from("MZ"), Buffer.alloc(60, 0)]);
const ZIP = Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.alloc(60, 0)]);
const ELF = Buffer.concat([Buffer.from([0x7f, 0x45, 0x4c, 0x46]), Buffer.alloc(60, 0)]);

let dir = "";
const saved = { ...process.env };
let n = 0;
const wallet = () => `0x${(++n + 7_700_000).toString(16).padStart(40, "0")}`;
const T0 = Date.UTC(2026, 9, 9, 12);
const got = (r: StoreResult) => { if (!r.ok) throw new Error(`refused (${r.refused}): ${r.reason}`); return r; };
const refused = (r: StoreResult) => (r.ok ? "stored" : `${r.status} ${r.refused}`);
const blobs = () => { const out: string[] = []; const walk = (d: string) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { if (e.isDirectory()) walk(path.join(d, e.name)); else out.push(e.name); } }; if (fs.existsSync(dir)) walk(dir); return out; };

beforeAll(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "axon-files-test-"));
});
beforeEach(() => {
  process.env.AGENT_FILES = "on";
  process.env.TRUST_PROXY_HEADERS = "true"; // as in production, so each test address is its own visitor
  process.env.AXON_FILES_DIR = dir;
  delete process.env.AXON_FILE_MAX_MB;
  delete process.env.AXON_FILES_MAX_GB;
  getDb().exec("DELETE FROM task_files; DELETE FROM rate_limit_windows; DELETE FROM api_keys;");
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
});
afterAll(() => {
  fs.rmSync(dir, { recursive: true, force: true });
  for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
  Object.assign(process.env, saved);
});

describe("the switch", () => {
  it("is off unless AGENT_FILES=on", () => {
    expect(filesEnabled({})).toBe(false);
    expect(filesEnabled({ AGENT_FILES: "off" })).toBe(false);
    expect(filesEnabled({ AGENT_FILES: " ON " })).toBe(true);
  });
});

describe("what a file is comes from its bytes", () => {
  it("knows PDFs, the four image types and text, whatever the name says", () => {
    expect(sniff(PDF, "holiday.png")).toEqual({ mime: "application/pdf", kind: "pdf", ext: "pdf" });
    expect(sniff(PNG, "report.pdf")?.mime).toBe("image/png");
    expect(sniff(JPG)?.mime).toBe("image/jpeg");
    expect(sniff(GIF)?.mime).toBe("image/gif");
    expect(sniff(WEBP)?.mime).toBe("image/webp");
    expect(sniff(TEXT, "sales.csv")).toEqual({ mime: "text/csv", kind: "text", ext: "csv" });
    expect(sniff(TEXT, "notes")?.mime).toBe("text/plain");
    expect(sniff(Buffer.from('{"a":1}'), "data.JSON")?.mime).toBe("application/json");
    // a page or a script is only ever text: it is stored and served as plain text, never as what it claims to be
    expect(sniff(Buffer.from("<html><script>alert(1)</script></html>"), "page.html")).toEqual({ mime: "text/plain", kind: "text", ext: "txt" });
    expect(sniff(Buffer.from("<svg onload=alert(1)></svg>"), "logo.svg")?.mime).toBe("text/plain");
  });

  it("refuses programs, archives, anything binary it does not know, and nothing at all", () => {
    for (const b of [EXE, ZIP, ELF, Buffer.alloc(0), Buffer.from([0xff, 0xfe, 0x00, 0x41]), Buffer.concat([Buffer.from("hello"), Buffer.from([0]), Buffer.from("x")])]) {
      expect(sniff(b, "invoice.pdf")).toBeNull();
    }
    // an office file is a zip inside: refused, whatever it is called
    expect(sniff(ZIP, "budget.xlsx")).toBeNull();
  });

  it("keeps a name safe: the last path part, no control characters, a sane length", () => {
    expect(cleanName("../../etc/passwd", "txt")).toBe("passwd");
    expect(cleanName("C:\\Users\\me\\Q3 report.pdf", "pdf")).toBe("Q3 report.pdf");
    expect(cleanName('a"b<c>d|e.txt', "txt")).toBe("abcde.txt");
    expect(cleanName("line\nbreak\r.txt", "txt")).toBe("linebreak.txt");
    expect(cleanName("", "png")).toBe("file.png");
    expect(cleanName(undefined, "pdf")).toBe("file.pdf");
    expect(cleanName("...hidden", "txt")).toBe("hidden");
    const long = cleanName(`${"x".repeat(300)}.pdf`, "pdf");
    expect(long.length).toBe(120);
    expect(long.endsWith(".pdf")).toBe(true);
  });
});

describe("keeping a file", () => {
  it("stores it once per content, names it by its hash, and hands back its token", () => {
    const me = wallet();
    const a = got(storeFile({ bytes: PDF, name: "contract.pdf", wallet: me }, { now: T0 }));
    expect(a.file).toMatchObject({ name: "contract.pdf", mime: "application/pdf", kind: "pdf", size: PDF.length, sha256: sha256Of(PDF), direction: "in", taskId: null });
    expect(a.file.id).toMatch(/^f_[0-9a-f]{32}$/);
    expect(a.token).toBe(fileTokenFor(a.file.id));
    expect(new Date(a.file.expiresAt).getTime()).toBe(T0 + KEEP_MS.wallet);
    expect(readBytes(getFile(a.file.id, T0)!)!.equals(PDF)).toBe(true);
    // the same bytes again, from a visitor: a second row, the same single blob
    const b = got(storeFile({ bytes: PDF, name: "copy.pdf" }, { now: T0 }));
    expect(b.file.id).not.toBe(a.file.id);
    expect(new Date(b.file.expiresAt).getTime()).toBe(T0 + KEEP_MS.guest);
    expect(blobs()).toEqual([sha256Of(PDF)]);
    expect(storeBytes()).toBe(PDF.length);
    // the wallet is kept lowercase
    expect((getDb().prepare("SELECT owner_wallet FROM task_files WHERE id = ?").get(a.file.id) as { owner_wallet: string }).owner_wallet).toBe(me.toLowerCase());
  });

  it("refuses what breaks a rule, and writes nothing when it does", () => {
    process.env.AXON_FILE_MAX_MB = "1";
    expect(maxFileBytes()).toBe(1024 * 1024);
    expect(refused(storeFile({ bytes: Buffer.alloc(0) }))).toBe("400 empty");
    expect(refused(storeFile({ bytes: Buffer.concat([PDF, Buffer.alloc(1024 * 1024)]) }))).toBe("413 too_large");
    expect(refused(storeFile({ bytes: EXE, name: "invoice.pdf" }))).toBe("415 type");
    expect(blobs()).toEqual([]);
    expect((getDb().prepare("SELECT COUNT(*) n FROM task_files").get() as { n: number }).n).toBe(0);
  });

  it("stops at the store's ceiling, but still takes bytes it already holds", () => {
    process.env.AXON_FILES_MAX_GB = "0.01"; // about 10 MB
    const big = (seed: number) => Buffer.concat([Buffer.from("%PDF-1.7\n"), Buffer.alloc(4 * 1024 * 1024, seed)]);
    got(storeFile({ bytes: big(1) }));
    got(storeFile({ bytes: big(2) }));
    expect(refused(storeFile({ bytes: big(3) }))).toBe("507 store_full");
    // content already stored costs nothing more
    got(storeFile({ bytes: big(1), name: "again.pdf" }));
    expect(blobs()).toHaveLength(2);
  });

  it("keeps a reserve free on the volume: 500 MB, or a fifth of a small one", () => {
    expect(reserveFor(5000 * 1024 * 1024)).toBe(MIN_FREE_BYTES);
    expect(reserveFor(500 * 1024 * 1024)).toBe(100 * 1024 * 1024);
    expect(reserveFor(0)).toBe(0);
  });

  it("holds a wallet to its day", () => {
    const me = wallet();
    for (let i = 0; i < DAILY.wallet.files; i++) got(storeFile({ bytes: Buffer.from(`note ${i}`), wallet: me }, { now: T0 + i }));
    expect(refused(storeFile({ bytes: Buffer.from("one more"), wallet: me }, { now: T0 + 500 }))).toBe("429 quota");
    // another wallet is not held back, and tomorrow the first one is free again
    got(storeFile({ bytes: Buffer.from("mine"), wallet: wallet() }, { now: T0 + 500 }));
    got(storeFile({ bytes: Buffer.from("next day"), wallet: me }, { now: T0 + 86_400_000 + 1000 }));
  });

  it("counts a visitor's megabytes for a day", () => {
    const key = "files-bytes:ip:10.1.1.1";
    expect(guestBytesAllowed(key, DAILY.guest.bytes - 1024, T0)).toBe(true);
    expect(guestBytesAllowed(key, 4096, T0 + 1)).toBe(false);
    expect(guestBytesAllowed(key, 1024, T0 + 2)).toBe(true);
    expect(guestBytesAllowed(key, 1, T0 + 3)).toBe(false);
    expect(guestBytesAllowed(key, DAILY.guest.bytes, T0 + 86_400_000 + 10)).toBe(true);
  });
});

describe("reading a file back", () => {
  it("takes the wallet that uploaded it or the file's own token, and nothing else", () => {
    const me = wallet(), other = wallet();
    const mine = got(storeFile({ bytes: PNG, name: "chart.png", wallet: me }, { now: T0 }));
    const row = getFile(mine.file.id, T0)!;
    expect(mayRead(row, { wallet: me.toUpperCase().replace("0X", "0x") })).toBe(true);
    expect(mayRead(row, { wallet: other })).toBe(false);
    expect(mayRead(row, { token: mine.token })).toBe(true);
    expect(mayRead(row, { token: `${mine.token.slice(0, -1)}0` })).toBe(false);
    expect(mayRead(row, {})).toBe(false);
    // a visitor's file has no wallet: only its token opens it
    const theirs = got(storeFile({ bytes: TEXT, name: "a.csv" }, { now: T0 }));
    const guestRow = getFile(theirs.file.id, T0)!;
    expect(mayRead(guestRow, { wallet: me })).toBe(false);
    expect(mayRead(guestRow, { token: theirs.token })).toBe(true);
    // one file's token does not open another, and a task's claim token is a different thing
    expect(fileTokenValid(mine.file.id, theirs.token)).toBe(false);
    expect(fileTokenValid(mine.file.id, undefined)).toBe(false);
  });

  it("does not find a file by a malformed id, after its time, or once deleted", () => {
    const f = got(storeFile({ bytes: TEXT }, { now: T0 }));
    expect(getFile("../../etc/passwd")).toBeNull();
    expect(getFile("f_123")).toBeNull();
    expect(getFile(f.file.id, T0 + KEEP_MS.guest - 1)).not.toBeNull();
    expect(getFile(f.file.id, T0 + KEEP_MS.guest + 1)).toBeNull();
    expect(deleteFile(f.file.id, T0)).toBe(true);
    expect(getFile(f.file.id, T0)).toBeNull();
    expect(deleteFile(f.file.id, T0)).toBe(false);
  });
});

describe("clearing files", () => {
  it("deleting one upload keeps the bytes while another upload holds the same content", () => {
    const a = got(storeFile({ bytes: PDF, wallet: wallet() }, { now: T0 }));
    const b = got(storeFile({ bytes: PDF }, { now: T0 }));
    deleteFile(a.file.id, T0);
    expect(blobs()).toEqual([sha256Of(PDF)]);
    expect(readBytes(getFile(b.file.id, T0)!)!.equals(PDF)).toBe(true);
    deleteFile(b.file.id, T0);
    expect(blobs()).toEqual([]);
  });

  it("clears what is past its time and what nobody attached to a hire, and keeps the rest", () => {
    const stray = got(storeFile({ bytes: Buffer.from("never attached") }, { now: T0 }));
    const attached = got(storeFile({ bytes: Buffer.from("attached to a hire") }, { now: T0 }));
    getDb().prepare("UPDATE task_files SET task_id = 'task-1' WHERE id = ?").run(attached.file.id);
    const fresh = got(storeFile({ bytes: Buffer.from("just uploaded") }, { now: T0 + UNATTACHED_MS }));
    expect(purgeExpiredFiles(T0 + UNATTACHED_MS - 1000)).toEqual({ files: 0, blobs: 0 });
    expect(purgeExpiredFiles(T0 + UNATTACHED_MS + 1000)).toEqual({ files: 1, blobs: 1 });
    expect(getFile(stray.file.id, T0 + UNATTACHED_MS + 2000)).toBeNull();
    expect(getFile(attached.file.id, T0 + UNATTACHED_MS + 2000)).not.toBeNull();
    expect(getFile(fresh.file.id, T0 + UNATTACHED_MS + 2000)).not.toBeNull();
    // the attached one goes when its week is up (and the later stray with it); its row stays, marked, so a receipt
    // naming its hash still finds it
    expect(purgeExpiredFiles(T0 + KEEP_MS.guest + 1000).files).toBe(2);
    expect((getDb().prepare("SELECT sha256, deleted_at FROM task_files WHERE id = ?").get(attached.file.id) as { sha256: string; deleted_at: string | null })).toMatchObject({ sha256: sha256Of(Buffer.from("attached to a hire")) });
    expect((getDb().prepare("SELECT deleted_at FROM task_files WHERE id = ?").get(attached.file.id) as { deleted_at: string | null }).deleted_at).not.toBeNull();
  });

  it("the daily retention job clears them, and does nothing while the switch is off", () => {
    const old = got(storeFile({ bytes: Buffer.from("old upload") }, { now: Date.now() - UNATTACHED_MS - 60_000 }));
    process.env.AGENT_FILES = "off";
    expect(runRetentionCleanup().task_files).toBe(0);
    expect(blobs()).toHaveLength(1);
    process.env.AGENT_FILES = "on";
    expect(runRetentionCleanup().task_files).toBe(1);
    expect(blobs()).toEqual([]);
    expect(getFile(old.file.id)).toBeNull();
  });
});

describe("the routes", () => {
  const raw = (bytes: Buffer, headers: Record<string, string> = {}) =>
    upload(new NextRequest("http://x/api/files", { method: "POST", headers: { "content-length": String(bytes.length), "x-forwarded-for": "10.0.0.1", ...headers }, body: new Uint8Array(bytes) }));
  const form = async (bytes: Buffer, name: string, headers: Record<string, string> = {}) => {
    const fd = new FormData();
    fd.append("file", new File([new Uint8Array(bytes)], name));
    const r = new Request("http://x/api/files", { method: "POST", body: fd });
    const body = Buffer.from(await r.arrayBuffer());
    return upload(new NextRequest("http://x/api/files", { method: "POST", headers: { "content-type": r.headers.get("content-type")!, "content-length": String(body.length), "x-forwarded-for": "10.0.0.1", ...headers }, body: new Uint8Array(body) }));
  };
  const at = (id: string, init: { token?: string; key?: string; query?: string; method?: string } = {}) =>
    new NextRequest(`http://x/api/files/${id}${init.query ?? ""}`, { method: init.method ?? "GET", headers: { "x-forwarded-for": "10.0.0.2", ...(init.token ? { "x-file-token": init.token } : {}), ...(init.key ? { authorization: `Bearer ${init.key}` } : {}) } });
  const p = (id: string) => ({ params: Promise.resolve({ fileId: id }) });
  type Up = { file: { id: string; name: string; mime: string; size: number; sha256: string }; fileToken: string };

  it("answer 404 to everything while the switch is off", async () => {
    process.env.AGENT_FILES = "off";
    expect((await raw(PDF)).status).toBe(404);
    expect((await meta(at("f_" + "0".repeat(32)), p("f_" + "0".repeat(32)))).status).toBe(404);
    expect((await content(at("f_" + "0".repeat(32)), p("f_" + "0".repeat(32)))).status).toBe(404);
    expect((await remove(at("f_" + "0".repeat(32), { method: "DELETE" }), p("f_" + "0".repeat(32)))).status).toBe(404);
  });

  it("take a file as the body or as a form, and give it back only as a download", async () => {
    const r = await raw(PDF, { "x-file-name": encodeURIComponent("Avtal för hyra.pdf"), "content-type": "text/html" });
    expect(r.status).toBe(201);
    const up = (await r.json()) as Up;
    expect(up.file).toMatchObject({ name: "Avtal för hyra.pdf", mime: "application/pdf", size: PDF.length, sha256: sha256Of(PDF) });
    expect(up.fileToken).toMatch(/^[0-9a-f]{32}$/);

    const m = await meta(at(up.file.id, { token: up.fileToken }), p(up.file.id));
    expect(m.status).toBe(200);
    expect(((await m.json()) as { file: { id: string } }).file.id).toBe(up.file.id);

    const c = await content(at(up.file.id, { query: `/content?token=${up.fileToken}` }), p(up.file.id));
    expect(c.status).toBe(200);
    expect(Buffer.from(await c.arrayBuffer()).equals(PDF)).toBe(true);
    expect(c.headers.get("content-type")).toBe("application/pdf");
    expect(c.headers.get("content-disposition")).toBe(`attachment; filename="Avtal f_r hyra.pdf"; filename*=UTF-8''${encodeURIComponent("Avtal för hyra.pdf")}`);
    expect(c.headers.get("x-content-type-options")).toBe("nosniff");
    expect(c.headers.get("content-security-policy")).toBe("sandbox; default-src 'none'");
    expect(c.headers.get("cache-control")).toBe("private, no-store");

    // a browser's form upload; an HTML page is kept and served as plain text
    const f = await form(Buffer.from("<script>alert(1)</script>"), "evil.html");
    expect(f.status).toBe(201);
    const page = (await f.json()) as Up;
    const served = await content(at(page.file.id, { token: page.fileToken }), p(page.file.id));
    expect(served.headers.get("content-type")).toBe("text/plain");
    expect(served.headers.get("content-disposition")).toContain("attachment");
  });

  it("tell a stranger nothing: no token, a wrong token and another wallet's key all get 404", async () => {
    const owner = wallet(), other = wallet();
    const { apiKey: ownerKey } = createApiKey(owner, {});
    const { apiKey: otherKey } = createApiKey(other, {});
    const up = (await (await raw(PNG, { authorization: `Bearer ${ownerKey}`, "x-file-name": "chart.png" })).json()) as Up;
    expect((await meta(at(up.file.id), p(up.file.id))).status).toBe(404);
    expect((await meta(at(up.file.id, { token: "0".repeat(32) }), p(up.file.id))).status).toBe(404);
    expect((await content(at(up.file.id, { key: otherKey }), p(up.file.id))).status).toBe(404);
    expect((await meta(at(up.file.id, { key: ownerKey }), p(up.file.id))).status).toBe(200);
    expect((await content(at(up.file.id, { key: ownerKey }), p(up.file.id))).status).toBe(200);
    // a key that does not work is refused, not quietly treated as a visitor
    expect((await meta(at(up.file.id, { key: "axon_not_a_key", token: up.fileToken }), p(up.file.id))).status).toBe(401);
    expect((await raw(PNG, { authorization: "Bearer axon_not_a_key" })).status).toBe(401);
    // deleting takes the same permission, and then it is gone for everyone
    expect((await remove(at(up.file.id, { key: otherKey, method: "DELETE" }), p(up.file.id))).status).toBe(404);
    expect((await remove(at(up.file.id, { key: ownerKey, method: "DELETE" }), p(up.file.id))).status).toBe(200);
    expect((await meta(at(up.file.id, { key: ownerKey }), p(up.file.id))).status).toBe(404);
  });

  it("refuse the wrong kind of file, one that is too large, and an empty one, with a plain reason", async () => {
    const bad = await raw(EXE, { "x-file-name": "invoice.pdf" });
    expect(bad.status).toBe(415);
    expect(await bad.json()).toMatchObject({ code: "NOT_SUPPORTED", details: { refused: "type" } });
    process.env.AXON_FILE_MAX_MB = "1";
    const big = Buffer.concat([PDF, Buffer.alloc(1024 * 1024)]);
    expect((await raw(big)).status).toBe(413);
    // a body that lies about its length is still stopped at the limit
    expect((await raw(big, { "content-length": "10" })).status).toBe(413);
    expect((await form(big, "big.pdf")).status).toBe(413);
    expect((await raw(Buffer.alloc(0))).status).toBe(400);
    const nofield = new FormData();
    nofield.append("other", "x");
    const rq = new Request("http://x/api/files", { method: "POST", body: nofield });
    const body = Buffer.from(await rq.arrayBuffer());
    expect((await upload(new NextRequest("http://x/api/files", { method: "POST", headers: { "content-type": rq.headers.get("content-type")!, "content-length": String(body.length) }, body: new Uint8Array(body) }))).status).toBe(400);
    expect(blobs()).toEqual([]);
  });

  it("hold a visitor to their day by files, and a refused upload does not use it up", async () => {
    const ip = { "x-forwarded-for": "10.0.9.9" };
    // refused uploads first: they must not count
    for (let i = 0; i < 3; i++) expect((await raw(EXE, ip)).status).toBe(415);
    getDb().exec("DELETE FROM rate_limit_windows WHERE key LIKE 'files-up:%'");
    const codes: number[] = [];
    for (let i = 0; i < DAILY.guest.files + 1; i++) {
      codes.push((await raw(Buffer.from(`file number ${i}`), ip)).status);
      getDb().exec("DELETE FROM rate_limit_windows WHERE key LIKE 'files-up:%'"); // the per-minute limit is tested on its own
    }
    expect(codes.filter((c) => c === 201)).toHaveLength(DAILY.guest.files);
    expect(codes[DAILY.guest.files]).toBe(429);
    // another address is its own visitor
    expect((await raw(TEXT, { "x-forwarded-for": "10.0.9.10" })).status).toBe(201);
  });

  it("allow ten uploads a minute from one caller", async () => {
    const ip = { "x-forwarded-for": "10.0.7.7" };
    const codes: number[] = [];
    for (let i = 0; i < 11; i++) {
      codes.push((await raw(Buffer.from(`burst ${i}`), ip)).status);
      getDb().exec("DELETE FROM rate_limit_windows WHERE key LIKE 'files-day:%' OR key LIKE 'files-bytes:%'");
    }
    expect(codes.slice(0, 10).every((c) => c === 201)).toBe(true);
    expect(codes[10]).toBe(429);
  });
});
