// Agents that build, phase 5: forms that collect answers. What is taken and what is refused, who may send and how
// often, who may read, and that the page around a built page asks the visitor before anything goes.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { NextRequest } from "next/server";
import { getDb } from "@/lib/db";
import { addVersion, createSite, hideSite, type SiteFileIn } from "@/lib/agentSites";
import { buildTool } from "@/lib/buildTool";
import { claimTokenFor } from "@/lib/mcpServer";
import { ANSWER, answerCount, answersCsv, answersOf, answerStats, checkAnswer, COLLECTS, formsEnabled, hasForm, keepAnswer, removeAnswer } from "@/lib/siteAnswers";
import { SEAL_FORMS, seal } from "@/lib/siteSeal";
import { viewSite, viewerHtml } from "@/lib/siteViewer";
import { createTask } from "@/lib/tasks";
import { POST as sendAnswer } from "@/app/api/sites/[siteId]/answers/route";
import { GET as readAnswers, DELETE as dropAnswer } from "@/app/api/tasks/[taskId]/site/answers/route";
import { GET as readSite } from "@/app/api/tasks/[taskId]/site/route";

const saved = { ...process.env };
beforeEach(() => {
  process.env.AGENT_SITES = "on";
  delete process.env.AGENT_SITES_FORMS;
  process.env.TRUST_PROXY_HEADERS = "true";
  getDb().exec("DELETE FROM built_site_answers; DELETE FROM built_site_reports; DELETE FROM built_site_files; DELETE FROM built_site_versions; DELETE FROM built_sites; DELETE FROM rate_limit_windows; DELETE FROM tasks;");
});
afterEach(() => {
  for (const k of ["AGENT_SITES", "AGENT_SITES_FORMS", "TRUST_PROXY_HEADERS"]) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
});

const RSVP = `<!doctype html><html><body><h1>Come to the party</h1><form data-collect name="rsvp"><label>Name <input name="Name" required></label><label>Coming <select name="Coming"><option>Yes</option><option>No</option></select></label><button>Send</button></form><p data-after-send hidden>See you there.</p></body></html>`;
const job = () => createTask({ fromAgent: "buyer", toAgent: "deep-dive-ai", task: "Build me an RSVP page", initialStatus: "running", startedBy: "worker" }).taskId;
function built(taskId: string, files: SiteFileIn[] = [{ path: "index.html", content: RSVP }]): string {
  const m = createSite({ taskId, agentId: "deep-dive-ai", ownerMark: "0xabc", title: "Party RSVP" });
  if (!m.ok) throw new Error(m.why);
  const kept = addVersion(m.site.siteId, files, { taskId });
  if (!kept.ok) throw new Error(kept.problems.join("; "));
  return m.site.siteId;
}
const good = (name = "Ada") => ({ form: "rsvp", fields: [["Name", name], ["Coming", "Yes"]] as [string, string][] });
const kept = (siteId: string, a: { form: string; fields: [string, string][] }, o: { sender?: string; now?: number; version?: number } = {}) => {
  const c = checkAnswer(a);
  if (!c.ok) throw new Error(c.why);
  return keepAnswer(siteId, c, { sender: o.sender ?? "ip:1.1.1.1", now: o.now, version: o.version });
};
const post = (siteId: string, body: unknown, o: { ip?: string; origin?: string | null; raw?: string } = {}) =>
  sendAnswer(new NextRequest(`http://localhost/api/sites/${siteId}/answers`, { method: "POST", headers: { "content-type": "application/json", "x-forwarded-for": o.ip ?? "9.9.9.9", host: "localhost", ...(o.origin === null ? {} : { origin: o.origin ?? "http://localhost" }) }, body: o.raw ?? JSON.stringify(body) }), { params: Promise.resolve({ siteId }) });
const owner = (taskId: string, o: { method?: string; query?: string; claim?: string | null } = {}) =>
  new NextRequest(`http://localhost/api/tasks/${taskId}/site/answers${o.query ?? ""}`, { method: o.method ?? "GET", headers: o.claim === null ? {} : { "x-claim-token": o.claim ?? claimTokenFor(taskId) } });
const ctx = (taskId: string) => ({ params: Promise.resolve({ taskId }) });

