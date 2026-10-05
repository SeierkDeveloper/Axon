"use client";

/* eslint-disable @next/next/no-img-element -- token pictures come from wherever their creators put them */

import { Fragment, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { encodeFunctionData, parseAbi } from "viem";
import { useWallet } from "@/components/WalletProvider";
import { CHAIN_ID_HEX, CHAIN_PARAMS, EXPLORER, explorerTxUrl, ponsTokenUrl, provider, readableWalletError } from "@/lib/chain";
import type { BoardToken, BoardTotals, MindEvent, BoardSort } from "@/lib/mindsStats";
import { mindLabel } from "@/lib/mindsModels";
import TokenCard, { tokenCardFrame } from "./TokenCard";

/**
 * The launch terminal: every token launched on Axon, with the numbers its contracts report, and a running log of what
 * happens to them. It reads one endpoint every few seconds; the worker keeps that endpoint's numbers fresh from the
 * chain. Nothing here is typed in by anybody.
 */

export interface TerminalData { totals: BoardTotals; ethUsd: number | null; tokens: BoardToken[]; /** which page of the tokens this is, and how many there are */ page?: number; pages?: number; /** the token that is open, whichever page it is on */ opened?: BoardToken | null; events: MindEvent[] }

const POLL_MS = 6_000;

const compact = (n: number) => (n >= 1e9 ? `${(n / 1e9).toFixed(2)}B` : n >= 1e6 ? `${(n / 1e6).toFixed(2)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(1)}K` : n >= 100 ? n.toFixed(0) : n >= 1 ? n.toFixed(2) : n > 0 ? n.toPrecision(2) : "0");
const ethText = (v: number) => `${v >= 100 ? v.toFixed(0) : v >= 1 ? v.toFixed(2) : v >= 0.001 ? v.toFixed(4) : v > 0 ? v.toPrecision(2) : "0"} ETH`;
const money = (eth: number | null, usd: number | null) => (eth === null ? "…" : usd ? `$${compact(eth * usd)}` : ethText(eth));
const pct = (bps: number | null) => (bps === null ? "…" : `${+(bps / 100).toFixed(1)}%`);
const short = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;
export function ago(iso: string, now: number): string {
  const s = Math.max(0, Math.floor((now - Date.parse(iso)) / 1000));
  return s < 60 ? `${s}s` : s < 3600 ? `${Math.floor(s / 60)}m` : s < 86_400 ? `${Math.floor(s / 3600)}h` : `${Math.floor(s / 86_400)}d`;
}

function Logo({ src, symbol, size }: { src: string | null; symbol: string | null; size: number }) {
  const [broken, setBroken] = useState(false);
  const box = { width: size, height: size };
  if (!src || broken) return <span style={box} className="grid shrink-0 place-items-center rounded-lg bg-gray-100 font-mono text-[10px] font-semibold text-gray-500 dark:bg-gray-800 dark:text-gray-400">{(symbol ?? "?").slice(0, 3)}</span>;
  return <img src={src} alt="" style={box} loading="lazy" onError={() => setBroken(true)} className="shrink-0 rounded-lg bg-gray-100 object-cover dark:bg-gray-800" />;
}

function Curve({ t }: { t: BoardToken }) {
  if (t.phase >= 2) return <span className="rounded-md bg-gray-900 px-2 py-0.5 font-mono text-[10px] font-semibold uppercase tracking-wider text-white dark:bg-white dark:text-gray-900">Graduated</span>;
  return (
    <span className="flex items-center gap-2">
      <span className="h-1.5 w-full min-w-[56px] overflow-hidden rounded-full bg-gray-100 dark:bg-gray-800" role="img" aria-label={`${pct(t.curveBps)} of the way along its curve`}>
        <span className="block h-full rounded-full bg-gray-900 dark:bg-white" style={{ width: `${Math.max(2, t.curveBps / 100)}%` }} />
      </span>
      <span className="w-9 shrink-0 text-right font-mono text-[11px] tabular-nums text-gray-400">{Math.floor(t.curveBps / 100)}%</span>
    </span>
  );
}

function eventText(e: MindEvent): string {
  switch (e.kind) {
    case "launch": return "launched";
    case "fees": return `paid out ${ethText(e.eth ?? 0)}`;
    case "burn": return `burned ${compact(e.tokens ?? 0)} $${e.symbol ?? ""}`;
    case "graduated": return "graduated to its pool";
    case "holders": return `now has ${Math.round(e.tokens ?? 0)} holders`;
    case "earned": return `agent earned ${ethText(e.eth ?? 0)}`;
    case "thought": return "mind wrote a thought";
    case "bought": return `mind sent ${ethText(e.eth ?? 0)} to buy back and burn`;
    case "axon": return `mind sent ${ethText(e.eth ?? 0)} to burn $AXON`;
    case "rewarded": return `mind set ${ethText(e.eth ?? 0)} aside for holders`;
    case "attached": return "was given a mind";
    case "topup": return `mind's treasury topped up with ${ethText(e.eth ?? 0)}`;
  }
}

interface ThoughtView { id: number; at: string; modelLabel: string; thought: string | null; action: { kind: string; eth: number } | null; verdict: "none" | "approved" | "refused"; verdictReason: string | null; sent: { status: string; txHash: string | null; error: string | null } | null }
const ACTION: Record<string, string> = { buyback: "buy back and burn", reward: "reward holders", burn_axon: "burn $AXON" };

interface ChainState { paused: boolean; frozen: boolean; active: boolean }
const PAUSE_ABI = parseAbi(["function setPaused(bool paused)"]);

/** The creator's own switch. The treasury takes it from that one wallet and from nobody else, Axon included. */
function CreatorSwitch({ t, paused, onSent }: { t: BoardToken; paused: boolean; onSent: (paused: boolean) => void }) {
  const { address } = useWallet();
  const [sending, setSending] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  if (!address || address.toLowerCase() !== t.creator.toLowerCase()) return null;
  const send = async () => {
    const p = provider();
    if (!p) return;
    setSending(true); setNote(null);
    try {
      const chain = (await p.request({ method: "eth_chainId" })) as string;
      if (chain?.toLowerCase() !== CHAIN_ID_HEX) {
        try { await p.request({ method: "wallet_switchEthereumChain", params: [{ chainId: CHAIN_ID_HEX }] }); }
        catch (e) { if ((e as { code?: number }).code === 4902) await p.request({ method: "wallet_addEthereumChain", params: [CHAIN_PARAMS] }); else throw e; }
      }
      const data = encodeFunctionData({ abi: PAUSE_ABI, functionName: "setPaused", args: [!paused] });
      const hash = (await p.request({ method: "eth_sendTransaction", params: [{ from: address, to: t.vault, data }] })) as string;
      for (let i = 0; i < 80; i++) {
        const r = (await p.request({ method: "eth_getTransactionReceipt", params: [hash] })) as { status: string } | null;
        if (r) { if (r.status !== "0x1") throw new Error("The chain refused it."); break; }
        await new Promise((ok) => setTimeout(ok, 1500));
      }
      onSent(!paused);
    } catch (e) {
      setNote(e instanceof Error && !("code" in e) ? e.message : readableWalletError(e));
    } finally {
      setSending(false);
    }
  };
  return (
    <div className="mb-4 flex flex-wrap items-center gap-x-3 gap-y-2">
      <button type="button" onClick={() => void send()} disabled={sending} className="rounded-xl border border-gray-300 px-3.5 py-1.5 text-sm font-semibold transition hover:bg-white disabled:opacity-50 dark:border-gray-700 dark:hover:bg-gray-900">{sending ? "Confirm in your wallet…" : paused ? "Resume this mind" : "Pause this mind"}</button>
      <span className="text-xs text-gray-400">Only your wallet can. Paused, nothing leaves its treasury; holders can still claim.</span>
      {t.agentId && <Link href="/studio" className="w-full text-xs text-gray-500 underline decoration-gray-300 underline-offset-2 hover:text-gray-800 dark:text-gray-400 dark:decoration-gray-700 dark:hover:text-gray-200">What your agent earns from work is yours to take out, under Your earnings in Studio.</Link>}
      {note && <p role="alert" className="w-full text-sm text-gray-600 dark:text-gray-300">{note}</p>}
    </div>
  );
}

/** What a token's mind has been thinking, newest first. Loaded when the token is opened. */
function Mind({ t }: { t: BoardToken }) {
  const [items, setItems] = useState<ThoughtView[] | null>(null);
  const [chain, setChain] = useState<ChainState | null>(null);
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    let alive = true;
    const load = () => {
      void fetch(`/api/minds/thoughts?token=${t.token}&limit=3`).then((r) => (r.ok ? (r.json() as Promise<{ thoughts: ThoughtView[] }>) : null)).then((d) => { if (alive && d) { setItems(d.thoughts); setNow(Date.now()); } }).catch(() => {});
      // whether its treasury is running is the chain's to say, so it is read from there rather than kept
      void fetch(`/api/minds/tokens/${t.token}`).then((r) => (r.ok ? (r.json() as Promise<{ treasury: ChainState | null }>) : null)).then((d) => { if (alive && d?.treasury) setChain({ paused: d.treasury.paused, frozen: d.treasury.frozen, active: d.treasury.active }); }).catch(() => {});
    };
    load();
    const timer = setInterval(load, 15_000);
    return () => { alive = false; clearInterval(timer); };
  }, [t.token]);
  const halted = t.stopped ? null : !chain || chain.active ? null
    : chain.frozen ? "This mind's treasury is frozen. Nothing is sent from it; holders can still claim what was already set aside."
    : chain.paused ? "Its creator has paused this mind. It does not think and nothing leaves its treasury; holders can still claim what was already set aside."
    : "Minds are paused right now. Nothing is sent from any treasury; holders can still claim what was already set aside.";
  return (
    <div className="border-t border-gray-200 bg-gray-50 px-4 py-5 sm:px-5 dark:border-gray-800 dark:bg-gray-900/40">
      <p className="mb-3 font-mono text-[10px] uppercase tracking-[0.2em] text-gray-400">Its mind <span className="normal-case tracking-normal text-gray-500 dark:text-gray-400">· runs on {mindLabel(t.model).replace(/^Its/, "its")}</span></p>
      {t.stopped && <p className="mb-3 rounded-lg bg-gray-200 px-3 py-2 text-sm text-gray-700 dark:bg-gray-800 dark:text-gray-200">This mind is stopped. It does not think and nothing is sent for it; its treasury is untouched.</p>}
      {halted && <p className="mb-3 rounded-lg bg-gray-200 px-3 py-2 text-sm text-gray-700 dark:bg-gray-800 dark:text-gray-200">{halted}</p>}
      {chain && <CreatorSwitch t={t} paused={chain.paused} onSent={(paused) => setChain({ ...chain, paused, active: !paused && !chain.frozen })} />}
      <dl className="mb-4 grid grid-cols-2 gap-x-6 gap-y-1.5 text-xs sm:grid-cols-4">
        {([["Thoughts", String(t.thoughts)], ["Sent to buybacks", ethText(t.boughtEth)], [t.attached ? "Sent to burn $AXON" : "Set aside for holders", ethText(t.attached ? t.axonEth : t.rewardsEth)], ["Paid for its thinking", ethText(t.thinkingPaidEth)]] as const).map(([k, v]) => (
          <div key={k}>
            <dt className="text-gray-500 dark:text-gray-400">{k}</dt>
            <dd className="font-mono tabular-nums">{v}</dd>
          </div>
        ))}
      </dl>
      {items === null ? (
        <p className="text-sm text-gray-400">…</p>
      ) : items.length === 0 ? (
        <p className="text-sm text-gray-500 dark:text-gray-400">It has not thought yet. A mind wakes when something happens to its token and its treasury can pay for the thought.</p>
      ) : (
        <ol className="space-y-4">
          {items.map((h) => (
            <li key={h.id}>
              <p className="text-sm leading-relaxed">{h.thought}</p>
              <p className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 font-mono text-[11px] text-gray-400">
                <span suppressHydrationWarning>{ago(h.at, now)} ago · {h.modelLabel}</span>
                {h.action && (
                  <span className={`rounded-md px-1.5 py-0.5 ${h.verdict === "approved" ? "bg-gray-900 text-white dark:bg-white dark:text-gray-900" : "bg-gray-200 text-gray-600 dark:bg-gray-800 dark:text-gray-300"}`}>
                    proposed: {ACTION[h.action.kind] ?? h.action.kind} with {ethText(h.action.eth)} · {h.verdict === "approved" ? "passed the rule check" : "refused by the rule check"}
                  </span>
                )}
                {h.verdict === "refused" && h.verdictReason && <span className="font-sans">{h.verdictReason}</span>}
                {h.sent?.status === "done" && h.sent.txHash && <a href={explorerTxUrl(h.sent.txHash)} target="_blank" rel="noopener noreferrer" className="underline decoration-gray-300 underline-offset-2 hover:text-gray-700 dark:decoration-gray-700 dark:hover:text-gray-200">sent on chain</a>}
                {h.sent?.status === "sent" && <span>sending…</span>}
                {h.sent && (h.sent.status === "dropped" || h.sent.status === "failed") && <span className="font-sans">Not sent. {h.sent.error}</span>}
              </p>
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}

interface ShareView { token: string; vault: string; rewardId: number; index: number; amountWei: string; amountEth: number; proof: string[]; startAt: number; endAt: number }
const CLAIM_ABI = parseAbi(["function claim(uint256 id, uint256 index, address account, uint256 amount, bytes32[] proof)"]);

/** A holder's own share of the rewards this token's mind has set aside, with the button that claims it. */
function Rewards({ t }: { t: BoardToken }) {
  const { address, connect, busy } = useWallet();
  const [shares, setShares] = useState<ShareView[] | null>(null);
  const [claiming, setClaiming] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!address) return;
    let alive = true;
    const load = () => fetch(`/api/minds/rewards?account=${address}`).then((r) => (r.ok ? (r.json() as Promise<{ shares: ShareView[] }>) : null)).then((d) => { if (alive && d) { setShares(d.shares.filter((x) => x.token === t.token)); setNow(Date.now()); } }).catch(() => {});
    void load();
    const timer = setInterval(load, 20_000);
    return () => { alive = false; clearInterval(timer); };
  }, [address, t.token]);

  const claim = async (sh: ShareView) => {
    const p = provider();
    if (!p || !address) return;
    const key = `${sh.rewardId}:${sh.index}`;
    setClaiming(key); setNote(null);
    try {
      const chain = (await p.request({ method: "eth_chainId" })) as string;
      if (chain?.toLowerCase() !== CHAIN_ID_HEX) {
        try { await p.request({ method: "wallet_switchEthereumChain", params: [{ chainId: CHAIN_ID_HEX }] }); }
        catch (e) { if ((e as { code?: number }).code === 4902) await p.request({ method: "wallet_addEthereumChain", params: [CHAIN_PARAMS] }); else throw e; }
      }
      const data = encodeFunctionData({ abi: CLAIM_ABI, functionName: "claim", args: [BigInt(sh.rewardId), BigInt(sh.index), address as `0x${string}`, BigInt(sh.amountWei), sh.proof as `0x${string}`[]] });
      const hash = (await p.request({ method: "eth_sendTransaction", params: [{ from: address, to: sh.vault, data }] })) as string;
      for (let i = 0; i < 80; i++) {
        const r = (await p.request({ method: "eth_getTransactionReceipt", params: [hash] })) as { status: string } | null;
        if (r) { if (r.status !== "0x1") throw new Error("The claim was refused by the chain."); break; }
        await new Promise((ok) => setTimeout(ok, 1500));
      }
      setShares((list) => (list ?? []).filter((x) => `${x.rewardId}:${x.index}` !== key));
      setNote(`Claimed ${ethText(sh.amountEth)}.`);
    } catch (e) {
      setNote(e instanceof Error && !("code" in e) ? e.message : readableWalletError(e));
    } finally {
      setClaiming(null);
    }
  };

  // nothing to say to a wallet with no share here, and nothing at all until a mind has rewarded anybody
  if (address && shares !== null && shares.length === 0 && !note) return null;
  if (!address && !(t.rewardsEth > 0)) return null;
  return (
    <div className="border-t border-gray-200 bg-gray-50 px-4 py-5 sm:px-5 dark:border-gray-800 dark:bg-gray-900/40">
      <p className="mb-3 font-mono text-[10px] uppercase tracking-[0.2em] text-gray-400">Rewards for holders</p>
      {!address ? (
        <button type="button" onClick={() => void connect()} disabled={busy} className="rounded-xl border border-gray-200 px-4 py-2.5 text-sm font-semibold transition hover:bg-white disabled:opacity-50 dark:border-gray-700 dark:hover:bg-gray-900">Connect your wallet to see your share</button>
      ) : shares === null ? (
        <p className="text-sm text-gray-400">…</p>
      ) : (
        <ul className="space-y-2">
          {shares.map((sh) => {
            const key = `${sh.rewardId}:${sh.index}`, opens = sh.startAt * 1000 - now;
            return (
              <li key={key} className="flex flex-wrap items-center justify-between gap-3 text-sm">
                <span><span className="font-mono font-semibold tabular-nums">{ethText(sh.amountEth)}</span> <span className="text-gray-500 dark:text-gray-400">is yours from this token&apos;s mind</span></span>
                {opens > 0 ? (
                  <span className="font-mono text-xs text-gray-400" suppressHydrationWarning>opens in {Math.ceil(opens / 60_000)} min</span>
                ) : (
                  <button type="button" onClick={() => void claim(sh)} disabled={claiming !== null} className="rounded-xl bg-gray-900 px-4 py-2 text-sm font-semibold text-white transition hover:bg-gray-700 disabled:opacity-50 dark:bg-white dark:text-gray-900 dark:hover:bg-gray-200">{claiming === key ? "Confirm in your wallet…" : "Claim"}</button>
                )}
              </li>
            );
          })}
        </ul>
      )}
      {note && <p role="status" className="mt-3 text-sm text-gray-600 dark:text-gray-300">{note}</p>}
    </div>
  );
}

/** Anybody can add ETH to a mind's treasury. Nobody can take it back out, which the button says before it is pressed. */
function TopUp({ t }: { t: BoardToken }) {
  const { address, connect, busy } = useWallet();
  const [amount, setAmount] = useState("");
  const [state, setState] = useState<"idle" | "sending" | "sent">("idle");
  const [note, setNote] = useState<string | null>(null);
  const ok = /^\d+(\.\d{1,18})?$/.test(amount) && Number(amount) > 0;
  const send = async () => {
    const p = provider();
    if (!p || !address || !ok) return;
    setState("sending"); setNote(null);
    try {
      const chain = (await p.request({ method: "eth_chainId" })) as string;
      if (chain?.toLowerCase() !== CHAIN_ID_HEX) {
        try { await p.request({ method: "wallet_switchEthereumChain", params: [{ chainId: CHAIN_ID_HEX }] }); }
        catch (e) { if ((e as { code?: number }).code === 4902) await p.request({ method: "wallet_addEthereumChain", params: [CHAIN_PARAMS] }); else throw e; }
      }
      const [whole, frac = ""] = amount.split(".");
      const wei = BigInt(whole) * 10n ** 18n + BigInt(frac.padEnd(18, "0"));
      await p.request({ method: "eth_sendTransaction", params: [{ from: address, to: t.vault, value: `0x${wei.toString(16)}` }] });
      setState("sent"); setAmount(""); setNote("Sent. It shows in the treasury within a minute.");
    } catch (e) {
      setState("idle"); setNote(readableWalletError(e));
    }
  };
  return (
    <div className="border-t border-gray-200 bg-gray-50 px-4 py-5 sm:px-5 dark:border-gray-800 dark:bg-gray-900/40">
      <p className="mb-3 font-mono text-[10px] uppercase tracking-[0.2em] text-gray-400">Top up its treasury</p>
      <div className="flex flex-wrap items-center gap-2">
        <div className="relative w-40">
          <input aria-label="Amount of ETH" inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value.replace(/[^0-9.]/g, "").slice(0, 12))} placeholder="0.01" className="w-full rounded-xl border border-gray-200 bg-white px-3 py-2 pr-12 font-mono text-sm focus:border-gray-900 focus:outline-none dark:border-gray-700 dark:bg-gray-950 dark:focus:border-white" />
          <span className="pointer-events-none absolute inset-y-0 right-3 flex items-center text-xs text-gray-400">ETH</span>
        </div>
        {address
          ? <button type="button" onClick={() => void send()} disabled={!ok || state === "sending"} className="rounded-xl bg-gray-900 px-4 py-2 text-sm font-semibold text-white transition hover:bg-gray-700 disabled:opacity-50 dark:bg-white dark:text-gray-900 dark:hover:bg-gray-200">{state === "sending" ? "Confirm in your wallet…" : "Top up"}</button>
          : <button type="button" onClick={() => void connect()} disabled={busy} className="rounded-xl border border-gray-200 px-4 py-2 text-sm font-semibold transition hover:bg-white disabled:opacity-50 dark:border-gray-700 dark:hover:bg-gray-900">Connect a wallet</button>}
      </div>
      <p className="mt-2 text-xs text-gray-400">This mind is not fed by trading fees: it holds what people send it. What is sent cannot be taken back out by anybody; the mind spends it inside its limits.</p>
      {note && <p role="status" className="mt-2 text-sm text-gray-600 dark:text-gray-300">{note}</p>}
    </div>
  );
}

