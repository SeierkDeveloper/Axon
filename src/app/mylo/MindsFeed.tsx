"use client";

/* eslint-disable @next/next/no-img-element -- token pictures come from wherever their creators put them */

import { useEffect, useState } from "react";
import Link from "next/link";

// The minds of the tokens launched on Axon, thinking in public, next to Mylo: what each one noticed about its token
// and what it decided. Newest first, for anyone. Shows nothing until Agent Minds is switched on and a mind has thought.

interface Item { id: number; token: string; name: string | null; symbol: string | null; logo: string | null; at: string; modelLabel: string; thought: string | null; action: { kind: string; eth: number } | null; verdict: "none" | "approved" | "refused" }

const ACTION: Record<string, string> = { buyback: "buy back and burn", reward: "reward holders", burn_axon: "burn $AXON" };

function ago(at: string, now: number): string {
  const s = Math.max(0, Math.round((now - Date.parse(at)) / 1000));
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86_400) return `${Math.round(s / 3600)} h ago`;
  return `${Math.round(s / 86_400)} d ago`;
}

export default function MindsFeed() {
  const [items, setItems] = useState<Item[] | null>(null);
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    let alive = true;
    const load = () => fetch("/api/minds/thoughts?limit=6", { cache: "no-store" })
      .then((r) => (r.ok ? (r.json() as Promise<{ thoughts: Item[] }>) : null))
      .then((j) => { if (alive && j) { setItems(j.thoughts); setNow(Date.now()); } })
      .catch(() => {});
    void load();
    const t = setInterval(load, 30_000);
    return () => { alive = false; clearInterval(t); };
  }, []);

  if (!items?.length) return null;
  return (
    <section className="mt-10" aria-label="Minds, thinking in public">
      <div className="flex items-center gap-2.5 px-1">
        <span className="relative flex h-2 w-2"><span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-500 opacity-40 motion-reduce:animate-none" /><span className="relative inline-flex h-2 w-2 rounded-full bg-emerald-500" /></span>
        <h2 className="font-mono text-[11px] uppercase tracking-[0.22em] text-gray-500 dark:text-gray-400">Minds, thinking in public</h2>
      </div>
      <ol className="mt-3 overflow-hidden rounded-2xl border border-gray-200 bg-white dark:border-gray-800 dark:bg-gray-950">
        {items.map((it, i) => (
          <li key={it.id}>
            <Link href={`/launch?token=${it.token}`} className={`flex gap-3 px-4 py-3 transition hover:bg-gray-50 dark:hover:bg-gray-900 ${i ? "border-t border-gray-100 dark:border-gray-800" : ""}`}>
              {it.logo
                ? <img src={it.logo} alt="" width={28} height={28} loading="lazy" className="mt-0.5 h-7 w-7 shrink-0 rounded-lg bg-gray-100 object-cover dark:bg-gray-800" />
                : <span className="mt-0.5 grid h-7 w-7 shrink-0 place-items-center rounded-lg bg-gray-100 font-mono text-[9px] font-semibold text-gray-500 dark:bg-gray-800 dark:text-gray-400">{(it.symbol ?? "?").slice(0, 3)}</span>}
              <span className="min-w-0 flex-1">
                <span className="flex items-baseline justify-between gap-3">
                  <span className="truncate font-mono text-[11px] text-gray-400"><span className="font-semibold text-gray-900 dark:text-white">${it.symbol ?? "?"}</span> · {it.modelLabel}</span>
                  <span className="shrink-0 font-mono text-[11px] text-gray-400" suppressHydrationWarning>{ago(it.at, now)}</span>
                </span>
                <span className="mt-1 block text-sm leading-relaxed text-gray-700 dark:text-gray-300">{it.thought}</span>
                {it.action && (
                  <span className="mt-1.5 block font-mono text-[11px] text-gray-400">
                    proposed: {ACTION[it.action.kind] ?? it.action.kind} with {it.action.eth} ETH · {it.verdict === "approved" ? "passed the rule check" : "refused by the rule check"}
                  </span>
                )}
              </span>
            </Link>
          </li>
        ))}
      </ol>
    </section>
  );
}