describe("what a form's answer may be", () => {
  it("takes the fields as they were filled in, in the form's order, with the form's name", () => {
    const c = checkAnswer({ form: "  rsvp \n", fields: [["Name", "  Ada Lovelace  "], ["Note", "Two of us.\r\nNo nuts.   "], ["Coming", "Yes"], ["Empty", ""]] });
    expect(c).toMatchObject({ ok: true, form: "rsvp", fields: [["Name", "Ada Lovelace"], ["Note", "Two of us.\nNo nuts."], ["Coming", "Yes"], ["Empty", ""]] });
    // a form with no name is still a form, and a field with no name is not a field
    expect(checkAnswer({ fields: [["", "x"], ["Name", "Ada"]] })).toMatchObject({ ok: true, form: "form", fields: [["Name", "Ada"]] });
  });

  it("refuses what is not a form's answer, an empty one, and one that is too much", () => {
    for (const bad of [null, "text", {}, { fields: [] }, { fields: "Name=Ada" }, { fields: [["Name"]] }, { fields: [["Name", 3]] }, { fields: [{ name: "Name", value: "Ada" }] }]) expect(checkAnswer(bad)).toMatchObject({ ok: false });
    expect(checkAnswer({ fields: [["Name", ""], ["Note", "   "]] })).toMatchObject({ ok: false, why: "Fill in the form first." });
    expect(checkAnswer({ fields: Array.from({ length: ANSWER.fields + 1 }, (_, i) => [`f${i}`, "x"]) })).toMatchObject({ ok: false, why: expect.stringMatching(/at most 40 fields/) });
    expect(checkAnswer({ fields: Array.from({ length: 10 }, (_, i) => [`f${i}`, "x".repeat(ANSWER.valueChars)]) })).toMatchObject({ ok: false, why: expect.stringMatching(/too much for one answer/) });
    // a value longer than a field holds is cut to what it holds, never kept whole
    const long = checkAnswer({ fields: [["Note", "y".repeat(ANSWER.valueChars + 500)]] });
    expect(long.ok && long.fields[0][1].length).toBe(ANSWER.valueChars);
  });

  it("never takes a password, a card or a recovery phrase, whatever the page calls the field", () => {
    for (const name of ["Password", "password", "Your pass code", "pwd", "Seed phrase", "recovery words", "Mnemonic", "Private key", "private_key", "Secret", "Card number", "card-no", "CVV", "cvc", "SSN", "Social security number"]) {
      expect(checkAnswer({ fields: [["Name", "Ada"], [name, "hunter2"]] }), name).toMatchObject({ ok: false, why: expect.stringMatching(/never takes those, so nothing was sent/) });
    }
    // left empty, such a field stops nothing; and ordinary fields that only sound close are fine
    expect(checkAnswer({ fields: [["Name", "Ada"], ["Password", ""]] })).toMatchObject({ ok: true });
    for (const name of ["Passport country", "Company", "Discard pile", "Keyboard", "Seating", "Postcard text"]) expect(checkAnswer({ fields: [[name, "x"]] }), name).toMatchObject({ ok: true });
  });
});

