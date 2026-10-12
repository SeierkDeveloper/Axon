// Agents that build: a picture of what was built.
//
// When an agent has built a page, the line in the job's live log that says so carries a picture of it: the page as
// it opens, drawn by a browser on this server. So whoever watches a job sees what was made the moment it is made,
// and after a change sees the change, without opening the link.
//
// The page is drawn the way it is shown: bundled into one document and sealed (./siteBundle, ./siteSeal), so it runs
// with the same policy as at its address and reaches nothing. It is put into the browser's window directly, with
// that browser taken off the network first: no address is opened, and nothing leaves this server for it. The browser is one of the job browsers (./browserSession),
// with their limits; when none is free at once, or browsers are off or missing here, there is simply no picture.
//
// AGENT_SITES_PICTURE=off switches the pictures off on their own. They need AGENT_BROWSER=on (a browser to draw
// with) and are only ever taken for a job whose live log is on.

import { filesOf } from "./agentSites";
import { browserEnabled, browserLimits } from "./agentBrowser";
import { openBrowser } from "./browserSession";
import { bundle } from "./siteBundle";
import { seal } from "./siteSeal";
import { logger } from "./logger";

type Env = Record<string, string | undefined>;

export function sitePicturesEnabled(env: Env = process.env): boolean {
  return (env.AGENT_SITES_PICTURE ?? "on").trim().toLowerCase() !== "off" && browserEnabled(env);
}

/** A page gets this long to draw itself (its script to run, its fonts to be laid out) before the picture is taken. */
export const SETTLE_MS = 700;
/** The whole of it, from asking for a browser to the picture, may take this long. Past it there is no picture. */
export const PICTURE_TIMEOUT_MS = 15_000;
/** A job waits at most this long for a browser to come free: a build is not held up for its picture. */
const WAIT_SECONDS = 3;
const QUALITY = 70;

/**
 * The page a site opens with, as a JPEG, or null when no picture can be had. Never throws and never takes longer
 * than its time: a build must not fail, or wait long, because a picture of it could not be taken.
 */
export async function pictureOfSite(siteId: string, o: { taskId?: string; env?: Env; open?: typeof openBrowser; settleMs?: number; timeoutMs?: number } = {}): Promise<Buffer | null> {
  const env = o.env ?? process.env;
  if (!sitePicturesEnabled(env)) return null;
  let close: (() => Promise<void>) | null = null;
  let timer: NodeJS.Timeout | undefined;
  const t0 = Date.now();
  const draw = async (): Promise<Buffer | null> => {
    const page = bundle(filesOf(siteId));
    if (page === null) return null;
    const got = await (o.open ?? openBrowser)({ env, taskId: o.taskId, limits: { ...browserLimits(env), waitSeconds: WAIT_SECONDS, seconds: 30 } });
    if (!got.ok) { logger.info("sites.picture_skipped", "No browser for a picture of a built page", { taskId: o.taskId, siteId, why: got.refused }); return null; }
    const s = got.session;
    close = () => s.close();
    const tree = await s.command("Page.getFrameTree");
    const frameId = String(((tree.frameTree as { frame?: { id?: string } } | undefined)?.frame?.id) ?? "");
    if (!frameId) return null;
    // Here the page is the window itself, not a frame inside a holder, so the one thing the seal leaves to its holder
    // (a page sending itself somewhere else) is closed another way: this browser is taken off the network before the
    // page goes in, and a window that is no longer where it was put gives no picture.
    await s.command("Network.enable");
    await s.command("Network.emulateNetworkConditions", { offline: true, latency: 0, downloadThroughput: -1, uploadThroughput: -1 });
    await s.command("Page.setDocumentContent", { frameId, html: seal(page) });
    await new Promise((r) => setTimeout(r, o.settleMs ?? SETTLE_MS));
    const at = await s.where().catch(() => ({ url: "" }));
    if (at.url !== "about:blank") { logger.warn("sites.picture_left", "A built page left its window while its picture was taken", { taskId: o.taskId, siteId }); return null; }
    return s.screenshot(QUALITY);
  };
  try {
    const jpeg = await Promise.race([draw(), new Promise<null>((r) => { timer = setTimeout(() => r(null), o.timeoutMs ?? PICTURE_TIMEOUT_MS); })]);
    if (jpeg) logger.info("sites.picture", "A picture of a built page was taken", { taskId: o.taskId, siteId, bytes: jpeg.length, ms: Date.now() - t0 });
    return jpeg && jpeg.length ? jpeg : null;
  } catch (err) {
    logger.warn("sites.picture_failed", "A picture of a built page could not be taken", { taskId: o.taskId, siteId, err });
    return null;
  } finally {
    clearTimeout(timer);
    await (close as (() => Promise<void>) | null)?.().catch(() => undefined);
  }
}
