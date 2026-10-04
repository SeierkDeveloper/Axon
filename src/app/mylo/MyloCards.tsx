"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useWallet } from "@/components/WalletProvider";
import { payForBuild } from "@/lib/buildPaymentClient";
import { provider } from "@/lib/chain";

// What Mylo shows besides words: agents it found, a comparison, the network's pulse, and what it proposes: hires,
// Studio builds and publishing a build. A hire is the only card that can move money, and only by the person's own
// hand: they confirm it, their wallet asks them to pay each agent's exact price (or their allowance pays, within its
// limits), and the agents' answers arrive in the conversation when they finish. A build shows Studio's progress while
// it runs, and its result arrives in the conversation the same way.

export interface AgentCardData { agentId: string; name: string; description: string | null; category: string | null; price: string | null; priceEth: number | null; proofScore: number | null; studioScore: number | null; tasksCompleted: number | null }
export type CardData =
  | { kind: "agents"; title: string; agents: AgentCardData[] }
  | { kind: "compare"; agents: AgentCardData[] }
  | { kind: "launch"; agentId: string; agentName: string; name: string | null; ticker: string | null; description: string | null; page: string }
  | { kind: "earnings"; agents: { agentId: string; name: string; earnedEth: number; availableEth: number }[]; availableEth: number }
  | { kind: "pulse"; agents: number; activeAgents: number; tasksToday: number; successRate: number; burned: number | null; burns: number | null; lastCheck: { at: string; checks: number | null } | null };

export interface BuildDetail { sentence: string; change: string | null; buildId: string | null; name: string | null; stage: string | null; round: number; score: number | null; error: string | null; changing?: boolean }
export interface PublishDetail { buildId: string; name: string; priceEth: number; score: number | null; agentId: string | null; error: string | null }
export interface WithdrawDetail { agentId: string; name: string; amountEth: number; to: string; txHash: string | null; sent: string | null; error: string | null }
export interface ImproveDetail { improvementId: string; agentId: string; name: string; fromScore: number | null; toScore: number | null; error: string | null }
export interface CrewDetail { crewName: string; roles: string[]; current: number; error: string | null }
export interface ScheduleDetail { agentId: string; name: string; scheduleText: string; maxPriceEth: number; maxPerDayEth: number; retainerId: string | null; nextRunAt: string | null; error: string | null }
export interface ActionView { id: string; kind?: "hire" | "build" | "publish" | "withdraw" | "improve" | "crew" | "schedule"; detail?: BuildDetail | PublishDetail | WithdrawDetail | ImproveDetail | CrewDetail | ScheduleDetail | null; status: "proposed" | "running" | "done" | "failed" | "cancelled"; task: string; summary: string; expiresAt: string; hires: { agentId: string; name: string; price: string | null; priceEth: number | null; taskId: string | null; error: string | null }[]; payTo: string | null }

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

const EXPLORER = "https://robinhoodchain.blockscout.com";
const shortAddr = (w: string) => (/^0x[0-9a-fA-F]{40}$/.test(w) ? `${w.slice(0, 6)}…${w.slice(-4)}` : w);