function Detail({ t }: { t: BoardToken }) {
  const shares = [
    { label: "Creator", bps: t.creatorBps, tone: "bg-gray-900 dark:bg-white" },
    { label: `Burn $${t.symbol ?? ""}`, bps: t.burnBps, tone: "bg-gray-500 dark:bg-gray-400" },
    { label: "Burn $AXON", bps: t.axonBps, tone: "bg-gray-400 dark:bg-gray-500" },
    { label: "The mind", bps: t.mindBps, tone: "bg-gray-300 dark:bg-gray-700" },
  ];
  const contracts = [["Token", t.token], ["Burn pot", t.pot], ...(t.splitter ? [["Fee splitter", t.splitter]] : []), ["Mind treasury", t.vault]] as [string, string][];
  return (
    <>
    <div className="grid gap-6 bg-gray-50 px-4 py-5 sm:px-5 lg:grid-cols-[1fr_1fr_auto] dark:bg-gray-900/40">
      <div>
        <p className="mb-2 font-mono text-[10px] uppercase tracking-[0.2em] text-gray-400">Locked at launch</p>
        {t.attached ? (
          <p className="text-sm text-gray-500 dark:text-gray-400">This token was launched before minds. Its fees go where they always went; its mind was given to it later.</p>
        ) : (
          <>
            <p className="text-sm"><span className="font-mono font-semibold tabular-nums">{pct(t.taxBps)}</span> <span className="text-gray-500 dark:text-gray-400">tax on every trade, divided like this:</span></p>
            <div className="mt-3 flex h-2 overflow-hidden rounded-full bg-gray-200 dark:bg-gray-800">
              {shares.map((s) => (s.bps ?? 0) > 0 && <span key={s.label} className={`${s.tone} border-r-2 border-gray-50 last:border-r-0 dark:border-[#0f1115]`} style={{ width: `${(s.bps ?? 0) / 100}%` }} />)}
            </div>
            <dl className="mt-3 grid grid-cols-2 gap-x-4 gap-y-1.5 text-xs">
              {shares.map((s) => (
                <div key={s.label} className="flex items-center gap-2">
                  <span className={`h-2 w-2 shrink-0 rounded-sm ${s.tone}`} aria-hidden />
                  <dt className="min-w-0 truncate text-gray-500 dark:text-gray-400">{s.label}</dt>
                  <dd className="ml-auto font-mono tabular-nums">{pct(s.bps)}</dd>
                </div>
              ))}
            </dl>
            <p className="mt-3 text-xs text-gray-400">Axon takes 0%.</p>
          </>
        )}
      </div>
      <div>
        <p className="mb-2 font-mono text-[10px] uppercase tracking-[0.2em] text-gray-400">Its contracts</p>
        <dl className="space-y-1.5 font-mono text-xs">
          {contracts.map(([k, v]) => (
            <div key={k} className="flex items-baseline justify-between gap-4">
              <dt className="shrink-0 font-sans text-gray-500 dark:text-gray-400">{k}</dt>
              <dd><a href={`${EXPLORER}/address/${v}`} target="_blank" rel="noopener noreferrer" className="text-gray-700 underline decoration-gray-300 underline-offset-2 hover:text-gray-900 dark:text-gray-300 dark:decoration-gray-700 dark:hover:text-white">{short(v)}</a></dd>
            </div>
          ))}
          <div className="flex items-baseline justify-between gap-4">
            <dt className="shrink-0 font-sans text-gray-500 dark:text-gray-400">Launched by</dt>
            <dd><a href={explorerTxUrl(t.txHash)} target="_blank" rel="noopener noreferrer" className="text-gray-700 underline decoration-gray-300 underline-offset-2 hover:text-gray-900 dark:text-gray-300 dark:decoration-gray-700 dark:hover:text-white">{short(t.creator)}</a></dd>
          </div>
        </dl>
      </div>
      <div className="flex flex-row gap-2 lg:flex-col">
        <a href={ponsTokenUrl(t.token)} target="_blank" rel="noopener noreferrer" className="rounded-xl bg-gray-900 px-4 py-2.5 text-center text-sm font-semibold text-white transition hover:bg-gray-700 dark:bg-white dark:text-gray-900 dark:hover:bg-gray-200">Trade on Pons</a>
        {t.agentId && <Link href={`/agents/${t.agentId}`} className="rounded-xl border border-gray-200 px-4 py-2.5 text-center text-sm font-semibold transition hover:bg-white dark:border-gray-700 dark:hover:bg-gray-900">Hire its agent</Link>}
      </div>
    </div>
    <Mind t={t} />
    {t.attached ? <TopUp t={t} /> : <Rewards t={t} />}
    </>
  );
}

