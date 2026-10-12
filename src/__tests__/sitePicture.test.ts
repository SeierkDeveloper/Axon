// Agents that build, phase 4: a picture of what was built, for the live log. The browser is replaced with one that
// records what it was asked: what is checked is that the page goes in sealed and whole, that no address is opened,
// that the browser is always closed, and that no picture is ever worth a failed or a slow build.
import { describe, it, expect, beforeEach } from "vitest";
import { getDb } from "@/lib/db";
import { addVersion, createSite, siteLimits } from "@/lib/agentSites";
import { pictureOfSite, sitePicturesEnabled, PICTURE_TIMEOUT_MS, SETTLE_MS } from "@/lib/sitePicture";
import type { openBrowser } from "@/lib/browserSession";

const ON = { AGENT_SITES: "on", AGENT_BROWSER: "on" };
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]);

beforeEach(() => {
  getDb().exec("DELETE FROM built_site_reports; DELETE FROM built_site_files; DELETE FROM built_site_versions; DELETE FROM built_sites;");
});

function built(): string {
  const made = createSite({ taskId: "t1", agentId: "agent-1", ownerMark: "0xabc", title: "Tip calculator" }, siteLimits(ON));
  if (!made.ok) throw new Error(made.why);
  const kept = addVersion(made.site.siteId, [
    { path: "index.html", content: '<!doctype html><html><head><meta name="viewport" content="width=device-width, initial-scale=1"><title>Tips</title><link rel="stylesheet" href="style.css"></head><body><h1>Tips</h1><script src="app.js"></script></body></html>' },
    { path: "style.css", content: "h1{color:#111}" },
    { path: "app.js", content: "document.title = 'ready';" },
  ], { taskId: "t1", title: "Tip calculator" }, siteLimits(ON));
  if (!kept.ok) throw new Error(kept.problems.join("; "));
  return made.site.siteId;
}

/** A browser that does nothing but remember what it was told. */
function fake(o: { refuse?: "off" | "missing" | "busy" | "failed"; failOn?: string; shotAfterMs?: number; endsAt?: string } = {}) {
  const calls: { method: string; params?: Record<string, unknown> }[] = [];
  const seen: { opened: number; closed: number; limits?: { waitSeconds: number; seconds: number }; taskId?: string } = { opened: 0, closed: 0 };
  const open = (async (opts: { limits?: { waitSeconds: number; seconds: number }; taskId?: string }) => {
    seen.limits = opts.limits; seen.taskId = opts.taskId;
    if (o.refuse) return { ok: false as const, refused: o.refuse, reason: "no" };
    seen.opened++;
    return {
      ok: true as const,
      session: {
        async command(method: string, params?: Record<string, unknown>) {
          calls.push({ method, params });
          if (method === o.failOn) throw new Error("the browser closed");
          return method === "Page.getFrameTree" ? { frameTree: { frame: { id: "frame-1" } } } : {};
        },
        async screenshot() { if (o.shotAfterMs) await new Promise((r) => setTimeout(r, o.shotAfterMs)); return JPEG; },
        async where() { return { url: o.endsAt ?? "about:blank", title: "" }; },
        async goto() { throw new Error("no address is ever opened for a picture"); },
        async close() { seen.closed++; },
      },
    };
  }) as unknown as typeof openBrowser;
  return { open, calls, seen };
}

