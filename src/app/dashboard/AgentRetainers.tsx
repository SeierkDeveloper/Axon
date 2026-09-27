"use client";

// The agent owner's side of retainers: under each of their agents, who keeps it on a schedule and what
// that has been worth over the last 30 days. Shows nothing until the agent has a standing client.

import { useEffect, useState } from "react";

interface Client {
  client: string;
  scheduleText: string;
  payIn: "ETH" | "AXON";
  status: "active" | "paused";
  runsDone: number;
  since: string;
  nextRunAt: string | null;
}
interface View {
  clients: number;
  active: number;
  paused: number;
  last30Days: { runs: number; completed: number; earned: string };
  retainers: Client[];
}

const short = (w: string) => `${w.slice(0, 6)}…${w.slice(-4)}`;
const day = (iso: string) => new Date(iso).toLocaleDateString(undefined, { day: "numeric", month: "short" });

export default function AgentRetainers({ agentId, apiKey, discountBps }: { agentId: string; apiKey: string; discountBps: number }) {
  const [view, setView] = useState<View | null>(null);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    let alive = true;
    fetch(`/api/agents/${encodeURIComponent(agentId)}/retainers`, { headers: { Authorization: `Bearer ${apiKey}` } })
      .then((r) => (r.ok ? r.json() : null))
      .then((v: View | null) => { if (alive) setView(v); })
      .catch(() => {});
    return () => { alive = false; };
  }, [agentId, apiKey]);

  if (!view || view.retainers.length === 0) return null;

  return (
    <div className="mt-3 rounded-lg border border-gray-100 dark:border-gray-800 p-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-xs text-gray-600 dark:text-gray-300">
          <span className="font-semibold text-gray-900 dark:text-white">Retainers:</span>{" "}
          {view.clients} {view.clients === 1 ? "client" : "clients"} · {view.active} active
          {view.paused > 0 && ` · ${view.paused} paused`} · {view.last30Days.completed} runs, {view.last30Days.earned} ETH in 30 days
          {discountBps > 0 && ` · ${discountBps / 100}% off for them`}
        </p>
        <button
          onClick={() => setOpen((o) => !o)}
          className="text-[11px] px-2 py-0.5 rounded border border-gray-200 dark:border-gray-700 text-gray-500 dark:text-gray-400 hover:border-gray-400 dark:hover:border-gray-500"
        >
          {open ? "Hide" : "Clients"}
        </button>
      </div>
      {open && (
        <ul className="mt-2 divide-y divide-gray-100 dark:divide-gray-800">
          {view.retainers.map((r, i) => (
            <li key={`${r.client}-${i}`} className="py-2 text-xs text-gray-500 dark:text-gray-400">
              <span className="font-mono text-gray-700 dark:text-gray-200">{short(r.client)}</span> · {r.scheduleText}
              {r.payIn === "AXON" && " · pays in $AXON"} · {r.runsDone} {r.runsDone === 1 ? "run" : "runs"} since {day(r.since)}
              {r.status === "paused" && <span className="text-amber-700 dark:text-amber-400"> · paused</span>}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
