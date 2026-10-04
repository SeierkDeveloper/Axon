"use client";

import { useEffect, useState } from "react";
import Link from "next/link";

// Mylo thinking in public: what it noticed on the network and why, newest first, for anyone. It refreshes on its own
// while the page is open. A wallet's own notices never appear here.

interface Item { id: string; kind: string; text: string; link: string | null; at: string }

const LABEL: Record<string, string> = { hired: "Hired", built: "New agent", improved: "Better", rerouted: "Rerouted", repaired: "Repaired", burned: "Burned", launched: "Launched", earned: "Earned", thought: "Thinking" };

function ago(at: string, now: number): string {
  const s = Math.max(0, Math.round((now - Date.parse(at)) / 1000));
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86_400) return `${Math.round(s / 3600)} h ago`;
  return `${Math.round(s / 86_400)} d ago`;
}

export default function MyloFeed() {
  const [items, setItems] = useState<Item[] | null>(null);
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    let alive = true;
    const load = () => fetch("/api/mylo/feed?limit=8", { cache: "no-store" }).then((r) => r.json()).then((j: { items: Item[] }) => { if (alive) { setItems(j.items); setNow(Date.now()); } }).catch(() => {});
    load();
    const t = setInterval(load, 30_000);
    return () => { alive = false; clearInterval(t); };
  }, []);

  if (!items?.length) return null;
  return (
    <section className="mt-14" aria-label="Mylo, thinking in public">
      <div className="flex items-center gap-2.5 px-1">
        <span className="relative flex h-2 w-2"><span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-500 opacity-40" /><span className="relative inline-flex h-2 w-2 rounded-full bg-emerald-500" /></span>
        <h2 className="font-mono text-[11px] uppercase tracking-[0.22em] text-gray-500 dark:text-gray-400">Thinking in public</h2>
      </div>
      <ol className="mt-3 overflow-hidden rounded-2xl border border-gray-200 bg-white dark:border-gray-800 dark:bg-gray-950">
        {items.map((it, i) => {
          const label = <span className="font-mono text-[10px] uppercase tracking-[0.16em] text-gray-400">{LABEL[it.kind] ?? it.kind}</span>;
          const when = <span className="font-mono text-[11px] text-gray-400">{ago(it.at, now)}</span>;
          const body = (
            <>
              {/* phone: label and time on one line, the words under them; wider: three columns */}
              <span className="flex items-center justify-between sm:hidden">{label}{when}</span>
              <span className="mt-1 block text-sm leading-relaxed text-gray-700 sm:hidden dark:text-gray-300">{it.text}</span>
              <span className="hidden items-start gap-3 sm:flex">
                <span className="w-20 shrink-0 pt-0.5">{label}</span>
                <span className="min-w-0 flex-1 text-sm leading-relaxed text-gray-700 dark:text-gray-300">{it.text}</span>
                <span className="shrink-0 pt-0.5">{when}</span>
              </span>
            </>
          );
          const cls = `block px-4 py-3 ${i ? "border-t border-gray-100 dark:border-gray-800" : ""}`;
          return <li key={it.id}>{it.link?.startsWith("/") ? <Link href={it.link} className={`${cls} transition hover:bg-gray-50 dark:hover:bg-gray-900`}>{body}</Link> : <div className={cls}>{body}</div>}</li>;
        })}
      </ol>
    </section>
  );
}
