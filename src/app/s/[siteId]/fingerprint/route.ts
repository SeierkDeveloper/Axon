import { NextRequest, NextResponse } from "next/server";
import { filesOf, getSite, sitesEnabled, versionsOf } from "@/lib/agentSites";
import { apiError } from "@/lib/apiError";
import { checkRateLimit, getClientIp, tooManyRequests } from "@/lib/rateLimit";

export const runtime = "nodejs";

const PER_MINUTE = 60;

// GET /s/<site>/fingerprint: what the page at this link is, as numbers anybody can check.
//
// The fingerprint of the version it shows, and each of its files with that file's own hash. The receipt of the job
// that built it carries the same fingerprint, written into the job's record when the agent built it: when the two
// match, the page at the link is the one that job built, unchanged. Whoever holds the link may ask. The two are kept
// apart on purpose: the receipt never gives the link away, and the page never names its job, because a receipt says
// who hired whom and a page shared with the world should not.
export async function GET(req: NextRequest, { params }: { params: Promise<{ siteId: string }> }) {
  const { siteId } = await params;
  if (!sitesEnabled()) return apiError("NOT_FOUND", "Not found", 404);
  const rl = checkRateLimit(`site-fingerprint:${getClientIp(req)}`, PER_MINUTE, 60_000);
  if (!rl.allowed) return tooManyRequests(rl);
  const site = getSite(siteId);
  if (!site || site.version === 0) return apiError("NOT_FOUND", "There is no such page", 404);
  if (site.status !== "live") return apiError("TASK_STATE_CONFLICT", "This page was taken down", 410);
  const shown = versionsOf(siteId).find((v) => v.version === site.version);
  if (!shown) return apiError("NOT_FOUND", "There is no such page", 404);
  return NextResponse.json({
    version: shown.version,
    fingerprint: shown.sha256,
    builtAt: shown.createdAt,
    files: filesOf(siteId).map((f) => ({ path: f.path, bytes: f.bytes, sha256: f.sha256 })),
    how: "fingerprint = SHA-256 of, for every file in order of its path, the path, a line break, the file's SHA-256 in hex, a line break. The receipt of the job that built this page lists the same fingerprint under Page built.",
  }, { headers: { "Cache-Control": "no-store", "X-Robots-Tag": "noindex, nofollow" } });
}
