import { NextRequest } from "next/server";
import { sitesEnabled } from "@/lib/agentSites";
import { goneHtml, viewerHeaders, viewSite } from "@/lib/siteViewer";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// /s/<site>: the address a built page opens at. It answers with the holder page (src/lib/siteViewer.ts), sent with
// the policy that completes the seal, whatever it shows: the built page, or that there is none, or that it was
// taken down. Anybody with the address can open it; the address itself cannot be guessed.
export async function GET(_req: NextRequest, { params }: { params: Promise<{ siteId: string }> }) {
  const { siteId } = await params;
  if (!sitesEnabled() || !/^[A-Za-z0-9_-]{8,40}$/.test(siteId)) return new Response(goneHtml("missing"), { status: 404, headers: viewerHeaders() });
  const seen = viewSite(siteId);
  return new Response(seen.html, { status: seen.status, headers: viewerHeaders() });
}
