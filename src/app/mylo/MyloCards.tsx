"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useWallet } from "@/components/WalletProvider";
import { payForBuild } from "@/lib/buildPaymentClient";
import { provider } from "@/lib/chain";

// What Mylo shows besides words: agents it found, a comparison, the network's pulse, and the hires it proposes. A
// proposal is the only card that can move money, and only by the person's own hand: they confirm it, their wallet asks
// them to pay each agent's exact price (or their allowance pays, within its limits), and the agents' answers arrive in
// the conversation when they finish.

export interface AgentCardData { agentId: string; name: string; description: string | null; category: string | null; price: string | null; priceEth: number | null; proofScore: number | null; studioScore: number | null; tasksCompleted: number | null }
export type CardData =
  | { kind: "agents"; title: string; agents: AgentCardData[] }
  | { kind: "compare"; agents: AgentCardData[] }
  | { kind: "pulse"; agents: number; activeAgents: number; tasksToday: number; successRate: number; burned: number | null; burns: number | null; lastCheck: { at: string; checks: number | null } | null };

export interface ActionView { id: string; status: "proposed" | "running" | "done" | "failed" | "cancelled"; task: string; summary: string; expiresAt: string; hires: { agentId: string; name: string; price: string | null; priceEth: number | null; taskId: string | null; error: string | null }[]; payTo: string | null }

// payments already made for a proposal, kept so a retry never asks anyone to pay the same agent twice
const paidKey = (id: string) => `mylo.paid.${id}`;
function paidFor(id: string): Record<string, string> {
  try { return JSON.parse(localStorage.getItem(paidKey(id)) ?? "{}") as Record<string, string>; } catch { return {}; }
}
function keepPaid(id: string, p: Record<string, string>) {
  try { localStorage.setItem(paidKey(id), JSON.stringify(p)); } catch { /* the in-memory copy still holds it */ }
}

