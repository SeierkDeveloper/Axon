"use client";

import { useCallback, useEffect, useState } from "react";

// What a creator's Studio agents have earned, and the button that sends it to their wallet. Withdrawals go to the
// wallet that owns the agent and nowhere else; each one shows with its transaction.

interface Earning { agentId: string; name: string; earnedEth: number; withdrawnEth: number; availableEth: number; token?: string | null }
interface Withdrawal { id: string; agentId: string; amountEth: string; status: "pending" | "sent" | "failed"; txHash: string | null; createdAt: string }
interface Proposal { id: string; agentId: string; weakJobs: number; fromScore: number | null; toScore: number | null }
interface Data { agents: Earning[]; withdrawals: Withdrawal[]; proposals: Proposal[]; rules: { minEth: number; maxPerDayEth: number }; open: boolean }

const EXPLORER = "https://robinhoodchain.blockscout.com";
const eth = (x: number) => (x === 0 ? "0" : x < 0.0001 ? x.toExponential(2) : x.toFixed(x < 1 ? 5 : 3).replace(/0+$/, "").replace(/\.$/, ""));

export default function Earnings({ apiKey, refreshKey }: { apiKey: string; refreshKey: string }) {
  const [data, setData] = useState<Data | null>(null);
  const [amounts, setAmounts] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState<{ agentId: string; text: string; ok: boolean } | null>(null);

  const fetchData = useCallback(() => fetch("/api/studio/earnings", { headers: { authorization: `Bearer ${apiKey}` } }).then((r) => (r.ok ? (r.json() as Promise<Data>) : null)), [apiKey]);
  useEffect(() => {
    let alive = true;
    fetchData().then((d) => { if (alive && d) setData(d); }).catch(() => {});
    return () => { alive = false; };
  }, [fetchData, refreshKey]);

  const take = async (a: Earning) => {
    const amountEth = Number(amounts[a.agentId] || a.availableEth);
    setBusy(a.agentId);
    setMsg(null);
    const r = await fetch("/api/studio/withdraw", { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` }, body: JSON.stringify({ agentId: a.agentId, amountEth }) });
    const j = (await r.json().catch(() => ({}))) as { error?: string };
    setBusy(null);
    setMsg({ agentId: a.agentId, ok: r.ok, text: r.ok ? `Sent ${eth(amountEth)} ETH to your wallet.` : (j.error ?? "It could not be sent.") });
    setAmounts((m) => ({ ...m, [a.agentId]: "" }));
    const d = await fetchData().catch(() => null);
    if (d) setData(d);
  };

  const decide = async (p: Proposal, apply: boolean) => {
    setBusy(p.id);
    const r = await fetch(`/api/studio/improvements/${p.id}`, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` }, body: JSON.stringify({ apply }) });
    setBusy(null);
    setMsg({ agentId: p.agentId, ok: r.ok, text: r.ok ? (apply ? "Applied. Your agent runs the better version now." : "Dismissed.") : "That could not be done." });
    const d = await fetchData().catch(() => null);
    if (d) setData(d);
  };

  if (!data || data.agents.length === 0) return null;
  return (
    <div className="mt-8">
      <p className="text-xs font-mono uppercase tracking-[0.2em] text-gray-400">Your earnings</p>
      <ul className="mt-2 space-y-2">
        {data.agents.map((a) => (
          <li key={a.agentId} className="rounded-xl border border-gray-200 p-3 dark:border-gray-800">
            <div className="flex items-baseline justify-between gap-3">
              <a href={`/agents/${a.agentId}`} className="truncate text-sm font-medium text-gray-900 hover:underline dark:text-white">{a.name}</a>
              <span className="shrink-0 font-mono text-sm text-gray-900 dark:text-white">{eth(a.availableEth)} ETH</span>
            </div>
            <p className="mt-0.5 font-mono text-[11px] text-gray-400">earned {eth(a.earnedEth)} · taken out {eth(a.withdrawnEth)} · {a.token ? <a href={`/launch?token=${a.token}`} className="underline hover:text-gray-900 dark:hover:text-white">its token</a> : <a href={`/launch/${a.agentId}`} className="underline hover:text-gray-900 dark:hover:text-white">launch its token</a>}</p>
            {data.proposals.filter((p) => p.agentId === a.agentId).map((p) => (
              <div key={p.id} className="mt-2 rounded-lg bg-gray-50 p-2.5 dark:bg-gray-900/60">
                <p className="text-xs text-gray-700 dark:text-gray-300">Axon found a better version: <b className="font-mono">{p.fromScore?.toFixed(1)} → {p.toScore?.toFixed(1)}</b>, from {p.weakJobs} jobs it got wrong, tested on the same tasks.</p>
                <div className="mt-1.5 flex gap-2">
                  <button type="button" onClick={() => void decide(p, true)} disabled={busy !== null} className="rounded-md bg-gray-900 px-2.5 py-1 text-xs font-semibold text-white disabled:opacity-50 dark:bg-white dark:text-gray-900">Apply</button>
                  <button type="button" onClick={() => void decide(p, false)} disabled={busy !== null} className="rounded-md border border-gray-200 px-2.5 py-1 text-xs text-gray-600 disabled:opacity-50 dark:border-gray-700 dark:text-gray-300">Dismiss</button>
                </div>
              </div>
            ))}
            {a.availableEth >= data.rules.minEth && data.open && (
              <div className="mt-2 flex gap-2">
                <input inputMode="decimal" placeholder={eth(a.availableEth)} value={amounts[a.agentId] ?? ""} onChange={(e) => setAmounts((m) => ({ ...m, [a.agentId]: e.target.value.replace(/[^0-9.]/g, "") }))}
                  aria-label={`Amount of ETH to take out from ${a.name}`} className="min-w-0 flex-1 rounded-lg border border-gray-200 bg-transparent px-2.5 py-1.5 font-mono text-xs text-gray-900 focus:border-gray-400 focus:outline-none dark:border-gray-800 dark:text-white" />
                <button type="button" onClick={() => void take(a)} disabled={busy !== null} className="rounded-lg bg-gray-900 px-3 text-xs font-semibold text-white transition hover:bg-gray-700 disabled:opacity-50 dark:bg-white dark:text-gray-900">
                  {busy === a.agentId ? "Sending…" : "Withdraw"}
                </button>
              </div>
            )}
            {msg?.agentId === a.agentId && <p className={`mt-1.5 text-xs ${msg.ok ? "text-emerald-600 dark:text-emerald-400" : "text-red-600 dark:text-red-400"}`}>{msg.text}</p>}
          </li>
        ))}
      </ul>
      <p className="mt-2 text-[11px] text-gray-400">Paid to the wallet that owns the agent. At least {data.rules.minEth} ETH, at most {data.rules.maxPerDayEth} ETH a day.{!data.open && " Withdrawals are paused just now."}</p>
      {data.withdrawals.length > 0 && (
        <ul className="mt-3 space-y-1">
          {data.withdrawals.slice(0, 6).map((w) => (
            <li key={w.id} className="flex items-center justify-between gap-2 font-mono text-[11px] text-gray-500">
              <span>{new Date(w.createdAt).toLocaleDateString()} · {eth(Number(w.amountEth))} ETH</span>
              {w.txHash ? <a href={`${EXPLORER}/tx/${w.txHash}`} target="_blank" rel="noreferrer" className="underline hover:text-gray-900 dark:hover:text-white">{w.status === "sent" ? "sent" : w.status}</a> : <span>{w.status}</span>}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