export function Card({ card }: { card: CardData }) {
  if (card.kind === "launch") {
    return (
      <div className="mt-3 rounded-2xl border border-gray-200 bg-white p-4 dark:border-gray-800 dark:bg-gray-950">
        <p className="font-mono text-[11px] uppercase tracking-[0.2em] text-gray-400">Token launch, ready</p>
        <p className="mt-2 text-sm text-gray-500 dark:text-gray-400">For <Link href={`/agents/${card.agentId}`} className="font-semibold text-gray-900 hover:underline dark:text-white">{card.agentName}</Link></p>
        <div className="mt-3 grid grid-cols-2 gap-2">
          <div className="rounded-xl bg-gray-50 px-3 py-2 dark:bg-gray-900"><p className="text-[11px] text-gray-400">Name</p><p className="truncate text-sm font-semibold text-gray-900 dark:text-white">{card.name ?? "Your choice"}</p></div>
          <div className="rounded-xl bg-gray-50 px-3 py-2 dark:bg-gray-900"><p className="text-[11px] text-gray-400">Ticker</p><p className="truncate font-mono text-sm font-semibold text-gray-900 dark:text-white">{card.ticker ? `$${card.ticker}` : "Your choice"}</p></div>
        </div>
        {card.description && <p className="mt-2 text-sm text-gray-600 dark:text-gray-300">{card.description}</p>}
        <Link href={card.page} className="mt-4 inline-flex rounded-xl bg-gray-900 px-4 py-2 text-sm font-semibold text-white transition hover:bg-gray-700 dark:bg-white dark:text-gray-900 dark:hover:bg-gray-200">Open the launch page</Link>
        <p className="mt-3 text-[11px] text-gray-400">Filled in for you to check. Add an image there and launch from your own wallet.</p>
      </div>
    );
  }
  if (card.kind === "earnings") {
    return (
      <div className="mt-3 overflow-hidden rounded-xl border border-gray-200 bg-white dark:border-gray-800 dark:bg-gray-950">
        {card.agents.map((a, i) => (
          <Link key={a.agentId} href={`/agents/${a.agentId}`} className={`flex items-center gap-3 px-4 py-3 transition hover:bg-gray-50 dark:hover:bg-gray-900 ${i ? "border-t border-gray-100 dark:border-gray-800" : ""}`}>
            <div className="min-w-0 flex-1">
              <p className="line-clamp-2 break-words text-sm font-semibold text-gray-900 dark:text-white">{a.name}</p>
              <p className="font-mono text-[11px] text-gray-400">earned {+a.earnedEth.toFixed(8)} ETH</p>
            </div>
            <div className="shrink-0 text-right">
              <p className="font-mono text-xs text-gray-900 dark:text-white">{+a.availableEth.toFixed(8)} ETH</p>
              <p className="font-mono text-[11px] text-gray-400">to take out</p>
            </div>
          </Link>
        ))}
        <div className="flex items-center justify-between border-t border-gray-200 bg-gray-50 px-4 py-2.5 text-xs dark:border-gray-800 dark:bg-gray-900/60">
          <span className="text-gray-500 dark:text-gray-400">You can take out</span>
          <span className="font-mono font-semibold text-gray-900 dark:text-white">{+card.availableEth.toFixed(8)} ETH</span>
        </div>
      </div>
    );
  }
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
      if (stopped) setErr(`${/reject|denied|4001/i.test(stopped) ? "You declined the next payment" : stopped.startsWith("INSUFFICIENT_FUNDS") ? "Not enough ETH for the next payment" : `The next payment didn't go through (${stopped})`}, so only the agents you paid for were hired.`);
    } catch (e) {
      const m = e instanceof Error ? e.message : "Something went wrong.";
      setErr(m.startsWith("INSUFFICIENT_FUNDS") ? "Not enough ETH in this wallet for that." : m === "WALLET_NOT_FOUND" ? "No wallet found in this browser." : /reject|denied|4001/i.test(m) ? "You declined in your wallet. Nothing was paid." : m);
    } finally {
      setStep(null);
    }
  };

  // a build or a publish needs no payment: confirming starts it
  const confirmPlain = async () => {
    setErr(null);
    setStep(a.kind === "build" ? "Starting the build" : a.kind === "withdraw" ? "Sending" : a.kind === "improve" ? "Applying" : a.kind === "schedule" ? "Starting autopilot" : "Publishing");
    try {
      const res = await fetch(`/api/mylo/actions/${a.id}/confirm`, { method: "POST", headers: headers(), body: JSON.stringify({ method: "wallet", payments: {} }) });
      const j = (await res.json()) as { action?: ActionView; error?: string };
      if (!res.ok || !j.action) throw new Error(j.error ?? "That didn't start.");
      setA(j.action);
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Something went wrong.");
    } finally {
      setStep(null);
    }
  };

  const cancel = async () => {
    const r = await fetch(`/api/mylo/actions/${a.id}/cancel`, { method: "POST", headers: headers() }).catch(() => null);
    const j = r ? ((await r.json()) as { action?: ActionView }) : {};
    if (j.action) setA(j.action);
  };

  const kind = a.kind ?? "hire";
  const build = kind === "build" ? (a.detail as BuildDetail) : null;
  const pub = kind === "publish" ? (a.detail as PublishDetail) : null;
  const wd = kind === "withdraw" ? (a.detail as WithdrawDetail) : null;
  const imp = kind === "improve" ? (a.detail as ImproveDetail) : null;
  const crew = kind === "crew" ? (a.detail as CrewDetail) : null;
  const sched = kind === "schedule" ? (a.detail as ScheduleDetail) : null;
  // a hire and a crew are both paid per agent from the wallet; everything else is a plain OK
  const pays = kind === "hire" || kind === "crew";
  const label = build ? (build.change ? "Change and retest" : "Build") : pub ? "Publish" : wd ? "Withdraw" : imp ? "Better version" : crew ? `Crew: ${crew.crewName}` : sched ? "Autopilot" : a.hires.length > 1 ? "Second opinion" : "Hire";
  const doneWord = build ? "Built" : pub ? "Live" : wd ? "Sent" : imp ? "Applied" : sched ? "On autopilot" : "Done";
  const badge = { proposed: expired ? "Expired" : "Waiting for your OK", running: build ? "Building" : pub ? "Publishing" : wd ? "Sending" : imp ? "Applying" : sched ? "Starting" : crew ? `Step ${crew.current + 1} of ${a.hires.length}` : "Working", done: doneWord, failed: "Didn't finish", cancelled: "Cancelled" }[a.status];
  const stage = build ? ({ changing: "Making the change", drafting: "Writing the agent", drafted: "Getting ready to test", testing: `Testing${build.round ? `, round ${build.round + 1}` : ""}`, improving: `Improving after round ${build.round}` } as Record<string, string>)[build.stage ?? ""] ?? "Starting" : null;
  const studioLink = build?.buildId ? `/studio?build=${build.buildId}` : null;
  return (
    <div className={`mt-3 rounded-2xl border p-4 ${a.status === "proposed" && !expired ? "border-gray-900 dark:border-white" : "border-gray-200 dark:border-gray-800"} bg-white dark:bg-gray-950`}>
      <div className="flex items-center justify-between gap-3">
        <p className="font-mono text-[11px] uppercase tracking-[0.2em] text-gray-400">{label}</p>
        <span className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-[11px] ${a.status === "done" ? "bg-emerald-50 text-emerald-700 dark:bg-emerald-950 dark:text-emerald-400" : "bg-gray-100 text-gray-600 dark:bg-gray-900 dark:text-gray-300"}`}>
          {a.status === "running" && <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-gray-900 dark:bg-white" />}{badge}
        </span>
      </div>

      {build && (
        <div className="mt-3">
          {build.name && <p className="text-sm font-semibold text-gray-900 dark:text-white">{build.name}</p>}
          <p className={`${build.name ? "mt-1" : ""} text-sm text-gray-600 dark:text-gray-300`}>&ldquo;{build.change ?? build.sentence}&rdquo;</p>
          {a.status === "running" && <p className="mt-3 flex items-center gap-2 text-xs text-gray-500 dark:text-gray-400"><span className="h-1.5 w-1.5 animate-pulse rounded-full bg-gray-900 dark:bg-white" />{stage}…{build.score !== null && <span className="font-mono">best so far {build.score.toFixed(1)}</span>}</p>}
          {a.status === "done" && build.score !== null && <p className="mt-3 font-mono text-xs text-gray-600 dark:text-gray-300">tested {build.score.toFixed(1)}/10</p>}
          {build.error && a.status === "failed" && <p className="mt-3 text-xs text-red-600 dark:text-red-400">{build.error}</p>}
          {studioLink && a.status !== "proposed" && <Link href={studioLink} className="mt-3 inline-block text-xs text-gray-500 underline underline-offset-2 hover:text-gray-900 dark:hover:text-white">Open in Studio</Link>}
        </div>
      )}

      {pub && (
        <div className="mt-3">
          <div className="flex items-center justify-between gap-3 text-sm">
            <span className="line-clamp-2 break-words font-semibold text-gray-900 dark:text-white">{pub.name}</span>
            <span className="shrink-0 font-mono text-xs text-gray-600 dark:text-gray-300">{pub.priceEth} ETH a task</span>
          </div>
          {pub.score !== null && <p className="mt-1 font-mono text-[11px] text-gray-400">tested {pub.score.toFixed(1)}/10</p>}
          {pub.agentId && <Link href={`/agents/${pub.agentId}`} className="mt-3 inline-block text-xs text-gray-500 underline underline-offset-2 hover:text-gray-900 dark:hover:text-white">See it live</Link>}
          {pub.error && <p className="mt-3 text-xs text-red-600 dark:text-red-400">{pub.error}</p>}
        </div>
      )}

      {wd && (
        <div className="mt-3">
          <div className="flex items-center justify-between gap-3 text-sm">
            <span className="line-clamp-2 break-words font-semibold text-gray-900 dark:text-white">{wd.name}</span>
            <span className="shrink-0 font-mono text-xs text-gray-900 dark:text-white">{wd.amountEth} ETH</span>
          </div>
          <p className="mt-1 font-mono text-[11px] text-gray-400">to your wallet {shortAddr(wd.to)}</p>
          {wd.txHash && <a href={`${EXPLORER}/tx/${wd.txHash}`} target="_blank" rel="noopener noreferrer" className="mt-3 inline-block text-xs text-gray-500 underline underline-offset-2 hover:text-gray-900 dark:hover:text-white">See the transaction</a>}
          {wd.error && <p className="mt-3 text-xs text-red-600 dark:text-red-400">{wd.error}</p>}
        </div>
      )}

      {imp && (
        <div className="mt-3">
          <p className="text-sm font-semibold text-gray-900 dark:text-white">{imp.name}</p>
          {imp.fromScore !== null && imp.toScore !== null && <p className="mt-1 font-mono text-[11px] text-gray-400">tested {imp.fromScore} before, {imp.toScore} now</p>}
          <Link href={`/agents/${imp.agentId}`} className="mt-3 inline-block text-xs text-gray-500 underline underline-offset-2 hover:text-gray-900 dark:hover:text-white">See the agent</Link>
          {imp.error && <p className="mt-3 text-xs text-red-600 dark:text-red-400">{imp.error}</p>}
        </div>
      )}

      {crew && (
        <>
          <ol className="mt-3 space-y-2">
            {a.hires.map((h, i) => (
              <li key={h.agentId} className="flex items-start gap-3 text-sm">
                <span className={`mt-0.5 grid h-5 w-5 shrink-0 place-items-center rounded-full font-mono text-[10px] ${a.status === "running" && i === crew.current ? "bg-gray-900 text-white dark:bg-white dark:text-gray-900" : "bg-gray-100 text-gray-500 dark:bg-gray-900 dark:text-gray-400"}`}>{i + 1}</span>
                <span className="min-w-0 flex-1">
                  <Link href={`/agents/${h.agentId}`} className="line-clamp-2 break-words font-semibold text-gray-900 hover:underline dark:text-white">{h.name}</Link>
                  {crew.roles[i] && <span className="block text-xs text-gray-500 dark:text-gray-400">{crew.roles[i]}</span>}
                </span>
                <span className="shrink-0 font-mono text-xs text-gray-600 dark:text-gray-300">{h.error ? <span className="text-red-600 dark:text-red-400">{h.error}</span> : h.taskId ? <Link href={`/r/${h.taskId}`} className="underline">receipt</Link> : eth(h.priceEth)}</span>
              </li>
            ))}
          </ol>
          {crew.error && <p className="mt-3 text-xs text-red-600 dark:text-red-400">{crew.error}</p>}
          <details className="mt-3 text-xs text-gray-500 dark:text-gray-400">
            <summary className="cursor-pointer select-none">The task</summary>
            <p className="mt-2 whitespace-pre-wrap rounded-lg bg-gray-50 p-3 text-gray-700 dark:bg-gray-900 dark:text-gray-300">{a.task}</p>
          </details>
        </>
      )}

      {sched && (
        <div className="mt-3">
          <div className="flex items-center justify-between gap-3 text-sm">
            <Link href={`/agents/${sched.agentId}`} className="line-clamp-2 break-words font-semibold text-gray-900 hover:underline dark:text-white">{sched.name}</Link>
            <span className="shrink-0 font-mono text-xs text-gray-600 dark:text-gray-300">≤ {sched.maxPriceEth} ETH a run</span>
          </div>
          <p className="mt-1 text-sm text-gray-600 dark:text-gray-300">{sched.scheduleText}</p>
          <p className="mt-1 font-mono text-[11px] text-gray-400">at most {sched.maxPerDayEth} ETH a day</p>
          <details className="mt-3 text-xs text-gray-500 dark:text-gray-400">
            <summary className="cursor-pointer select-none">What it does each run</summary>
            <p className="mt-2 whitespace-pre-wrap rounded-lg bg-gray-50 p-3 text-gray-700 dark:bg-gray-900 dark:text-gray-300">{a.task}</p>
          </details>
          {sched.error && <p className="mt-3 text-xs text-red-600 dark:text-red-400">{sched.error}</p>}
        </div>
      )}

      {kind === "hire" && (
        <>
          <ul className="mt-3 space-y-1.5">
            {a.hires.map((h) => (
              <li key={h.agentId} className="flex items-center justify-between gap-3 text-sm">
                <Link href={`/agents/${h.agentId}`} className="line-clamp-2 break-words font-semibold text-gray-900 hover:underline dark:text-white">{h.name}</Link>
                <span className="shrink-0 font-mono text-xs text-gray-600 dark:text-gray-300">{h.error ? <span className="text-red-600 dark:text-red-400">{h.error}</span> : h.taskId ? <Link href={`/r/${h.taskId}`} className="underline">receipt</Link> : eth(h.priceEth)}</span>
              </li>
            ))}
          </ul>
          <details className="mt-3 text-xs text-gray-500 dark:text-gray-400">
            <summary className="cursor-pointer select-none">The task</summary>
            <p className="mt-2 whitespace-pre-wrap rounded-lg bg-gray-50 p-3 text-gray-700 dark:bg-gray-900 dark:text-gray-300">{a.task}</p>
          </details>
        </>
      )}

      {a.status === "proposed" && !expired && (
        <div className="mt-4 flex flex-wrap items-center gap-2">
          {!apiKey ? (
            <button type="button" onClick={() => void signIn()} disabled={walletBusy} className="rounded-xl bg-gray-900 px-4 py-2 text-sm font-semibold text-white disabled:opacity-50 dark:bg-white dark:text-gray-900">Sign in to confirm</button>
          ) : !pays ? (
            <button type="button" onClick={() => void confirmPlain()} disabled={step !== null}
              className="rounded-xl bg-gray-900 px-4 py-2 text-sm font-semibold text-white transition hover:bg-gray-700 disabled:opacity-50 dark:bg-white dark:text-gray-900 dark:hover:bg-gray-200">
              {build ? "Build it" : pub ? "Publish" : wd ? `Withdraw ${wd.amountEth} ETH` : sched ? "Start autopilot" : "Apply"}
            </button>
          ) : (
            <>
              <button type="button" onClick={() => void confirm("wallet")} disabled={step !== null}
                className="rounded-xl bg-gray-900 px-4 py-2 text-sm font-semibold text-white transition hover:bg-gray-700 disabled:opacity-50 dark:bg-white dark:text-gray-900 dark:hover:bg-gray-200">
                {cost > 0 ? `Confirm and pay ${+cost.toFixed(8)} ETH` : "Confirm"}
              </button>
              {cost > 0 && allowance?.ok && !crew && (
                <button type="button" onClick={() => void confirm("allowance")} disabled={step !== null} className="rounded-xl border border-gray-300 px-4 py-2 text-sm font-semibold text-gray-900 transition hover:border-gray-900 disabled:opacity-50 dark:border-gray-700 dark:text-white dark:hover:border-white">Pay from allowance</button>
              )}
            </>
          )}
          <button type="button" onClick={() => void cancel()} disabled={step !== null} className="px-2 py-2 text-sm text-gray-500 underline-offset-2 hover:underline disabled:opacity-50">Cancel</button>
        </div>
      )}
      {step && <p className="mt-3 text-xs text-gray-500">{step}…</p>}
      {err && <p className="mt-3 text-xs text-red-600 dark:text-red-400">{err}</p>}
      {a.status === "proposed" && !expired && (
        <p className="mt-3 text-[11px] text-gray-400">
          {crew ? `Paid from your wallet, one payment per paid step${cost > 0 ? "" : " (all free here)"}. The steps run in order.` : sched ? "Each run pays from your allowance, within its limits. Pause or stop it any time." : build ? "Free. Studio writes it and tests it, which takes a few minutes. Counts as one of today's Studio builds." : pub ? "Lists it on Axon for anyone to hire. What it earns is yours." : wd ? "Goes only to the wallet that owns the agent." : imp ? "Your agent's next jobs use the better version." : `Paid ${cost > 0 ? "from your wallet to Axon, checked on chain" : "nothing: this agent is free"}.`}
          {" "}Expires in {Math.max(1, Math.round((Date.parse(a.expiresAt) - nowMs) / 60_000))} min.
        </p>
      )}
    </div>
  );
}