describe("keeping answers", () => {
  it("keeps an answer for a live page, newest first, with the version it was sent from", () => {
    const id = built(job());
    expect(kept(id, good("Ada"), { now: Date.UTC(2026, 9, 12, 10) })).toMatchObject({ ok: true });
    expect(kept(id, good("Grace"), { now: Date.UTC(2026, 9, 12, 11), sender: "ip:2.2.2.2" })).toMatchObject({ ok: true });
    const all = answersOf(id);
    expect(all.map((a) => a.fields[0][1])).toEqual(["Grace", "Ada"]);
    expect(all[0]).toMatchObject({ form: "rsvp", version: 1, at: "2026-10-12T11:00:00.000Z" });
    expect(answerCount(id)).toBe(2);
    expect(answerStats()).toEqual({ answers: 2, pages: 1 });
    // who sent it is kept only as a hash
    const rows = getDb().prepare("SELECT sender_hash FROM built_site_answers").all() as { sender_hash: string }[];
    expect(rows.every((r) => /^[0-9a-f]{32}$/.test(r.sender_hash))).toBe(true);
    expect(JSON.stringify(rows)).not.toContain("1.1.1.1");
  });

  it("counts a double press once, but the same words from somebody else, or later, again", () => {
    const id = built(job());
    const t = Date.UTC(2026, 9, 12, 10);
    const first = kept(id, good(), { now: t }), again = kept(id, good(), { now: t + 5_000 });
    expect(first.ok && again.ok && first.id === again.id).toBe(true);
    kept(id, good(), { now: t + 5_000, sender: "ip:2.2.2.2" });
    kept(id, good(), { now: t + 120_000 });
    expect(answerCount(id)).toBe(3);
  });

  it("takes nothing for a page that is not there, is taken down, or is full", () => {
    expect(kept("no-such-page", good())).toMatchObject({ ok: false, status: 404 });
    const empty = createSite({ taskId: "t9", agentId: "a", ownerMark: null, title: "Empty" });
    expect(empty.ok && kept(empty.site.siteId, good())).toMatchObject({ ok: false, status: 404 });
    const id = built(job());
    const put = getDb().prepare("INSERT INTO built_site_answers (id, site_id, version, form, fields, bytes, sender_hash, created_at) VALUES (?, ?, 1, 'rsvp', '[]', 2, 'x', '2026-10-12T00:00:00.000Z')");
    for (let i = 0; i < ANSWER.perSite; i++) put.run(`a${i}`, id);
    expect(kept(id, good())).toMatchObject({ ok: false, status: 409, why: "This form has all the answers it can hold." });
    getDb().exec("DELETE FROM built_site_answers");
    hideSite(id, "reported");
    expect(kept(id, good())).toMatchObject({ ok: false, status: 410 });
  });

  it("removes an answer for good, and only from its own page", () => {
    const a = built(job()), b = built(job());
    const one = kept(a, good("Ada")), two = kept(a, good("Grace"), { sender: "ip:2.2.2.2" });
    if (!one.ok || !two.ok) throw new Error("not kept");
    expect(removeAnswer(b, one.id)).toBe(false);
    expect(removeAnswer(a, one.id)).toBe(true);
    expect(removeAnswer(a, one.id)).toBe(false);
    expect(answersOf(a).map((x) => x.id)).toEqual([two.id]);
    expect(getDb().prepare("SELECT COUNT(*) n FROM built_site_answers").get()).toEqual({ n: 1 });
  });

  it("makes a file a spreadsheet opens: a row an answer, a column for every field there ever was, nothing that runs", () => {
    const id = built(job());
    const t = Date.UTC(2026, 9, 12, 10);
    kept(id, { form: "rsvp", fields: [["Name", "Ada"], ["Coming", "Yes"]] }, { now: t });
    kept(id, { form: "rsvp", fields: [["Name", 'Grace "Amazing" Hopper'], ["Coming", "No"], ["Note", "Late,\nsorry"], ["Likes", "tea"], ["Likes", "cake"]] }, { now: t + 1000, sender: "ip:2" });
    kept(id, { form: "rsvp", fields: [["Name", "=HYPERLINK(\"http://x\")"], ["Coming", "+1"], ["Note", "@home"]] }, { now: t + 2000, sender: "ip:3" });
    const lines = answersCsv(id).split("\r\n");
    expect(lines[0]).toBe("sent,form,Name,Coming,Note,Likes");
    expect(lines[1]).toBe("2026-10-12T10:00:00.000Z,rsvp,Ada,Yes,,");
    expect(answersCsv(id)).toContain('2026-10-12T10:00:01.000Z,rsvp,"Grace ""Amazing"" Hopper",No,"Late,\nsorry",tea; cake');
    // a cell that would run as a formula is kept as words
    expect(answersCsv(id)).toContain(`"'=HYPERLINK(""http://x"")",'+1,'@home,`);
    expect(answersCsv(built(job()))).toBe("sent,form\r\n");
  });

  it("knows a page that collects answers from one whose form is only its own", () => {
    expect(hasForm(built(job()))).toBe(true);
    expect(hasForm(built(job(), [{ path: "index.html", content: "<form><input name=bill><button>Work it out</button></form>" }]))).toBe(false);
    expect(hasForm(built(job(), [{ path: "index.html", content: "<h1>No form</h1>" }, { path: "app.js", content: "// <form data-collect>" }]))).toBe(false);
    expect(COLLECTS.test('<FORM name="x" DATA-COLLECT>')).toBe(true);
  });

  it("is switched off on its own, and is off whenever built pages are", () => {
    expect(formsEnabled({ AGENT_SITES: "on" })).toBe(true);
    expect(formsEnabled({ AGENT_SITES: "on", AGENT_SITES_FORMS: " OFF " })).toBe(false);
    expect(formsEnabled({ AGENT_SITES_FORMS: "on" })).toBe(false);
  });
});

