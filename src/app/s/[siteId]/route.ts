import { NextRequest } from "next/server";
import { sitesEnabled } from "@/lib/agentSites";
import { goneHtml, viewerHeaders, viewSite } from "@/lib/siteViewer";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// /s/<site>: the address a built page opens at. It answers with the holder page (src/lib/siteViewer.ts), sent with
// the policy that completes the seal, whatever it shows: the built page, or that there is none, or that it was
// taken down. Anybody with the address can open it; the address itself cannot be guessed. With ?v=<n> it shows an
// earlier version that is still kept.
export async function GET(req: NextRequest, { params }: { params: Promise<{ siteId: string }> }) {
  const { siteId } = await params;
  if (!sitesEnabled() || !/^[A-Za-z0-9_-]{8,40}$/.test(siteId)) return new Response(goneHtml("missing"), { status: 404, headers: viewerHeaders() });
  // ?v=2 looks at an earlier version that is still kept; anything that is not a version number is ignored
  const v = req.nextUrl.searchParams.get("v");
  const seen = viewSite(siteId, v && /^\d{1,6}$/.test(v) ? Number(v) : undefined);
  return new Response(seen.html, { status: seen.status, headers: viewerHeaders() });
}
