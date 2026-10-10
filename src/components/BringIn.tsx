"use client";

import { useEffect, useState } from "react";

/**
 * Bring in another agent: a small search over the agents on the network, for picking the one a follow-up goes to
 * instead of the agent that did the job so far. It lists only agents that can join a conversation: ones Axon runs,
 * and, where nothing can be paid from this page, only the free ones.
 */

export interface Helper { id: string; name: string; price: string | null }
interface Listed { agentId: string; name: string; capabilities?: string[]; category?: string | null; price?: string | null; endpoint?: string | null; orchestrator?: boolean }

/** A typed word as the first letters it shares with its relatives: "translator" finds "translation", "designer" finds "design". */
const stem = (word: string): string => word.toLowerCase().replace(/[^a-z0-9]/g, "").slice(0, 5);

/** How well an agent fits what was typed: its name counts double, then what it does. Zero is no fit. */
function fit(agent: Listed, words: string[]): number {
  const name = agent.name.toLowerCase(), does = `${(agent.capabilities ?? []).join(" ")} ${agent.category ?? ""}`.toLowerCase();
  return words.reduce((n, w) => n + (name.includes(w) ? 2 : 0) + (does.includes(w) ? 1 : 0), 0);
}

export default function BringIn({ exclude, canPay, onPick, disabled }: {
  /** agents not to offer: the one the follow-up would go to anyway */
  exclude: string[];
  /** a paid agent can be paid from this page */
  canPay: boolean;
  onPick: (agent: Helper) => void;
  disabled?: boolean;
}) {
  const [q, setQ] = useState("");
  const [all, setAll] = useState<Listed[] | null>(null);
  const skip = exclude.join(",");

  // The agents on the network, read once. What is typed is matched here, against each agent's name and what it
  // does, so the search works the same whether or not the server has a search of its own.
  useEffect(() => {
    let alive = true;
    void fetch("/api/agents?sort=proven&limit=200")
      .then(async (r) => (r.ok ? ((await r.json()) as { agents?: Listed[] }) : null))
      .then((d) => { if (alive) setAll(d?.agents ?? []); })
      .catch(() => { if (alive) setAll([]); });
    return () => { alive = false; };
  }, []);

  const out = new Set(skip.split(","));
  const can = (all ?? []).filter((a) => !out.has(a.agentId) && !(a.endpoint && !a.orchestrator) && (canPay || !a.price));
  const words = q.split(/\s+/).map(stem).filter((w) => w.length >= 3);
  const found = all === null
    ? null
    : (words.length ? can.map((a) => ({ a, n: fit(a, words) })).filter((x) => x.n > 0).sort((x, y) => y.n - x.n).map((x) => x.a) : can).slice(0, 6);

  return (
    <div className="mt-2 rounded-md border border-gray-200 bg-gray-50/60 p-2.5 dark:border-gray-800 dark:bg-gray-900/40">
      <input
        value={q}
        onChange={(e) => setQ(e.target.value)}
        placeholder="What kind of help? A designer, a translator, an analyst…"
        disabled={disabled}
        className="w-full rounded-md border border-gray-200 bg-white px-3 py-1.5 text-sm text-gray-900 placeholder:text-gray-400 focus:border-teal-400 focus:outline-none disabled:opacity-60 dark:border-gray-700 dark:bg-gray-900 dark:text-white"
      />
      {found === null && <p className="mt-2 text-[11px] text-gray-400">Looking…</p>}
      {found && found.length === 0 && <p className="mt-2 text-[11px] text-gray-500 dark:text-gray-400">No agent found for that. Try another word.</p>}
      {found && found.length > 0 && (
        <ul className="mt-2 space-y-1">
          {found.map((a) => (
            <li key={a.agentId}>
              <button
                type="button"
                onClick={() => onPick({ id: a.agentId, name: a.name, price: a.price ?? null })}
                disabled={disabled}
                className="flex w-full items-center gap-2 rounded-md border border-transparent px-2 py-1.5 text-left text-xs transition-colors hover:border-teal-300 hover:bg-white disabled:opacity-50 dark:hover:border-teal-800 dark:hover:bg-gray-900"
              >
                <span className="shrink-0 font-semibold text-gray-900 dark:text-white">{a.name}</span>
                <span className="min-w-0 flex-1 truncate text-gray-500 dark:text-gray-400">{(a.capabilities ?? []).slice(0, 3).join(", ")}</span>
                <span className="shrink-0 font-mono text-[11px] text-gray-600 dark:text-gray-300">{a.price ?? "Free"}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
      <p className="mt-2 text-[11px] text-gray-400 dark:text-gray-500">It joins this conversation with what was said and the files. Each agent is paid for its own part.</p>
    </div>
  );
}