export default function LaunchTerminal({ initial, openToken = null }: { initial: TerminalData; openToken?: string | null }) {
  const [data, setData] = useState(initial);
  const [sort, setSort] = useState<BoardSort>("new");
  const [open, setOpen] = useState<string | null>(openToken);
  const [page, setPage] = useState(1);
  const panel = useRef<HTMLDivElement>(null);
  const [now, setNow] = useState(() => Date.now());
  const [fresh, setFresh] = useState<Set<number>>(new Set());
  const seen = useRef(Math.max(0, ...initial.events.map((e) => e.id)));

  useEffect(() => {
    let alive = true;
    const load = () => fetch(`/api/minds/tokens?sort=${sort}&page=${page}${open ? `&open=${open}` : ""}`)
      .then((r) => (r.ok ? (r.json() as Promise<TerminalData>) : null))
      .then((d) => {
        if (!alive || !d) return;
        // what arrived since the last look is lit for a moment, so the eye finds it
        const news = d.events.filter((e) => e.id > seen.current).map((e) => e.id);
        if (news.length) {
          seen.current = Math.max(...news);
          setFresh(new Set(news));
          setTimeout(() => { if (alive) setFresh(new Set()); }, 2500);
        }
        setData(d);
        setNow(Date.now());
      })
      .catch(() => {});
    void load();
    const t = setInterval(load, POLL_MS);
    const tick = setInterval(() => setNow(Date.now()), 1000);
    return () => { alive = false; clearInterval(t); clearInterval(tick); };
  }, [sort, page, open]);

  const { totals, tokens, events, ethUsd } = data;
  const pages = Math.max(1, data.pages ?? 1);
  // the open token: on this page, or sent along because it is on another one
  const inPage = tokens.some((t) => t.token === open);
  const opened = open ? tokens.find((t) => t.token === open) ?? (data.opened?.token === open ? data.opened : null) : null;
  const pick = (token: string) => {
    const next = open === token ? null : token;
    setOpen(next);
    if (next) requestAnimationFrame(() => panel.current?.scrollIntoView({ behavior: "smooth", block: "start" }));
  };
  const turn = (to: number) => { setPage(Math.min(pages, Math.max(1, to))); document.getElementById("tokens")?.scrollIntoView({ behavior: "smooth", block: "start" }); };
  const stats = [
    { label: "Tokens launched", value: String(totals.tokens) },
    { label: "Fees paid out", value: ethText(totals.feesEth) },
    { label: "Spent on burns", value: ethText(totals.burnedEth) },
    { label: "Held by minds", value: ethText(totals.treasuryEth) },
  ];
  const holders = (n: number) => `${n} ${n === 1 ? "holder" : "holders"}`;

  return (
    <div>
      <dl className="grid grid-cols-2 gap-px overflow-hidden rounded-2xl border border-gray-200 bg-gray-200 lg:grid-cols-4 dark:border-gray-800 dark:bg-gray-800">
        {stats.map((s) => (
          <div key={s.label} className="bg-white px-4 py-4 sm:px-5 dark:bg-[#0a0a0a]">
            <dt className="font-mono text-[10px] uppercase tracking-[0.2em] text-gray-400">{s.label}</dt>
            <dd className="mt-1 font-mono text-xl font-semibold tabular-nums sm:text-2xl">{s.value}</dd>
          </div>
        ))}
      </dl>

      <div className="mt-8 grid gap-10">
        {/* ── every token ── */}
        <section id="tokens" aria-label="Tokens" className="min-w-0 scroll-mt-24">
          <div className="mb-3 flex items-center justify-between gap-3">
            <h2 className="text-sm font-semibold">Tokens</h2>
            <div className="flex rounded-lg border border-gray-200 p-0.5 text-xs dark:border-gray-800">
              {([["new", "Newest"], ["mcap", "Market cap"], ["burned", "Most burned"]] as const).map(([k, t]) => (
                <button key={k} type="button" onClick={() => { setSort(k); setPage(1); }} aria-pressed={sort === k} className={`rounded-md px-3 py-1.5 font-medium transition ${sort === k ? "bg-gray-900 text-white dark:bg-white dark:text-gray-900" : "text-gray-500 hover:text-gray-900 dark:hover:text-white"}`}>{t}</button>
              ))}
            </div>
          </div>

          {tokens.length === 0 ? (
            <div className="rounded-2xl border border-dashed border-gray-300 px-6 py-16 text-center dark:border-gray-700">
              <p className="text-lg font-semibold">Nothing has launched here yet.</p>
              <p className="mx-auto mt-2 max-w-sm text-sm text-gray-500 dark:text-gray-400">The first token launched on Axon shows up here the moment its transaction lands.</p>
              <Link href="/launch?new=1" className="mt-6 inline-flex rounded-xl bg-gray-900 px-5 py-3 text-sm font-semibold text-white transition hover:bg-gray-700 dark:bg-white dark:text-gray-900 dark:hover:bg-gray-200">Launch the first one</Link>
            </div>
          ) : (
            <>
              {opened && (
                <div ref={panel} className={`mb-5 scroll-mt-24 overflow-hidden rounded-2xl border border-gray-900 dark:border-white ${inPage ? "hidden md:block" : ""}`}>
                  <div className="flex items-center gap-3 px-4 py-3.5 sm:px-5">
                    <Logo src={opened.logo} symbol={opened.symbol} size={40} />
                    <div className="min-w-0 flex-1">
                      <p className="flex items-baseline gap-2"><span className="truncate text-lg font-semibold">{opened.name ?? short(opened.token)}</span><span className="shrink-0 font-mono text-xs text-gray-400">${opened.symbol ?? "?"}</span></p>
                      <p className="truncate text-xs text-gray-500 dark:text-gray-400">{opened.agentName ? `Agent: ${opened.agentName}` : "No agent"}</p>
                    </div>
                    <dl className="hidden shrink-0 gap-6 text-right font-mono text-xs tabular-nums sm:flex">
                      {([["Market cap", money(opened.mcapEth, ethUsd)], ["Holders", opened.attached ? "…" : String(opened.holders)], ["Burned", opened.burnedTokens > 0 ? compact(opened.burnedTokens) : "0"], ["Mind holds", ethText(opened.treasuryEth)]] as const).map(([k, v]) => (
                        <div key={k}><dt className="text-[10px] uppercase tracking-[0.12em] text-gray-400">{k}</dt><dd className="mt-0.5 text-sm font-semibold">{v}</dd></div>
                      ))}
                    </dl>
                    <button type="button" onClick={() => setOpen(null)} aria-label="Close" className="ml-2 grid h-9 w-9 shrink-0 place-items-center rounded-lg border border-gray-200 text-lg leading-none text-gray-500 transition hover:bg-gray-50 hover:text-gray-900 dark:border-gray-800 dark:hover:bg-gray-900 dark:hover:text-white">×</button>
                  </div>
                  <div className="border-t border-gray-200 dark:border-gray-800"><Detail t={opened} /></div>
                </div>
              )}
              {/* a phone gets one card a token: a table squeezed to that width reads as nothing */}
              <ul className="divide-y divide-gray-100 overflow-hidden rounded-2xl border border-gray-200 md:hidden dark:divide-gray-800/70 dark:border-gray-800">
                {tokens.map((t) => (
                  <li key={t.token}>
                    <button type="button" onClick={() => setOpen(open === t.token ? null : t.token)} aria-expanded={open === t.token} className="flex w-full items-center gap-3 px-4 py-3.5 text-left">
                      <Logo src={t.logo} symbol={t.symbol} size={40} />
                      <span className="min-w-0 flex-1">
                        <span className="flex items-baseline gap-2">
                          <span className="truncate font-semibold">{t.name ?? short(t.token)}</span>
                          <span className="shrink-0 font-mono text-xs text-gray-400">${t.symbol ?? "?"}</span>
                          <span className="ml-auto shrink-0 font-mono text-sm font-semibold tabular-nums">{money(t.mcapEth, ethUsd)}</span>
                        </span>
                        <span className="mt-0.5 flex items-center gap-2 text-xs text-gray-500 dark:text-gray-400">
                          <span className="min-w-0 truncate">{t.agentName ? `Agent: ${t.agentName}` : "No agent"}</span>
                          <span className="ml-auto shrink-0 font-mono tabular-nums" suppressHydrationWarning>{t.attached ? "" : `${holders(t.holders)} · `}{ago(t.launchedAt, now)}</span>
                        </span>
                        <span className="mt-2 block"><Curve t={t} /></span>
                      </span>
                    </button>
                    {open === t.token && <Detail t={t} />}
                  </li>
                ))}
              </ul>

              {/* a wide screen gets large cards, five across; the open one's numbers show in the panel above them */}
              <div className="hidden gap-4 md:grid md:grid-cols-3 lg:grid-cols-5">
                {tokens.map((t) => (
                  <button key={t.token} type="button" onClick={() => pick(t.token)} aria-expanded={open === t.token} className={`${tokenCardFrame} ${open === t.token ? "border-gray-900 dark:border-white" : "border-gray-200 hover:border-gray-900 dark:border-gray-800 dark:hover:border-white"}`}>
                    <TokenCard t={t} usd={ethUsd} age={ago(t.launchedAt, now)} />
                  </button>
                ))}
              </div>

              {pages > 1 && (
                <nav aria-label="Pages" className="mt-6 flex items-center justify-center gap-1.5 text-sm">
                  <button type="button" onClick={() => turn(page - 1)} disabled={page <= 1} className="rounded-lg border border-gray-200 px-3 py-2 font-medium transition hover:bg-gray-50 disabled:opacity-40 dark:border-gray-800 dark:hover:bg-gray-900">Previous</button>
                  {Array.from({ length: pages }, (_, i) => i + 1).filter((n) => n === 1 || n === pages || Math.abs(n - page) <= 1).map((n, i, shown) => (
                    <Fragment key={n}>
                      {i > 0 && n - shown[i - 1] > 1 && <span className="px-1 text-gray-400">…</span>}
                      <button type="button" onClick={() => turn(n)} aria-current={n === page ? "page" : undefined} className={`min-w-9 rounded-lg px-3 py-2 font-mono tabular-nums transition ${n === page ? "bg-gray-900 text-white dark:bg-white dark:text-gray-900" : "border border-gray-200 hover:bg-gray-50 dark:border-gray-800 dark:hover:bg-gray-900"}`}>{n}</button>
                    </Fragment>
                  ))}
                  <button type="button" onClick={() => turn(page + 1)} disabled={page >= pages} className="rounded-lg border border-gray-200 px-3 py-2 font-medium transition hover:bg-gray-50 disabled:opacity-40 dark:border-gray-800 dark:hover:bg-gray-900">Next</button>
                </nav>
              )}
            </>
          )}
        </section>

        {/* ── what is happening ── */}
        <section aria-label="Live" className="min-w-0">
          <div className="mb-3 flex items-center gap-2">
            <span className="relative flex h-2 w-2" aria-hidden>
              <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-500 opacity-60 motion-reduce:animate-none" />
              <span className="relative inline-flex h-2 w-2 rounded-full bg-emerald-500" />
            </span>
            <h2 className="text-sm font-semibold">Live</h2>
          </div>
          <div className="overflow-hidden rounded-2xl border border-gray-200 dark:border-gray-800">
            {events.length === 0 ? (
              <p className="px-4 py-10 text-center text-sm text-gray-400">Launches, fees paid out and burns show here as they happen.</p>
            ) : (
              <ol className="max-h-[560px] overflow-y-auto font-mono text-xs md:grid md:max-h-none md:grid-cols-2 lg:grid-cols-3">
                {events.map((e) => (
                  <li key={e.id} className={`flex items-center gap-3 border-b border-gray-100 px-4 py-2.5 transition-colors duration-1000 md:[&:nth-child(n+19)]:hidden dark:border-gray-800/70 ${fresh.has(e.id) ? "bg-emerald-50 dark:bg-emerald-950/40" : ""}`}>
                    <Logo src={e.logo} symbol={e.symbol} size={22} />
                    <span className="min-w-0 flex-1 truncate"><span className="font-semibold">${e.symbol ?? "?"}</span> <span className="text-gray-500 dark:text-gray-400">{eventText(e)}</span></span>
                    <time dateTime={e.at} className="shrink-0 tabular-nums text-gray-400" suppressHydrationWarning>{ago(e.at, now)}</time>
                  </li>
                ))}
              </ol>
            )}
          </div>
        </section>
      </div>
      <p className="mt-10 max-w-3xl text-xs leading-relaxed text-gray-400">
        Tokens here are launched by their creators, not by Axon. Axon takes 0% of any token&apos;s fees and charges no launch fee of its own. A token&apos;s tax, where its fees go and what its mind may do are fixed when it launches and cannot be changed by anybody. Tokens can lose all of their value. Nothing on this page is financial advice; trade at your own risk.
      </p>
    </div>
  );
}
