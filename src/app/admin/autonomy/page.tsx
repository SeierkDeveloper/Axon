import { timingSafeEqual } from "crypto";
import type { Metadata } from "next";
import { getDb } from "@/lib/db";
import SiteNav from "@/components/SiteNav";
import { getLatestNetworkRun, getNetworkRunsSince, type NetworkObservation } from "@/lib/autonomyNetwork";
import { VISIBILITY, actionsEnabled, type FindingKind } from "@/lib/autonomyPolicy";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Autonomy | Axon Admin", robots: { index: false, follow: false } };

// /admin/autonomy?key=<CRON_SECRET>: the network pass in full. Every finding with its subject and reason, every
// action, price changes with their amounts, the routing state, and the last day pass by pass. The public /autonomy
// page shows counts of upkeep only.

function allowed(key: string | undefined): boolean {
  const secret = process.env.CRON_SECRET?.trim();
  if (!secret || !key) return false;
  const a = Buffer.from(key), b = Buffer.from(secret);
  return a.length === b.length && timingSafeEqual(a, b);
}

function ago(iso: string | null): string {
  if (!iso) return "never";
  const mins = Math.floor((Date.now() - Date.parse(iso)) / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const h = Math.floor(mins / 60);
  return h < 48 ? `${h}h ago` : `${Math.floor(h / 24)}d ago`;
}

type Paused = { agent_id: string; name: string; routing_paused_at: string; routing_pause_reason: string | null; routing_retested_at: string | null; routing_passes: number };
type Weighted = { agent_id: string; name: string; routing_weight: number };

function routingState(): { paused: Paused[]; weighted: Weighted[] } {
  try {
    const db = getDb();
    return {
      paused: db.prepare("SELECT agent_id, name, routing_paused_at, routing_pause_reason, routing_retested_at, routing_passes FROM agents WHERE routing_paused_at IS NOT NULL ORDER BY routing_paused_at DESC").all() as Paused[],
      weighted: db.prepare("SELECT agent_id, name, routing_weight FROM agents WHERE routing_weight < 1 ORDER BY routing_weight").all() as Weighted[],
    };
  } catch {
    return { paused: [], weighted: [] }; // before migration 077
  }
}

const card = "rounded-lg border border-gray-200 dark:border-gray-800";
const head = "text-sm font-semibold text-gray-900 dark:text-white mb-3 mt-10";

export default async function AdminAutonomyPage({ searchParams }: { searchParams: Promise<{ key?: string }> }) {
  const { key } = await searchParams;
  if (!allowed(key)) {
    return (
      <div className="bg-white dark:bg-[#0a0a0a] min-h-screen">
        <SiteNav />
        <main className="max-w-xl mx-auto px-6 pt-32 text-sm text-gray-500">Not authorized.</main>
      </div>
    );
  }

  const latest = getLatestNetworkRun();
  const day = getNetworkRunsSince(24);
  const { paused, weighted } = routingState();
  const byKind = new Map<FindingKind, NetworkObservation[]>();
  for (const o of latest?.observations ?? []) byKind.set(o.kind, [...(byKind.get(o.kind) ?? []), o]);
  const kinds = [...byKind.keys()].sort((a, b) => (VISIBILITY[a] === VISIBILITY[b] ? a.localeCompare(b) : VISIBILITY[a] === "admin" ? -1 : 1));

  return (
    <div className="bg-white dark:bg-[#0a0a0a] min-h-screen text-[#0a0a0a] dark:text-white">
      <SiteNav />
      <main className="max-w-5xl mx-auto px-6 pt-32 pb-24">
        <p className="text-xs font-mono text-gray-400 tracking-wider mb-3">ADMIN · AUTONOMY</p>
        <h1 className="text-3xl font-bold mb-2">The network pass, in full</h1>
        <p className="text-sm text-gray-500 dark:text-gray-400">
          Actions are <b className={actionsEnabled() ? "text-emerald-600" : "text-red-600"}>{actionsEnabled() ? "on" : "off (AUTONOMY_ACTIONS=off)"}</b>.
          {latest ? ` Last pass ${ago(latest.finishedAt)}: ${latest.agentsSeen} agents, ${latest.checksRun ?? "?"} checks` : " No pass recorded yet."}
          {latest?.checksUnavailable?.length ? `, could not run: ${latest.checksUnavailable.join(", ")}` : ""}
          {latest ? `. ${day.length} passes in the last 24 hours.` : ""}
        </p>

        <h2 className={head}>Findings and actions, last pass</h2>
        {kinds.length === 0 ? (
          <p className={`${card} px-5 py-4 text-sm text-gray-500`}>Nothing found on the last pass.</p>
        ) : (
          <div className="space-y-4">
            {kinds.map((k) => (
              <div key={k} className={card}>
                <div className="px-5 py-3 border-b border-gray-100 dark:border-gray-800 flex items-center justify-between">
                  <span className="font-mono text-sm">{k}</span>
                  <span className="text-xs font-mono text-gray-400">
                    {byKind.get(k)!.length} · {VISIBILITY[k] === "public" ? "counted publicly" : "admin only"}
                  </span>
                </div>
                <ul className="divide-y divide-gray-100 dark:divide-gray-800">
                  {byKind.get(k)!.slice(0, 50).map((o, i) => (
                    <li key={`${o.subject}-${i}`} className="px-5 py-2.5 text-sm">
                      {o.subject && <span className="font-mono text-xs text-gray-500 mr-3">{o.subject}</span>}
                      <span className="text-gray-800 dark:text-gray-200">{o.what}</span>
                      {o.why && <span className="block text-xs text-gray-500 mt-0.5">{o.why}</span>}
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </div>
        )}

        {latest && latest.changes.length > 0 && (
          <>
            <h2 className={head}>Price changes (opted-in agents)</h2>
            <ul className={`${card} divide-y divide-gray-100 dark:divide-gray-800`}>
              {latest.changes.map((c, i) => (
                <li key={`${c.agentId}-${i}`} className="px-5 py-2.5 text-sm">
                  <span className="font-mono text-xs text-gray-500 mr-3">{c.agentId}</span>
                  {c.what}
                </li>
              ))}
            </ul>
          </>
        )}

        <h2 className={head}>Routing now</h2>
        <div className={card}>
          {paused.length === 0 && weighted.length === 0 ? (
            <p className="px-5 py-4 text-sm text-gray-500">Every agent is in routing at full weight.</p>
          ) : (
            <ul className="divide-y divide-gray-100 dark:divide-gray-800">
              {paused.map((a) => (
                <li key={a.agent_id} className="px-5 py-2.5 text-sm">
                  <span className="font-mono text-xs text-gray-500 mr-3">{a.agent_id}</span>
                  paused {ago(a.routing_paused_at)} · re-tested {ago(a.routing_retested_at)} · {a.routing_passes} pass
                  {a.routing_passes === 1 ? "" : "es"} in a row
                  {a.routing_pause_reason && <span className="block text-xs text-gray-500 mt-0.5">{a.routing_pause_reason}</span>}
                </li>
              ))}
              {weighted.map((a) => (
                <li key={a.agent_id} className="px-5 py-2.5 text-sm">
                  <span className="font-mono text-xs text-gray-500 mr-3">{a.agent_id}</span>
                  routing weight {a.routing_weight}
                </li>
              ))}
            </ul>
          )}
        </div>

        <h2 className={head}>Last 24 hours</h2>
        <div className={`${card} overflow-x-auto`}>
          <table className="w-full text-sm">
            <thead className="text-xs text-gray-400 font-mono">
              <tr className="border-b border-gray-100 dark:border-gray-800">
                <th className="text-left px-5 py-2 font-normal">pass</th>
                <th className="text-right px-3 py-2 font-normal">agents</th>
                <th className="text-right px-3 py-2 font-normal">checks</th>
                <th className="text-left px-3 py-2 font-normal">could not run</th>
                <th className="text-right px-3 py-2 font-normal">admin findings</th>
                <th className="text-right px-5 py-2 font-normal">public</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100 dark:divide-gray-800">
              {day.map((r) => (
                <tr key={r.runId}>
                  <td className="px-5 py-2 font-mono text-xs">{r.startedAt.slice(5, 16).replace("T", " ")} UTC</td>
                  <td className="px-3 py-2 text-right tabular-nums">{r.agentsSeen}</td>
                  <td className="px-3 py-2 text-right tabular-nums">{r.checksRun ?? "?"}</td>
                  <td className="px-3 py-2 text-xs text-gray-500">{r.checksUnavailable?.join(", ") || ""}</td>
                  <td className="px-3 py-2 text-right tabular-nums">{r.observations.filter((o) => VISIBILITY[o.kind] === "admin").length}</td>
                  <td className="px-5 py-2 text-right tabular-nums">{r.observations.filter((o) => VISIBILITY[o.kind] === "public").length + r.changes.length}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </main>
    </div>
  );
}