describe("sending an answer", () => {
  it("is open to a visitor of the page, and keeps what they sent", async () => {
    const id = built(job());
    const res = await post(id, { ...good(), v: 1 });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(answersOf(id)).toHaveLength(1);
    // with no origin at all (not a browser) it is still one visitor, held to the same count
    expect((await post(id, good("Grace"), { origin: null })).status).toBe(200);
  });

  it("is not taken from a page of another site, nor for a page that is gone, nor when forms are off", async () => {
    const id = built(job());
    expect((await post(id, good(), { origin: "https://evil.example" })).status).toBe(403);
    expect((await post(id, good(), { origin: "not an address" })).status).toBe(403);
    expect((await post("no-such-page", good())).status).toBe(404);
    hideSite(id, "reported");
    expect((await post(id, good())).status).toBe(410);
    process.env.AGENT_SITES_FORMS = "off";
    expect((await post(built(job()), good())).status).toBe(404);
    expect(answerStats().answers).toBe(0);
  });

  it("says in words why an answer was not taken", async () => {
    const id = built(job());
    const secret = await post(id, { form: "x", fields: [["Password", "hunter2"]] });
    expect(secret.status).toBe(400);
    expect((await secret.json()).error).toMatch(/never takes those/);
    expect((await (await post(id, { fields: [["Name", ""]] })).json()).error).toBe("Fill in the form first.");
    expect((await post(id, null, { raw: "{not json" })).status).toBe(400);
    expect((await post(id, null, { raw: JSON.stringify({ fields: [["Note", "x".repeat(50_000)]] }) })).status).toBe(400);
    expect(answerCount(id)).toBe(0);
  });

  it("holds one visitor to a few answers a page, while another visitor still gets through", async () => {
    const id = built(job());
    for (let i = 0; i < 5; i++) expect((await post(id, good(`Guest ${i}`))).status).toBe(200);
    const sixth = await post(id, good("Guest 6"));
    expect(sixth.status).toBe(429);
    expect((await post(id, good("Somebody else"), { ip: "8.8.8.8" })).status).toBe(200);
    expect(answerCount(id)).toBe(6);
  });
});

describe("reading the answers", () => {
  it("is for whoever hired the job, and for nobody else", async () => {
    const taskId = job(), id = built(taskId);
    kept(id, good("Ada"));
    const mine = await readAnswers(owner(taskId), ctx(taskId));
    expect(mine.status).toBe(200);
    expect(await mine.json()).toMatchObject({ total: 1, answers: [{ form: "rsvp", version: 1, fields: [["Name", "Ada"], ["Coming", "Yes"]] }] });
    expect((await readAnswers(owner(taskId, { claim: "wrong" }), ctx(taskId))).status).toBe(403);
    expect((await readAnswers(owner(taskId, { claim: null }), ctx(taskId))).status).toBe(401);
    // another job's token opens nothing here
    const other = job();
    expect((await readAnswers(owner(taskId, { claim: claimTokenFor(other) }), ctx(taskId))).status).toBe(403);
    expect((await readAnswers(owner(other), ctx(other))).status).toBe(404);
  });

  it("hands them over as a file, and removes one when asked", async () => {
    const taskId = job(), id = built(taskId);
    const one = kept(id, good("Ada")), two = kept(id, good("Grace"), { sender: "ip:2" });
    if (!one.ok || !two.ok) throw new Error("not kept");
    const file = await readAnswers(owner(taskId, { query: "?format=csv" }), ctx(taskId));
    expect(file.headers.get("content-type")).toMatch(/^text\/csv/);
    expect(file.headers.get("content-disposition")).toBe('attachment; filename="party-rsvp-answers.csv"');
    expect((await file.text()).split("\r\n")[0]).toBe("sent,form,Name,Coming");
    const gone = await dropAnswer(owner(taskId, { method: "DELETE", query: `?id=${one.id}` }), ctx(taskId));
    expect(await gone.json()).toMatchObject({ ok: true, total: 1, answers: [{ id: two.id }] });
    expect((await dropAnswer(owner(taskId, { method: "DELETE", query: `?id=${one.id}` }), ctx(taskId))).status).toBe(404);
    expect((await dropAnswer(owner(taskId, { method: "DELETE", query: `?id=${two.id}`, claim: "wrong" }), ctx(taskId))).status).toBe(403);
    expect(answerCount(id)).toBe(1);
  });

  it("stays readable when the page is taken down or forms are switched off: the answers are the hirer's", async () => {
    const taskId = job(), id = built(taskId);
    kept(id, good("Ada"));
    hideSite(id, "reported");
    process.env.AGENT_SITES_FORMS = "off";
    expect(await (await readAnswers(owner(taskId), ctx(taskId))).json()).toMatchObject({ total: 1 });
  });

  it("the job's page says whether it has a form and how many answers came in", async () => {
    const taskId = job(), id = built(taskId);
    kept(id, good("Ada"));
    const seen = await (await readSite(new NextRequest(`http://localhost/api/tasks/${taskId}/site`, { headers: { "x-claim-token": claimTokenFor(taskId) } }), ctx(taskId))).json();
    expect(seen).toMatchObject({ form: true, answers: 1 });
    const plain = job();
    built(plain, [{ path: "index.html", content: "<h1>No form</h1>" }]);
    expect(await (await readSite(new NextRequest(`http://localhost/api/tasks/${plain}/site`, { headers: { "x-claim-token": claimTokenFor(plain) } }), ctx(plain))).json()).toMatchObject({ form: false, answers: 0 });
  });
});

