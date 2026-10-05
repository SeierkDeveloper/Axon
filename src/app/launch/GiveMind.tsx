"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { decodeEventLog, encodeFunctionData, parseAbi } from "viem";
import { useWallet } from "@/components/WalletProvider";
import { CHAIN_ID_HEX, CHAIN_PARAMS, provider, readableWalletError } from "@/lib/chain";
import { CEILINGS, DEFAULT_SETTINGS, checkLimits, mindLimits, type MindLimits } from "@/lib/mindsLaunch";
import { DEFAULT_MIND_MODEL, MIND_MODELS, OWN_MIND, mindLabel } from "@/lib/mindsModels";

/**
 * A mind for a token that was launched before minds. Only the wallet that launched the token through its burn pot can
 * do this, and the chain is what says so. The token itself does not change: its fees keep going where they always
 * went. Its mind gets a treasury of its own, filled by top-ups, and limits that are set here once.
 */

// kept here rather than imported from the server's module: the same two entries, checked against the contract's source
const ATTACH_ABI = parseAbi([
  "function attachMind(address pot, (uint8 allowed,uint96 maxPerDay,uint96 maxPerAction,uint16 maxActionsPerDay,uint96 maxCostPerDay) limits) returns (address vault)",
  "event MindAttached(address indexed token, address indexed creator, address pot, address vault)",
]);

interface Check { ok: boolean; reason: string | null; token: { token: string; name: string | null; symbol: string | null; pot: string | null } }
type Step = "idle" | "preparing" | "wallet" | "confirming" | "reading" | "done";
const STEP: Record<Exclude<Step, "idle" | "done">, string> = { preparing: "Getting it ready…", wallet: "Confirm in your wallet…", confirming: "Waiting for the chain…", reading: "Waking the mind…" };

const input = "w-full rounded-xl border border-gray-200 bg-white px-4 py-3 text-sm text-gray-900 placeholder:text-gray-400 focus:border-gray-900 focus:outline-none dark:border-gray-800 dark:bg-gray-950 dark:text-white dark:focus:border-white";
const label = "mb-2 block font-mono text-[11px] uppercase tracking-[0.2em] text-gray-400";

