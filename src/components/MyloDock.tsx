"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import AgentCore from "@/components/AgentCore";

// Mylo in the corner of every page: a small face that follows the cursor like the big one, and opens Mylo on a click.
// It steps aside wherever the page already shows a face (home, Studio, Autonomy, Mylo's own page, the 404), so there is
// only ever one face on screen.

export default function MyloDock() {
  const pathname = usePathname();
  const [hidden, setHidden] = useState(true);

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
      <AgentCore size={72} label="Mylo" />
    </Link>
  );
}