const eth = (v: number | null) => (v === null ? "Free" : `${+v.toFixed(8)} ETH`);
const compact = (n: number) => (n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(1)}K` : `${Math.round(n)}`);

export function Card({ card }: { card: CardData }) {
  if (card.kind === "pulse") {
    const tiles: [string, string][] = [
      ["Agents", `${card.agents}`], ["Tasks done today", `${card.tasksToday}`],
      ["Success rate", card.successRate > 0 ? `${Math.round(card.successRate * 100)}%` : "No data"], ["$AXON burned", card.burned === null ? "–" : compact(card.burned)],
    ];
    return (
      <div className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-4">
        {tiles.map(([k, v]) => (
          <div key={k} className="rounded-xl border border-gray-200 bg-white px-3 py-2.5 dark:border-gray-800 dark:bg-gray-950">
            <p className="text-lg font-semibold tabular-nums text-gray-900 dark:text-white">{v}</p>
            <p className="text-[11px] text-gray-400">{k}</p>
          </div>
        ))}
      </div>
    );
  }
  const rows = card.agents;
  return (
    <div className="mt-3 overflow-hidden rounded-xl border border-gray-200 bg-white dark:border-gray-800 dark:bg-gray-950">
      {rows.map((a, i) => (
        <Link key={a.agentId} href={`/agents/${a.agentId}`} className={`flex items-center gap-3 px-4 py-3 transition hover:bg-gray-50 dark:hover:bg-gray-900 ${i ? "border-t border-gray-100 dark:border-gray-800" : ""}`}>
          <div className="min-w-0 flex-1">
            <p className="line-clamp-2 break-words text-sm font-semibold text-gray-900 dark:text-white">{a.name}</p>
            <p className="truncate text-xs text-gray-500 dark:text-gray-400">{[a.category, a.description].filter(Boolean).join(" · ") || a.agentId}</p>
          </div>
          <div className="shrink-0 text-right">
            <p className="font-mono text-xs text-gray-900 dark:text-white">{eth(a.priceEth)}</p>
            <p className="font-mono text-[11px] text-gray-400">
              {[a.studioScore !== null ? `tested ${a.studioScore.toFixed(1)}` : null, a.proofScore !== null ? `proof ${a.proofScore}` : null, card.kind === "compare" && a.tasksCompleted !== null ? `${a.tasksCompleted} jobs` : null].filter(Boolean).join(" · ") || "new"}
            </p>
          </div>
        </Link>
      ))}
    </div>
  );
}

/** A hire Mylo proposed. Confirm pays each agent from the person's wallet (or their allowance); nothing happens before. */
export function ActionCard({ initial, headers, onMessage }: { initial: ActionView; headers: () => Record<string, string>; onMessage: (m: { id: string; content: string }) => void }) {
  const { apiKey, signIn, busy: walletBusy, onRightChain, switchChain, address } = useWallet();
  const [a, setA] = useState(initial);
  const [step, setStep] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [allowance, setAllowance] = useState<{ ok: boolean; available: number } | null>(null);
  const [nowMs, setNowMs] = useState(() => Date.now());
  const cost = a.hires.reduce((s, h) => s + (h.priceEth ?? 0), 0);
  const paid = a.hires.filter((h) => h.priceEth !== null);
  const expired = a.status === "proposed" && Date.parse(a.expiresAt) < nowMs;

  // the time left to confirm, and whether this wallet has an allowance that could pay for it
  useEffect(() => { if (a.status !== "proposed") return; const t = setInterval(() => setNowMs(Date.now()), 15_000); return () => clearInterval(t); }, [a.status]);
  useEffect(() => {
    if (a.status !== "proposed" || !apiKey || paid.length === 0) return;
    let alive = true;
    fetch("/api/allowance", { headers: { authorization: `Bearer ${apiKey}` }, cache: "no-store" }).then((r) => r.json()).then((j: { enabled?: boolean; accounts?: { token: string; configured: boolean; paused: boolean; available: string }[] }) => {
      const e = j.accounts?.find((x) => x.token === "ETH");
      if (alive) setAllowance(e ? { ok: Boolean(j.enabled && e.configured && !e.paused && Number(e.available) >= cost), available: Number(e.available) } : { ok: false, available: 0 });
    }).catch(() => {});
    return () => { alive = false; };
  }, [a.status, apiKey, paid.length, cost]);

  // once running, follow it until the answers are in
  useEffect(() => {
    if (a.status !== "running") return;
    let alive = true;
    const tick = async () => {
      const r = await fetch(`/api/mylo/actions/${a.id}`, { headers: headers(), cache: "no-store" }).catch(() => null);
      if (!alive || !r?.ok) return;
      const j = (await r.json()) as { action: ActionView; message: { id: string; content: string } | null };
      setA(j.action);
      if (j.message) onMessage(j.message);
    };
    const t = setInterval(() => void tick(), 3000);
    void tick();
    return () => { alive = false; clearInterval(t); };
  }, [a.status, a.id, headers, onMessage]);

  const confirm = async (method: "wallet" | "allowance") => {
    setErr(null);
    let stopped: string | null = null;
    try {
      const payments: Record<string, string> = method === "wallet" ? paidFor(a.id) : {};
      if (method === "wallet" && paid.length) {
        if (!a.payTo) throw new Error("Payments aren't set up on this site.");
        // prices can move after Mylo proposes: check them again before asking for any money
        setStep("Checking the prices");
        const fresh = (await (await fetch(`/api/mylo/actions/${a.id}`, { headers: headers(), cache: "no-store" })).json()) as { action?: ActionView; stale?: string[] };
        if (fresh.action && fresh.action.status !== "proposed") { setA(fresh.action); return; }
        if (fresh.stale?.length) throw new Error(`${fresh.stale.join(" and ")} changed since Mylo proposed this. Nothing was paid. Ask Mylo again for a fresh proposal.`);
        // the payment must come from the wallet that is signed in, or Axon won't count it
        const p = provider();
        const live = p ? ((await p.request({ method: "eth_accounts" })) as string[])[0] : null;
        if (live && address && live.toLowerCase() !== address.toLowerCase()) throw new Error("Your wallet is on a different account than the one signed in here. Switch it back, then confirm.");
        if (!onRightChain) { setStep("Switching to Robinhood Chain"); await switchChain(); }
        const todo = paid.filter((h) => !payments[h.agentId]);
        for (const [i, h] of todo.entries()) {
          setStep(todo.length > 1 ? `Pay ${h.name} (${i + 1} of ${todo.length}) in your wallet` : `Pay ${h.name} in your wallet`);
          try {
            payments[h.agentId] = (await payForBuild({ treasury: a.payTo, ethAmount: h.priceEth! })).signature;
            keepPaid(a.id, payments);
          } catch (e) {
            // nothing paid yet: stop here. Something paid already: run what was paid for, and say what wasn't
            if (!Object.keys(payments).length) throw e;
            stopped = e instanceof Error ? e.message : "stopped";
            break;
          }
        }
      }
      setStep("Starting the hire");
      const res = await fetch(`/api/mylo/actions/${a.id}/confirm`, { method: "POST", headers: headers(), body: JSON.stringify({ method, payments }) });
      const j = (await res.json()) as { action?: ActionView; error?: string };
      if (!res.ok || !j.action) throw new Error(j.error ?? "The hire didn't start.");
      setA(j.action);
      try { localStorage.removeItem(paidKey(a.id)); } catch { /* fine */ }
      if (stopped) setErr("You stopped before paying every agent, so only the ones you paid for were hired.");
    } catch (e) {
      const m = e instanceof Error ? e.message : "Something went wrong.";
      setErr(m.startsWith("INSUFFICIENT_FUNDS") ? "Not enough ETH in this wallet for that." : m === "WALLET_NOT_FOUND" ? "No wallet found in this browser." : /reject|denied|4001/i.test(m) ? "You declined in your wallet. Nothing was paid." : m);
    } finally {
      setStep(null);
    }
  };

  const cancel = async () => {
    const r = await fetch(`/api/mylo/actions/${a.id}/cancel`, { method: "POST", headers: headers() }).catch(() => null);
    const j = r ? ((await r.json()) as { action?: ActionView }) : {};
    if (j.action) setA(j.action);
  };

  const badge = { proposed: expired ? "Expired" : "Waiting for your OK", running: "Working", done: "Done", failed: "Didn't finish", cancelled: "Cancelled" }[a.status];
  return (
    <div className={`mt-3 rounded-2xl border p-4 ${a.status === "proposed" && !expired ? "border-gray-900 dark:border-white" : "border-gray-200 dark:border-gray-800"} bg-white dark:bg-gray-950`}>
      <div className="flex items-center justify-between gap-3">
        <p className="font-mono text-[11px] uppercase tracking-[0.2em] text-gray-400">{a.hires.length > 1 ? "Second opinion" : "Hire"}</p>
        <span className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-[11px] ${a.status === "done" ? "bg-emerald-50 text-emerald-700 dark:bg-emerald-950 dark:text-emerald-400" : "bg-gray-100 text-gray-600 dark:bg-gray-900 dark:text-gray-300"}`}>
          {a.status === "running" && <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-gray-900 dark:bg-white" />}{badge}
        </span>
      </div>
      <ul className="mt-3 space-y-1.5">
        {a.hires.map((h) => (
          <li key={h.agentId} className="flex items-center justify-between gap-3 text-sm">
            <Link href={`/agents/${h.agentId}`} className="truncate font-semibold text-gray-900 hover:underline dark:text-white">{h.name}</Link>
            <span className="shrink-0 font-mono text-xs text-gray-600 dark:text-gray-300">{h.error ? <span className="text-red-600 dark:text-red-400">{h.error}</span> : h.taskId ? <Link href={`/r/${h.taskId}`} className="underline">receipt</Link> : eth(h.priceEth)}</span>
          </li>
        ))}
      </ul>
      <details className="mt-3 text-xs text-gray-500 dark:text-gray-400">
        <summary className="cursor-pointer select-none">The task</summary>
        <p className="mt-2 whitespace-pre-wrap rounded-lg bg-gray-50 p-3 text-gray-700 dark:bg-gray-900 dark:text-gray-300">{a.task}</p>
      </details>
      {a.status === "proposed" && !expired && (
        <div className="mt-4 flex flex-wrap items-center gap-2">
          {!apiKey ? (
            <button type="button" onClick={() => void signIn()} disabled={walletBusy} className="rounded-xl bg-gray-900 px-4 py-2 text-sm font-semibold text-white disabled:opacity-50 dark:bg-white dark:text-gray-900">Sign in to confirm</button>
          ) : (
            <>
              <button type="button" onClick={() => void confirm("wallet")} disabled={step !== null}
                className="rounded-xl bg-gray-900 px-4 py-2 text-sm font-semibold text-white transition hover:bg-gray-700 disabled:opacity-50 dark:bg-white dark:text-gray-900 dark:hover:bg-gray-200">
                {cost > 0 ? `Confirm and pay ${+cost.toFixed(8)} ETH` : "Confirm"}
              </button>
              {cost > 0 && allowance?.ok && (
                <button type="button" onClick={() => void confirm("allowance")} disabled={step !== null} className="rounded-xl border border-gray-300 px-4 py-2 text-sm font-semibold text-gray-900 transition hover:border-gray-900 disabled:opacity-50 dark:border-gray-700 dark:text-white dark:hover:border-white">Pay from allowance</button>
              )}
            </>
          )}
          <button type="button" onClick={() => void cancel()} disabled={step !== null} className="px-2 py-2 text-sm text-gray-500 underline-offset-2 hover:underline disabled:opacity-50">Cancel</button>
        </div>
      )}
      {step && <p className="mt-3 text-xs text-gray-500">{step}…</p>}
      {err && <p className="mt-3 text-xs text-red-600 dark:text-red-400">{err}</p>}
      {a.status === "proposed" && !expired && <p className="mt-3 text-[11px] text-gray-400">Paid {cost > 0 ? "from your wallet to Axon, checked on chain" : "nothing: this agent is free"}. Expires in {Math.max(1, Math.round((Date.parse(a.expiresAt) - nowMs) / 60_000))} min.</p>}
    </div>
  );
}
