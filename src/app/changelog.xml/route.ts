// /changelog.xml: what Axon shipped, as an Atom feed. The same list the Roadmap page shows under "Shipped".
import { changelogFeed } from "@/lib/changelog";

export const runtime = "nodejs";
export const dynamic = "force-static";

export function GET() {
  return new Response(changelogFeed(), {
    headers: { "content-type": "application/atom+xml; charset=utf-8", "cache-control": "public, max-age=600" },
  });
}