export default function GiveMind({ token: given }: { token: string }) {
  const { apiKey, address, signIn, busy: walletBusy } = useWallet();
  const [token, setToken] = useState(given);
  const [answer, setCheck] = useState<Check | null>(null);
  const [models, setModels] = useState<{ id: string; available: boolean }[] | null>(null);
  const [ownOpen, setOwnOpen] = useState(true);
  const [model, setModel] = useState(DEFAULT_MIND_MODEL);
  const [mindUrl, setMindUrl] = useState("");
  const [limits, setLimits] = useState<MindLimits>({ ...DEFAULT_SETTINGS, canReward: false });
  const [agreed, setAgreed] = useState(false);
  const [step, setStep] = useState<Step>("idle");
  const [error, setError] = useState<string | null>(null);
  const set = <K extends keyof MindLimits>(k: K, v: MindLimits[K]) => setLimits((p) => ({ ...p, [k]: v }));

  useEffect(() => {
    let alive = true;
    fetch("/api/minds/launch").then((r) => (r.ok ? r.json() : null)).then((d: { models?: { id: string; available: boolean }[]; ownOpen?: boolean } | null) => { if (alive && d) { setModels(d.models ?? null); setOwnOpen(d.ownOpen !== false); } }).catch(() => {});
    return () => { alive = false; };
  }, []);

  // what the chain says about this token and this wallet; with no token typed, the one the wallet launched earlier
  useEffect(() => {
    const t = token.trim();
    if (t && !/^0x[0-9a-fA-F]{40}$/.test(t)) return;
    if (!t && !address) return;
    let alive = true;
    const q = new URLSearchParams({ ...(address ? { wallet: address } : {}), ...(t ? { token: t } : {}) });
    fetch(`/api/minds/attach?${q}`).then((r) => (r.ok ? r.json() : null)).then((d: { check: Check | null } | null) => {
      if (!alive || !d) return;
      setCheck(d.check);
      if (!t && d.check) setToken(d.check.token.token);
    }).catch(() => {});
    return () => { alive = false; };
  }, [token, address]);

  // an answer is only about the address it was asked for: a different address in the box has no answer yet
  const check = answer && answer.token.token === token.trim().toLowerCase() ? answer : null;
  const bad = checkLimits(limits);
  const missing = !check ? "Enter your token's address" : !check.ok ? "This token cannot be given a mind" : model === OWN_MIND && !/^https:\/\/\S+\.\S+/.test(mindUrl.trim()) ? "Give your server's https address" : null;

  const give = async () => {
    if (!apiKey || !address || !check?.ok || bad || missing || !agreed) return;
    setError(null);
    try {
      setStep("preparing");
      const pr = await fetch("/api/minds/attach", { method: "POST", headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" }, body: JSON.stringify({ token: check.token.token, model, ...(model === OWN_MIND ? { mindUrl: mindUrl.trim() } : {}) }) });
      const prepared = (await pr.json().catch(() => ({}))) as { pot?: `0x${string}`; launcher?: string; error?: string };
      if (!pr.ok || !prepared.pot || !prepared.launcher) throw new Error(prepared.error ?? "It could not be prepared.");

      setStep("wallet");
      const p = provider();
      if (!p) throw new Error("No wallet.");
      const chain = (await p.request({ method: "eth_chainId" })) as string;
      if (chain?.toLowerCase() !== CHAIN_ID_HEX) {
        try { await p.request({ method: "wallet_switchEthereumChain", params: [{ chainId: CHAIN_ID_HEX }] }); }
        catch (e) { if ((e as { code?: number }).code === 4902) await p.request({ method: "wallet_addEthereumChain", params: [CHAIN_PARAMS] }); else throw e; }
      }
      const data = encodeFunctionData({ abi: ATTACH_ABI, functionName: "attachMind", args: [prepared.pot, mindLimits(limits)] });
      const hash = (await p.request({ method: "eth_sendTransaction", params: [{ from: address, to: prepared.launcher, data }] })) as string;

      setStep("confirming");
      let landed = false;
      for (let i = 0; i < 120 && !landed; i++) {
        const r = (await p.request({ method: "eth_getTransactionReceipt", params: [hash] })) as { status: string; logs: { topics: string[]; data: string }[] } | null;
        if (r) {
          if (r.status !== "0x1") throw new Error("The chain refused it. Nothing changed; only the gas was spent.");
          landed = r.logs.some((log) => { try { return decodeEventLog({ abi: ATTACH_ABI, topics: log.topics as [`0x${string}`, ...`0x${string}`[]], data: log.data as `0x${string}` }).eventName === "MindAttached"; } catch { return false; } });
          if (!landed) throw new Error("It went through, but its record could not be read here. It will appear on its own shortly.");
        } else await new Promise((ok) => setTimeout(ok, 1500));
      }
      if (!landed) throw new Error("The chain has not answered yet. Check your wallet's activity before trying again.");

      setStep("reading");
      for (let i = 0; i < 20; i++) {
        await fetch("/api/minds/sync", { method: "POST" }).catch(() => {});
        const t = await fetch(`/api/minds/tokens/${check.token.token}`).then((x) => x.ok).catch(() => false);
        if (t) break;
        await new Promise((ok) => setTimeout(ok, 2000));
      }
      setStep("done");
    } catch (e) {
      setError(e instanceof Error && !("code" in e) ? e.message : readableWalletError(e));
      setStep("idle");
    }
  };

  if (step === "done" && check) {
    return (
      <div className="mx-auto max-w-xl rounded-2xl border border-gray-200 p-8 text-center dark:border-gray-800">
        <p className="font-mono text-[11px] uppercase tracking-[0.2em] text-gray-400">Done</p>
        <h2 className="mt-2 text-3xl font-bold tracking-tight">${check.token.symbol ?? "Your token"} has a mind.</h2>
        <p className="mt-3 text-sm text-gray-500 dark:text-gray-400">It runs on {mindLabel(model).replace(/^Its/, "its")}. Its treasury is empty until somebody tops it up: it wakes when it can pay for a thought.</p>
        <Link href={`/launch?token=${check.token.token}`} className="mt-6 inline-flex rounded-xl bg-gray-900 px-5 py-3 text-sm font-semibold text-white transition hover:bg-gray-700 dark:bg-white dark:text-gray-900 dark:hover:bg-gray-200">See it and top it up</Link>
      </div>
    );
  }

  const working = step !== "idle";
  const ethField = (k: "maxPerDayEth" | "maxPerActionEth" | "maxCostPerDayEth", text: string) => (
    <div>
      <label htmlFor={`g-${k}`} className={label}>{text}</label>
      <div className="relative">
        <input id={`g-${k}`} inputMode="decimal" value={limits[k]} onChange={(e) => set(k, e.target.value.replace(/[^0-9.]/g, "").slice(0, 12))} className={`${input} pr-14 font-mono`} />
        <span className="pointer-events-none absolute inset-y-0 right-4 flex items-center text-xs text-gray-400">ETH</span>
      </div>
    </div>
  );

  return (
    <div className="mx-auto max-w-2xl space-y-8">
      <section className="rounded-2xl border border-gray-200 p-5 sm:p-6 dark:border-gray-800">
        <label htmlFor="g-token" className={label}>Your token</label>
        <input id="g-token" value={token} onChange={(e) => setToken(e.target.value.trim().slice(0, 42))} placeholder="0x… the token's address" spellCheck={false} className={`${input} font-mono`} />
        {check && (
          <p className={`mt-3 text-sm ${check.ok ? "text-gray-700 dark:text-gray-200" : "text-gray-500 dark:text-gray-400"}`}>
            {check.token.name && <><span className="font-semibold">{check.token.name}</span> <span className="font-mono text-xs text-gray-400">${check.token.symbol}</span>. </>}
            {check.ok ? "Your wallet launched it, so you can give it a mind." : check.reason}
          </p>
        )}
        <p className="mt-3 text-xs text-gray-400">Only the wallet that launched a token through its own burn pot can give it a mind. The token does not change: its fees keep going where they always went.</p>
      </section>

      <section className="rounded-2xl border border-gray-200 p-5 sm:p-6 dark:border-gray-800">
        <p className={label}>Its mind</p>
        <div role="radiogroup" aria-label="The model its mind runs on" className="grid grid-cols-2 gap-2 sm:grid-cols-3">
          {MIND_MODELS.map((m) => {
            const available = models ? (models.find((x) => x.id === m.id)?.available ?? false) : m.id === DEFAULT_MIND_MODEL;
            return (
              <button key={m.id} type="button" role="radio" aria-checked={model === m.id} disabled={!available} onClick={() => setModel(m.id)}
                className={`rounded-xl border px-3 py-2.5 text-left transition disabled:cursor-not-allowed disabled:opacity-40 ${model === m.id ? "border-gray-900 bg-gray-900 text-white dark:border-white dark:bg-white dark:text-gray-900" : "border-gray-200 hover:border-gray-900 dark:border-gray-800 dark:hover:border-white"}`}>
                <span className="block truncate text-sm font-semibold">{m.label}</span>
                <span className={`block truncate text-[11px] ${model === m.id ? "text-gray-300 dark:text-gray-500" : "text-gray-400"}`}>{available ? m.maker : "Not open yet"}</span>
              </button>
            );
          })}
          <button type="button" role="radio" aria-checked={model === OWN_MIND} disabled={!ownOpen} onClick={() => setModel(OWN_MIND)}
            className={`rounded-xl border px-3 py-2.5 text-left transition disabled:cursor-not-allowed disabled:opacity-40 ${model === OWN_MIND ? "border-gray-900 bg-gray-900 text-white dark:border-white dark:bg-white dark:text-gray-900" : "border-dashed border-gray-300 hover:border-gray-900 dark:border-gray-700 dark:hover:border-white"}`}>
            <span className="block truncate text-sm font-semibold">Your own</span>
            <span className={`block truncate text-[11px] ${model === OWN_MIND ? "text-gray-300 dark:text-gray-500" : "text-gray-400"}`}>Your server, any AI</span>
          </button>
        </div>
        {model === OWN_MIND && (
          <div className="mt-4">
            <label htmlFor="g-url" className={label}>Your server&apos;s address</label>
            <input id="g-url" value={mindUrl} onChange={(e) => setMindUrl(e.target.value.trim().slice(0, 300))} placeholder="https://…" spellCheck={false} className={`${input} font-mono`} />
            <p className="mt-2 text-xs text-gray-400">The launch screen has a test button, your signing secret and a server to start from.</p>
          </div>
        )}
      </section>

      <section className="space-y-6 rounded-2xl border border-gray-200 p-5 sm:p-6 dark:border-gray-800">
        <div>
          <p className="mb-3 text-sm font-medium">What the mind may do with its treasury</p>
          <div className="space-y-2">
            {([["canBuyback", `Buy back and burn $${check?.token.symbol ?? "TOKEN"}`], ["canBurnAxon", "Burn $AXON"]] as const).map(([k, t]) => (
              <label key={k} className="flex cursor-pointer items-center gap-3 text-sm">
                <input type="checkbox" checked={limits[k]} onChange={(e) => set(k, e.target.checked)} className="h-4 w-4 accent-gray-900 dark:accent-white" />
                {t}
              </label>
            ))}
            <p className="flex items-center gap-3 text-sm text-gray-400"><span className="h-4 w-4 shrink-0 rounded border border-gray-300 dark:border-gray-700" aria-hidden />Reward holders is not open for a token launched before minds</p>
          </div>
          <p className="mt-3 text-xs text-gray-400">It can never withdraw. Buybacks go through the token&apos;s own burn pot.</p>
        </div>
        <div className="grid gap-4 sm:grid-cols-2">
          {ethField("maxPerDayEth", "Most it spends a day")}
          {ethField("maxPerActionEth", "Most in one action")}
          <div>
            <label htmlFor="g-actions" className={label}>Actions a day</label>
            <input id="g-actions" inputMode="numeric" value={limits.maxActionsPerDay} onChange={(e) => set("maxActionsPerDay", Math.min(CEILINGS.actionsPerDay, Number(e.target.value.replace(/\D/g, "")) || 0))} className={`${input} font-mono`} />
          </div>
          {ethField("maxCostPerDayEth", "Most its thinking costs a day")}
        </div>
      </section>

      <section className="rounded-2xl border border-gray-200 p-5 sm:p-6 dark:border-gray-800">
        <label className="flex cursor-pointer items-start gap-3 text-sm">
          <input type="checkbox" checked={agreed} onChange={(e) => setAgreed(e.target.checked)} className="mt-0.5 h-4 w-4 shrink-0 accent-gray-900 dark:accent-white" />
          <span>I understand that a token gets one mind, and that what it may do and its limits cannot be changed afterwards, by me or by anyone.</span>
        </label>
        {!apiKey ? (
          <button type="button" onClick={() => void signIn()} disabled={walletBusy} className="mt-5 w-full rounded-xl bg-gray-900 px-4 py-3.5 text-sm font-semibold text-white transition hover:bg-gray-700 disabled:opacity-60 dark:bg-white dark:text-gray-900 dark:hover:bg-gray-200">
            {walletBusy ? "Waiting for your wallet…" : "Sign in with the wallet that launched it"}
          </button>
        ) : (
          <button type="button" onClick={() => void give()} disabled={working || Boolean(missing) || Boolean(bad) || !agreed} className="mt-5 w-full rounded-xl bg-gray-900 px-4 py-3.5 text-sm font-semibold text-white transition hover:bg-gray-700 disabled:opacity-50 dark:bg-white dark:text-gray-900 dark:hover:bg-gray-200">
            {working ? STEP[step as keyof typeof STEP] : missing ?? bad ?? (agreed ? "Give it a mind" : "Tick the box to go on")}
          </button>
        )}
        {error && <p role="alert" className="mt-3 text-sm text-red-600 dark:text-red-400">{error}</p>}
        <p className="mt-5 text-xs leading-relaxed text-gray-400">One transaction, signed by your own wallet, and only gas to pay. Axon takes nothing. The mind&apos;s treasury starts empty: anybody can top it up, and nobody can take it back out.</p>
      </section>
    </div>
  );
}
