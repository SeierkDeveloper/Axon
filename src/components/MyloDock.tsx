"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import AgentCore from "@/components/AgentCore";
import { useWallet } from "@/components/WalletProvider";

// Mylo in the corner of every page: a small face that follows the cursor like the big one, and opens Mylo on a click.
// It steps aside wherever the page already shows a face (home, Studio, Autonomy, Mylo's own page, the 404), so there is
// only ever one face on screen. A signed-in wallet with something new from Mylo sees a dot on it.

export default function MyloDock() {
  const pathname = usePathname();
  const [hidden, setHidden] = useState(true);
  const { apiKey } = useWallet();
  const [unread, setUnread] = useState(0);

  useEffect(() => {
    if (!apiKey || hidden) return;
    let alive = true;
    fetch("/api/mylo/inbox", { headers: { authorization: `Bearer ${apiKey}` }, cache: "no-store" })
      .then((r) => (r.ok ? r.json() : null)).then((j: { unread?: number } | null) => { if (alive) setUnread(j?.unread ?? 0); }).catch(() => {});
    return () => { alive = false; };
  }, [apiKey, hidden, pathname]);

  useEffect(() => {
    // after the new page has drawn: is there a face on it already (other than this one)?
    const t = setTimeout(() => {
      const others = [...document.querySelectorAll(".agent-face")].filter((el) => !el.closest(".mylo-dock") && !el.closest(".page-transition"));
      setHidden(pathname === "/mylo" || others.length > 0);
    }, 400);
    return () => clearTimeout(t);
  }, [pathname]);

  if (hidden) return null;
  return (
    <Link href="/mylo" className="mylo-dock group fixed bottom-5 right-5 z-40 flex items-center gap-3" aria-label="Talk to Mylo, Axon's own AI">
      <span className="pointer-events-none rounded-full border border-gray-200 bg-white px-3 py-1.5 text-xs font-medium text-gray-900 opacity-0 shadow-sm transition group-hover:opacity-100 group-focus-visible:opacity-100 dark:border-gray-800 dark:bg-gray-950 dark:text-white">Ask Mylo</span>
      <span className="relative">
        <AgentCore size={72} label={unread ? `Mylo, ${unread} new` : "Mylo"} />
        {apiKey && unread > 0 && <span className="absolute -right-1 -top-1 grid h-5 min-w-5 place-items-center rounded-full bg-emerald-500 px-1 text-[10px] font-bold text-white ring-2 ring-white dark:ring-gray-950">{unread > 9 ? "9+" : unread}</span>}
      </span>
    </Link>
  );
}