describe("a picture of what was built", () => {
  it("is on with the browsers, and can be switched off on its own", () => {
    expect(sitePicturesEnabled(ON)).toBe(true);
    expect(sitePicturesEnabled({ AGENT_SITES: "on" })).toBe(false);
    expect(sitePicturesEnabled({ ...ON, AGENT_BROWSER: "off" })).toBe(false);
    expect(sitePicturesEnabled({ ...ON, AGENT_SITES_PICTURE: "off" })).toBe(false);
    expect(sitePicturesEnabled({ ...ON, AGENT_SITES_PICTURE: " OFF " })).toBe(false);
    expect(SETTLE_MS).toBeLessThanOrEqual(1500);
    expect(PICTURE_TIMEOUT_MS).toBeLessThanOrEqual(20_000);
  });

  it("puts the page into the browser whole and sealed, opens no address, takes the picture and closes the browser", async () => {
    const siteId = built(), b = fake();
    const jpeg = await pictureOfSite(siteId, { env: ON, open: b.open, taskId: "t1", settleMs: 1 });
    expect(jpeg?.equals(JPEG)).toBe(true);
    // off the network first, then the page
    expect(b.calls.map((c) => c.method)).toEqual(["Page.getFrameTree", "Network.enable", "Network.emulateNetworkConditions", "Page.setDocumentContent"]);
    expect(b.calls[2].params).toMatchObject({ offline: true });
    const put = b.calls[3].params as { frameId: string; html: string };
    expect(put.frameId).toBe("frame-1");
    // sealed: the policy comes before anything the agent wrote, and its own files are inside the one document
    expect(put.html).toMatch(/^<!doctype html><meta http-equiv="Content-Security-Policy"/i);
    expect(put.html).toContain("<style>h1{color:#111}</style>");
    expect(put.html).toContain("document.title = 'ready';");
    expect(put.html).not.toMatch(/href="style\.css"|src="app\.js"/);
    expect(b.seen).toMatchObject({ opened: 1, closed: 1, taskId: "t1" });
    // a build is not held up for its picture: a short wait for a free browser, and a short life for the browser
    expect(b.seen.limits!.waitSeconds).toBeLessThanOrEqual(5);
    expect(b.seen.limits!.seconds).toBeLessThanOrEqual(60);
  });

  it("is simply not there when pictures are off, when no browser can be had, or when the site has no page", async () => {
    const siteId = built();
    for (const env of [{ AGENT_SITES: "on" }, { ...ON, AGENT_SITES_PICTURE: "off" }]) {
      const b = fake();
      expect(await pictureOfSite(siteId, { env, open: b.open })).toBeNull();
      expect(b.seen.opened).toBe(0);
    }
    for (const refuse of ["off", "missing", "busy", "failed"] as const) expect(await pictureOfSite(siteId, { env: ON, open: fake({ refuse }).open })).toBeNull();
    const none = fake();
    expect(await pictureOfSite("no-such-site", { env: ON, open: none.open })).toBeNull();
    expect(none.seen.opened).toBe(0);
  });

  it("never throws and always closes the browser, whatever the browser does", async () => {
    const siteId = built();
    for (const failOn of ["Page.getFrameTree", "Network.emulateNetworkConditions", "Page.setDocumentContent"]) {
      const b = fake({ failOn });
      await expect(pictureOfSite(siteId, { env: ON, open: b.open, settleMs: 1 })).resolves.toBeNull();
      expect(b.seen).toMatchObject({ opened: 1, closed: 1 });
    }
    const throwing = (async () => { throw new Error("spawn failed"); }) as unknown as typeof openBrowser;
    await expect(pictureOfSite(siteId, { env: ON, open: throwing })).resolves.toBeNull();
  });

  it("takes no picture of a window the page has left: what is shown is the built page or nothing", async () => {
    const siteId = built();
    for (const endsAt of ["https://example.com/", "chrome-error://chromewebdata/", ""]) {
      const b = fake({ endsAt });
      expect(await pictureOfSite(siteId, { env: ON, open: b.open, settleMs: 1 })).toBeNull();
      expect(b.seen.closed).toBe(1);
    }
  });

  it("gives up when it takes too long, and still closes the browser", async () => {
    const siteId = built(), b = fake({ shotAfterMs: 300 });
    const t0 = Date.now();
    expect(await pictureOfSite(siteId, { env: ON, open: b.open, settleMs: 1, timeoutMs: 40 })).toBeNull();
    expect(Date.now() - t0).toBeLessThan(250);
    expect(b.seen.closed).toBe(1);
  });
});
