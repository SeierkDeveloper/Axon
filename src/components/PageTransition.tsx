"use client";

import { useEffect, useRef, useState } from "react";
import { usePathname } from "next/navigation";
import AgentCore from "@/components/AgentCore";

// Between pages: Axon's face comes up, glances one way and the other, blinks, and the next page is there. It starts on
// the click and stays at least MIN_MS, so the face always gets to finish its look around, and never longer than the
// next page actually takes beyond that. Only in-site links start it; new tabs, downloads, anchors on the same page and
// back/forward go straight through. Anyone who asked for less motion gets none.

const MIN_MS = 900;
const FADE_MS = 200;
const GIVE_UP_MS = 8_000;

type Phase = "off" | "in" | "out";

export default function PageTransition() {
  const pathname = usePathname();
  const [phase, setPhase] = useState<Phase>("off");
  const startedAt = useRef(0);
  const from = useRef(pathname);

  // a click on a link to another page of the site
  useEffect(() => {
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    const onClick = (e: MouseEvent) => {
      if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
      const a = (e.target as Element | null)?.closest?.("a");
      if (!a || !a.href || a.target === "_blank" || a.hasAttribute("download")) return;
      const url = new URL(a.href, window.location.href);
      if (url.origin !== window.location.origin || url.pathname === window.location.pathname) return;
      from.current = window.location.pathname;
      startedAt.current = performance.now();
      setPhase("in");
    };
    // capture, so this sees the click before Next's link takes it over
    document.addEventListener("click", onClick, true);
    return () => document.removeEventListener("click", onClick, true);
  }, []);

  // the new page is in: let the face finish, then fade out
  useEffect(() => {
    if (phase !== "in") return;
    const done = pathname !== from.current;
    const wait = done ? Math.max(0, MIN_MS - (performance.now() - startedAt.current)) : GIVE_UP_MS;
    const t = setTimeout(() => setPhase("out"), wait);
    return () => clearTimeout(t);
  }, [phase, pathname]);

  useEffect(() => {
    if (phase !== "out") return;
    const t = setTimeout(() => setPhase("off"), FADE_MS);
    return () => clearTimeout(t);
  }, [phase]);

  if (phase === "off") return null;
  return (
    <div className={`page-transition ${phase === "out" ? "is-out" : ""}`} role="status" aria-label="Loading">
      <AgentCore state="travel" size={120} label="Loading" />
    </div>
  );
}