describe("the page around a built page", () => {
  const dataOf = (html: string) => JSON.parse(/<script type="application\/json" id="d">([\s\S]*?)<\/script>/.exec(html)![1]) as { answers: string | null; v: number | null; pages: Record<string, string> };

  it("is told where answers go and which version it shows, and asks the visitor before sending", () => {
    const id = built(job());
    const html = viewSite(id).html;
    expect(dataOf(html)).toMatchObject({ answers: `/api/sites/${id}/answers`, v: 1 });
    expect(html).toContain("Send this to the person who had this page built?");
    expect(html).toMatch(/<button class="go" id="sy" type="button">Send<\/button><button id="sn" type="button">Cancel<\/button>/);
    // the question is hidden until a form is sent
    expect(html).toMatch(/<div class="note snd" id="s" hidden>/);
    // every page of the site carries the script that takes a form, right after the policy
    expect(dataOf(html).pages["index.html"]).toContain(SEAL_FORMS);
    expect(seal("<h1>x</h1>").indexOf(SEAL_FORMS)).toBeGreaterThan(seal("<h1>x</h1>").indexOf("Content-Security-Policy"));
    expect(seal("<h1>x</h1>").indexOf(SEAL_FORMS)).toBeLessThan(seal("<h1>x</h1>").indexOf("<h1>x</h1>"));
  });

  it("has nowhere to send them when forms are off, and the form is told so", () => {
    process.env.AGENT_SITES_FORMS = "off";
    const html = viewSite(built(job())).html;
    expect(dataOf(html).answers).toBeNull();
    expect(html).toContain("This page cannot take answers right now.");
    expect(dataOf(viewerHtml({ siteId: "x", title: "T", agentId: "a" }, { "index.html": "<h1>x</h1>" }, "An agent")).answers).toBeNull();
  });

  it("only takes a form that says it collects answers, and never sends a file", () => {
    expect(SEAL_FORMS).toContain('hasAttribute("data-collect")');
    expect(SEAL_FORMS).toContain('typeof v==="string"');
    expect(SEAL_FORMS).not.toMatch(/fetch\(|XMLHttpRequest|\.submit\(/);
  });
});

describe("what the agent is told", () => {
  const tool = () => buildTool({ taskId: "t1", agentId: "agent-1", ownerMark: "0xabc", paid: false, env: { AGENT_SITES: "on" } });

  it("how a form that collects answers is written, and that it writes no code to send it", () => {
    const d = tool().description;
    for (const must of [/<form data-collect name="rsvp">/, /Give it no action and write no code that sends it/, /shown what goes and asked to confirm/, /data-after-send and hidden/, /A form cannot take files/, /A form without data-collect sends nothing/]) expect(d).toMatch(must);
    expect(d).not.toMatch(/—/);
  });

  it("to tell the person where the answers are, when what it built has such a form", async () => {
    expect(await tool().run({ title: "Party RSVP", files: [{ path: "index.html", content: RSVP }] })).toMatch(/It has a form: tell them that what people send through it is listed for them on Axon, under the page's link with this job, and can be downloaded as a file\./);
    getDb().exec("DELETE FROM built_site_files; DELETE FROM built_site_versions; DELETE FROM built_sites;");
    expect(await tool().run({ title: "Tips", files: [{ path: "index.html", content: "<form><input name=bill><button type=button>Work it out</button></form>" }] })).not.toMatch(/It has a form/);
  });
});
