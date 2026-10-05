"use client";

/* eslint-disable @next/next/no-img-element -- the pictures here are previews of a file still in the browser */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { decodeEventLog, encodeFunctionData, formatEther } from "viem";
import { useWallet } from "@/components/WalletProvider";
import { CHAIN_ID_HEX, CHAIN_PARAMS, explorerTxUrl, ponsTokenUrl, provider, readableWalletError } from "@/lib/chain";
import { CEILINGS, DEFAULT_SETTINGS, MIND_LAUNCH_ABI, checkSettings, creatorBps, launchInput, launchValue, lockedSummary, type LaunchSettings } from "@/lib/mindsLaunch";
import { DEFAULT_MIND_MODEL, MIND_MODELS, OWN_MIND, mindLabel } from "@/lib/mindsModels";
import { OWN_SERVER_EXAMPLE } from "@/lib/mindsOwnExample";

/**
 * Launching a token with an agent and a mind behind it, on one screen and in one signature.
 *
 * Four things are asked for: a name, a ticker, a picture, and one line about what the agent does (or an agent the
 * wallet already owns). Everything else has a default and sits under Advanced. Whatever is chosen is shown as it will
 * be locked, before the wallet opens, because none of it can be changed after.
 */

export interface Prefill { name: string; symbol: string; line: string; agentId: string }

interface Info { launcher: string | null; launchFeeWei: string; agents: { agentId: string; name: string }[]; models?: { id: string; label: string; maker: string; available: boolean }[]; ownOpen?: boolean }
type Trial = { ok: true; thought: string; action: { kind: string; eth: number } | null; verdict: string; verdictReason: string | null; ms: number } | { ok: false; error: string };
interface Done { token: string; txHash: string; pot: string; splitter: string; vault: string; agentId: string | null }
type Step = "idle" | "picture" | "preparing" | "wallet" | "confirming" | "reading" | "done";

const STEP_TEXT: Record<Exclude<Step, "idle" | "done">, string> = {
  picture: "Saving the picture…",
  preparing: "Getting the launch ready…",
  wallet: "Confirm in your wallet…",
  confirming: "Waiting for the chain…",
  reading: "Setting up the agent…",
};

const PICTURE_SIDE = 512;
const PICTURE_BYTES = 500 * 1024;

/** The picture as a square the size a token needs: cropped to its middle, small enough to keep. */
async function squared(file: File): Promise<Blob> {
  // an animation stays an animation: it is sent as it is when it is small enough
  if (file.type === "image/gif" && file.size <= PICTURE_BYTES) return file;
  const bitmap = await createImageBitmap(file);
  const side = Math.min(bitmap.width, bitmap.height);
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = Math.min(PICTURE_SIDE, side);
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("This browser cannot read that picture.");
  ctx.drawImage(bitmap, (bitmap.width - side) / 2, (bitmap.height - side) / 2, side, side, 0, 0, canvas.width, canvas.height);
  const as = (type: string, quality?: number) => new Promise<Blob | null>((res) => canvas.toBlob(res, type, quality));
  const png = await as("image/png");
  if (png && png.size <= PICTURE_BYTES) return png;
  const jpeg = await as("image/jpeg", 0.9);
  if (jpeg && jpeg.size <= PICTURE_BYTES) return jpeg;
  throw new Error("That picture is too large. Try a simpler one.");
}

const pct = (bps: number) => `${+(bps / 100).toFixed(1)}%`;
const input = "w-full rounded-xl border border-gray-200 bg-white px-4 py-3 text-sm text-gray-900 placeholder:text-gray-400 focus:border-gray-900 focus:outline-none dark:border-gray-800 dark:bg-gray-950 dark:text-white dark:focus:border-white";
const label = "mb-2 block font-mono text-[11px] uppercase tracking-[0.2em] text-gray-400";

export default function MindLaunch({ prefill }: { prefill: Prefill }) {
  const { apiKey, address, signIn, busy: walletBusy } = useWallet();
  const [info, setInfo] = useState<Info | null>(null);

  const [name, setName] = useState(prefill.name);
  const [symbol, setSymbol] = useState(prefill.symbol);
  const [line, setLine] = useState(prefill.line);
  const [own, setOwn] = useState(Boolean(prefill.agentId));
  const [agentId, setAgentId] = useState(prefill.agentId);
  const [picture, setPicture] = useState<{ blob: Blob; preview: string } | null>(null);
  const [settings, setSettings] = useState<Omit<LaunchSettings, "payout">>(DEFAULT_SETTINGS);
  const [payout, setPayout] = useState("");
  const [model, setModel] = useState(DEFAULT_MIND_MODEL);
  const [mindUrl, setMindUrl] = useState("");
  const [secret, setSecret] = useState<string | null>(null);
  const [trial, setTrial] = useState<Trial | "running" | null>(null);
  const [advanced, setAdvanced] = useState(false);
  const [agreed, setAgreed] = useState(false);

  const [step, setStep] = useState<Step>("idle");
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<Done | null>(null);
  const file = useRef<HTMLInputElement>(null);

  // the payout wallet is the signed-in one unless the creator names another
  const s: LaunchSettings = useMemo(() => ({ ...settings, payout: payout.trim() || address || "" }), [settings, payout, address]);
  const set = <K extends keyof typeof settings>(k: K, v: (typeof settings)[K]) => setSettings((p) => ({ ...p, [k]: v }));

  useEffect(() => {
    let alive = true;
    fetch(`/api/minds/launch${address ? `?wallet=${address}` : ""}`)
      .then((r) => (r.ok ? (r.json() as Promise<Info>) : null))
      .then((d) => { if (alive && d) setInfo(d); })
      .catch(() => {});
    return () => { alive = false; };
  }, [address]);

  useEffect(() => () => { if (picture) URL.revokeObjectURL(picture.preview); }, [picture]);

  // the secret Axon signs its requests with, for a creator who runs the mind on their own server
  useEffect(() => {
    if (model !== OWN_MIND || !apiKey || secret) return;
    let alive = true;
    fetch("/api/minds/own/secret", { headers: { authorization: `Bearer ${apiKey}` } })
      .then((r) => (r.ok ? (r.json() as Promise<{ secret: string }>) : null))
      .then((d) => { if (alive && d) setSecret(d.secret); })
      .catch(() => {});
    return () => { alive = false; };
  }, [model, apiKey, secret]);

  const tryServer = async () => {
    if (!apiKey || trial === "running") return;
    setTrial("running");
    const r = await fetch("/api/minds/own/test", { method: "POST", headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" }, body: JSON.stringify({ url: mindUrl.trim() }) }).catch(() => null);
    // either the test's own answer, or the API's refusal ({ error }) when it never ran
    const d = r ? ((await r.json().catch(() => null)) as Partial<Trial> & { error?: string } | null) : null;
    setTrial(d && typeof d.ok === "boolean" ? (d as Trial) : { ok: false, error: d?.error ?? "The test could not be run." });
  };

  const pick = async (f: File | undefined) => {
    if (!f) return;
    setError(null);
    try {
      const blob = await squared(f);
      setPicture({ blob, preview: URL.createObjectURL(blob) });
    } catch (e) {
      setError(e instanceof Error ? e.message : "That picture could not be read.");
    }
  };

  const agents = info?.agents ?? [];
  const chosen = agents.find((a) => a.agentId === agentId) ?? null;
  const feeWei = info ? BigInt(info.launchFeeWei) : null;
  const total = feeWei !== null ? launchValue(feeWei, s) : null;
  // a mind on the creator's own server does its thinking there: nothing comes out of the treasury for it
  const locked = lockedSummary(symbol, s).map((r) => (model === OWN_MIND && r.label === "Its thinking" ? { ...r, value: "on your own server, at no cost to its treasury" } : r));
  const summary = [...locked.slice(0, -1), { label: "Its mind runs on", value: mindLabel(model) }, ...locked.slice(-1)];
  // a model this server has no key for cannot be picked; the list itself is the same everywhere
  const models = MIND_MODELS.map((m) => ({ ...m, available: info?.models?.find((x) => x.id === m.id)?.available ?? m.id === DEFAULT_MIND_MODEL }));

  const missing = !name.trim() ? "Give the token a name"
    : !/^[A-Z0-9]{2,10}$/.test(symbol) ? "Give it a ticker"
    : !picture ? "Add a picture"
    : own ? (!chosen ? "Pick one of your agents" : null)
    : line.trim().length < 12 ? "Say what the agent does"
    : model === OWN_MIND && !/^https:\/\/\S+\.\S+/.test(mindUrl.trim()) ? "Give your server's https address"
    : null;
  const bad = address ? checkSettings(s) : null;

  const send = useCallback(async (to: string, data: `0x${string}`, value: bigint) => {
    const p = provider();
    if (!p || !address) throw new Error("No wallet.");
    // a launch pointed at the wrong chain deploys into nothing and cannot be undone
    const chain = (await p.request({ method: "eth_chainId" })) as string;
    if (chain?.toLowerCase() !== CHAIN_ID_HEX) {
      try {
        await p.request({ method: "wallet_switchEthereumChain", params: [{ chainId: CHAIN_ID_HEX }] });
      } catch (e) {
        if ((e as { code?: number }).code === 4902) await p.request({ method: "wallet_addEthereumChain", params: [CHAIN_PARAMS] });
        else throw e;
      }
    }
    return (await p.request({ method: "eth_sendTransaction", params: [{ from: address, to, data, value: `0x${value.toString(16)}` }] })) as string;
  }, [address]);

  const receipt = async (hash: string) => {
    const p = provider();
    for (let i = 0; i < 120 && p; i++) {
      const r = (await p.request({ method: "eth_getTransactionReceipt", params: [hash] })) as { status: string; logs: { topics: string[]; data: string }[] } | null;
      if (r) {
        if (r.status !== "0x1") throw new Error("The launch was refused by the chain. Nothing was launched; only the gas was spent.");
        return r;
      }
      await new Promise((ok) => setTimeout(ok, 1500));
    }
    throw new Error("The chain has not answered yet. Check your wallet's activity before trying again.");
  };

  const launch = async () => {
    if (!apiKey || !address || !info?.launcher || feeWei === null || !picture || missing || bad || !agreed) return;
    setError(null);
    const auth = { authorization: `Bearer ${apiKey}` };
    try {
      setStep("picture");
      const up = await fetch("/api/minds/logo", { method: "POST", headers: { ...auth, "content-type": picture.blob.type || "application/octet-stream" }, body: picture.blob });
      const logo = (await up.json().catch(() => ({}))) as { url?: string; error?: string };
      if (!up.ok || !logo.url) throw new Error(logo.error ?? "The picture could not be saved.");

      setStep("preparing");
      const description = own ? "" : line.trim();
      const pr = await fetch("/api/minds/prepare", { method: "POST", headers: { ...auth, "content-type": "application/json" }, body: JSON.stringify({ name: name.trim(), symbol, logo: logo.url, ...(own ? { agentId } : { line: line.trim() }), description, model, ...(model === OWN_MIND ? { mindUrl: mindUrl.trim() } : {}) }) });
      const prepared = (await pr.json().catch(() => ({}))) as { ref?: `0x${string}`; launcher?: string; error?: string };
      if (!pr.ok || !prepared.ref || !prepared.launcher) throw new Error(prepared.error ?? "The launch could not be prepared.");

      setStep("wallet");
      const data = encodeFunctionData({ abi: MIND_LAUNCH_ABI, functionName: "launch", args: [launchInput({ name: name.trim(), symbol, logo: logo.url, description: description || `${name.trim()}, an agent on Axon` }, prepared.ref, s)] });
      const hash = await send(prepared.launcher, data, launchValue(feeWei, s));

      setStep("confirming");
      const r = await receipt(hash);
      let found: Omit<Done, "txHash" | "agentId"> | null = null;
      for (const log of r.logs) {
        try {
          const ev = decodeEventLog({ abi: MIND_LAUNCH_ABI, topics: log.topics as [`0x${string}`, ...`0x${string}`[]], data: log.data as `0x${string}` });
          if (ev.eventName === "Launched") { found = { token: ev.args.token, pot: ev.args.pot, splitter: ev.args.splitter, vault: ev.args.vault }; break; }
        } catch { /* another contract's event */ }
      }
      if (!found) throw new Error("The launch went through, but its record could not be read here. It will appear on its own shortly.");

      // the token is on the chain now; what is left is Axon reading it and giving it its agent
      setStep("reading");
      let linked: string | null = own ? agentId : null;
      for (let i = 0; i < 20; i++) {
        await fetch("/api/minds/sync", { method: "POST" }).catch(() => {});
        const t = await fetch(`/api/minds/tokens/${found.token}`).then((x) => (x.ok ? (x.json() as Promise<{ agentId: string | null }>) : null)).catch(() => null);
        if (t) { linked = t.agentId; break; }
        await new Promise((ok) => setTimeout(ok, 2000));
      }
      setDone({ ...found, txHash: hash, agentId: linked });
      setStep("done");
    } catch (e) {
      setError(e instanceof Error && !("code" in e) ? e.message : readableWalletError(e));
      setStep("idle");
    }
  };

  if (step === "done" && done) {
    return (
      <div className="mx-auto max-w-xl rounded-2xl border border-gray-200 p-8 text-center dark:border-gray-800">
        {picture && <img src={picture.preview} alt="" className="mx-auto h-20 w-20 rounded-2xl object-cover" />}
        <p className="mt-5 font-mono text-[11px] uppercase tracking-[0.2em] text-gray-400">Live on Robinhood Chain</p>
        <h2 className="mt-2 text-3xl font-bold tracking-tight">${symbol} is live.</h2>
        <p className="mt-3 text-sm text-gray-500 dark:text-gray-400">
          {name.trim()} has a token, an agent that works for it and a mind with its own treasury. What you chose is locked.
        </p>
        <div className="mt-6 flex flex-wrap justify-center gap-3">
          <a href={ponsTokenUrl(done.token)} target="_blank" rel="noopener noreferrer" className="rounded-xl bg-gray-900 px-5 py-3 text-sm font-semibold text-white transition hover:bg-gray-700 dark:bg-white dark:text-gray-900 dark:hover:bg-gray-200">Trade it on Pons</a>
          {done.agentId && <Link href={`/agents/${done.agentId}`} className="rounded-xl border border-gray-200 px-5 py-3 text-sm font-semibold transition hover:bg-gray-50 dark:border-gray-800 dark:hover:bg-gray-900">See its agent</Link>}
          <Link href={`/launch?token=${done.token.toLowerCase()}`} className="rounded-xl border border-gray-200 px-5 py-3 text-sm font-semibold transition hover:bg-gray-50 dark:border-gray-800 dark:hover:bg-gray-900">See it in the terminal</Link>
        </div>
        <dl className="mt-8 space-y-2 text-left font-mono text-xs">
          {([["Token", done.token], ["Burn pot", done.pot], ["Fee splitter", done.splitter], ["Mind treasury", done.vault]] as const).map(([k, v]) => (
            <div key={k} className="flex items-baseline justify-between gap-4">
              <dt className="shrink-0 text-gray-400">{k}</dt>
              <dd className="min-w-0 truncate text-gray-600 dark:text-gray-300">{v}</dd>
            </div>
          ))}
        </dl>
        <a href={explorerTxUrl(done.txHash)} target="_blank" rel="noopener noreferrer" className="mt-5 inline-block text-xs text-gray-400 underline hover:text-gray-600 dark:hover:text-gray-200">The launch transaction</a>
      </div>
    );
  }

  const working = step !== "idle";
  const you = creatorBps(s);
  const shares = [
    { key: "you", label: "You", bps: you, tone: "bg-gray-900 dark:bg-white" },
    { key: "burn", label: `Burn $${symbol || "TOKEN"}`, bps: s.burnBps, tone: "bg-gray-500 dark:bg-gray-400" },
    { key: "axon", label: "Burn $AXON", bps: s.axonBps, tone: "bg-gray-400 dark:bg-gray-500" },
    { key: "mind", label: "The mind", bps: s.mindBps, tone: "bg-gray-300 dark:bg-gray-700" },
  ];
  const slider = (k: "burnBps" | "axonBps" | "mindBps", text: string, hint: string) => {
    // a share can grow only into what the creator still keeps: the four always add up to everything
    const max = settings[k] + Math.max(0, you);
    return (
      <div>
        <div className="mb-1 flex items-baseline justify-between text-sm">
          <label htmlFor={`share-${k}`} className="font-medium">{text}</label>
          <span className="font-mono tabular-nums">{pct(settings[k])}</span>
        </div>
        <input id={`share-${k}`} type="range" min={0} max={10_000} step={100} value={settings[k]} onChange={(e) => set(k, Math.min(max, Number(e.target.value)))} className="w-full accent-gray-900 dark:accent-white" />
        <p className="mt-1 text-xs text-gray-400">{hint}</p>
      </div>
    );
  };
  const ethField = (k: "maxPerDayEth" | "maxPerActionEth" | "maxCostPerDayEth", text: string) => (
    <div>
      <label htmlFor={`f-${k}`} className={label}>{text}</label>
      <div className="relative">
        <input id={`f-${k}`} inputMode="decimal" value={settings[k]} onChange={(e) => set(k, e.target.value.replace(/[^0-9.]/g, "").slice(0, 12))} className={`${input} pr-14 font-mono`} />
        <span className="pointer-events-none absolute inset-y-0 right-4 flex items-center text-xs text-gray-400">ETH</span>
      </div>
    </div>
  );

  return (
    <div className="grid grid-cols-1 gap-10 lg:grid-cols-[minmax(0,1fr)_380px]">
      {/* ── what is asked for ── */}
      <div className="min-w-0 space-y-8">
        <section className="rounded-2xl border border-gray-200 p-5 sm:p-6 dark:border-gray-800">
          <p className={label}>The token</p>
          <div className="flex gap-4">
            <button type="button" onClick={() => file.current?.click()} aria-label="Add a picture"
              className="group relative h-[104px] w-[104px] shrink-0 overflow-hidden rounded-2xl border border-dashed border-gray-300 bg-gray-50 transition hover:border-gray-900 dark:border-gray-700 dark:bg-gray-900 dark:hover:border-white">
              {picture
                ? <img src={picture.preview} alt="" className="h-full w-full object-cover" />
                : <span className="flex h-full flex-col items-center justify-center gap-1 text-gray-400 group-hover:text-gray-900 dark:group-hover:text-white"><span className="text-2xl leading-none">+</span><span className="text-[11px]">Picture</span></span>}
            </button>
            <input ref={file} type="file" accept="image/png,image/jpeg,image/webp,image/gif" className="hidden" onChange={(e) => { void pick(e.target.files?.[0]); e.target.value = ""; }} />
            <div className="min-w-0 flex-1 space-y-3">
              <input aria-label="Name" value={name} onChange={(e) => setName(e.target.value.slice(0, 32))} placeholder="Name" className={input} />
              <div className="relative">
                <span className="pointer-events-none absolute inset-y-0 left-4 flex items-center text-sm text-gray-400">$</span>
                <input aria-label="Ticker" value={symbol} onChange={(e) => setSymbol(e.target.value.replace(/[^A-Za-z0-9]/g, "").toUpperCase().slice(0, 10))} placeholder="TICKER" spellCheck={false} className={`${input} pl-8 font-mono`} />
              </div>
            </div>
          </div>
        </section>

        <section className="rounded-2xl border border-gray-200 p-5 sm:p-6 dark:border-gray-800">
          <div className="mb-3 flex items-center justify-between gap-3">
            <p className={`${label} mb-0`}>The agent behind it</p>
            {agents.length > 0 && (
              <div className="flex rounded-lg border border-gray-200 p-0.5 text-xs dark:border-gray-800">
                {([[false, "A new agent"], [true, "One of mine"]] as const).map(([v, t]) => (
                  <button key={t} type="button" onClick={() => setOwn(v)} className={`rounded-md px-3 py-1.5 font-medium transition ${own === v ? "bg-gray-900 text-white dark:bg-white dark:text-gray-900" : "text-gray-500 hover:text-gray-900 dark:hover:text-white"}`}>{t}</button>
                ))}
              </div>
            )}
          </div>
          {own && agents.length > 0 ? (
            <>
              <select aria-label="Your agent" value={agentId} onChange={(e) => setAgentId(e.target.value)} className={input}>
                <option value="">Pick one of your agents</option>
                {agents.map((a) => <option key={a.agentId} value={a.agentId}>{a.name}</option>)}
              </select>
              <p className="mt-2 text-xs text-gray-400">What it earns from work counts for the token from the launch on.</p>
            </>
          ) : (
            <>
              <textarea aria-label="What does your agent do?" value={line} onChange={(e) => setLine(e.target.value.replace(/\n/g, " ").slice(0, 180))} rows={2} placeholder="What does your agent do? One line." className={`${input} resize-none`} />
              <div className="mt-2 flex justify-between text-xs text-gray-400">
                <span>Axon makes the agent from this line. People can hire it the moment the token is live.</span>
                <span className="ml-3 shrink-0 font-mono tabular-nums">{line.length}/180</span>
              </div>
            </>
          )}
        </section>

        <section className="rounded-2xl border border-gray-200 p-5 sm:p-6 dark:border-gray-800">
          <p className={label}>Its mind</p>
          <div role="radiogroup" aria-label="The model its mind runs on" className="grid grid-cols-2 gap-2 sm:grid-cols-3">
            {models.map((m) => (
              <button key={m.id} type="button" role="radio" aria-checked={model === m.id} disabled={!m.available} onClick={() => setModel(m.id)}
                className={`rounded-xl border px-3 py-2.5 text-left transition disabled:cursor-not-allowed disabled:opacity-40 ${model === m.id ? "border-gray-900 bg-gray-900 text-white dark:border-white dark:bg-white dark:text-gray-900" : "border-gray-200 hover:border-gray-900 dark:border-gray-800 dark:hover:border-white"}`}>
                <span className="block truncate text-sm font-semibold">{m.label}</span>
                <span className={`block truncate text-[11px] ${model === m.id ? "text-gray-300 dark:text-gray-500" : "text-gray-400"}`}>{m.available ? m.maker : "Not open yet"}</span>
              </button>
            ))}
            <button type="button" role="radio" aria-checked={model === OWN_MIND} disabled={info?.ownOpen === false} onClick={() => setModel(OWN_MIND)}
              className={`rounded-xl border px-3 py-2.5 text-left transition disabled:cursor-not-allowed disabled:opacity-40 ${model === OWN_MIND ? "border-gray-900 bg-gray-900 text-white dark:border-white dark:bg-white dark:text-gray-900" : "border-dashed border-gray-300 hover:border-gray-900 dark:border-gray-700 dark:hover:border-white"}`}>
              <span className="block truncate text-sm font-semibold">Your own</span>
              <span className={`block truncate text-[11px] ${model === OWN_MIND ? "text-gray-300 dark:text-gray-500" : "text-gray-400"}`}>{info?.ownOpen === false ? "Not open yet" : "Your server, any AI"}</span>
            </button>
          </div>
          {model !== OWN_MIND ? (
            <>
              <p className="mt-3 text-xs text-gray-400">The model that thinks for this token. It thinks when something happens, in public, and pays for its own thinking from its treasury at cost. Chosen once.</p>
              {/* nothing is chosen for the creator, so say what a mind with no share means before they sign */}
              {s.mindBps === 0 && <p className="mt-2 text-xs text-gray-500 dark:text-gray-400">The mind&apos;s share of the fees is 0% right now, so its treasury stays empty and it will not think. Give it a share under Advanced if you want it to.</p>}
            </>
          ) : (
            <div className="mt-4 space-y-4">
              <p className="text-xs leading-relaxed text-gray-500 dark:text-gray-400">
                Run the mind on your own server with any AI and your own key. When something happens to your token, Axon sends your server the numbers; it answers with a thought and, if it wants, one proposal, which goes through the same rule check as every mind. Your key stays on your server: Axon never asks for it and never stores one. Its thinking costs your treasury nothing. Chosen once.
              </p>
              <div>
                <label htmlFor="mind-url" className={label}>Your server&apos;s address</label>
                <div className="flex gap-2">
                  <input id="mind-url" value={mindUrl} onChange={(e) => { setMindUrl(e.target.value.trim().slice(0, 300)); setTrial(null); }} placeholder="https://…" spellCheck={false} className={`${input} font-mono`} />
                  <button type="button" onClick={() => void tryServer()} disabled={!apiKey || trial === "running" || !/^https:\/\/\S+\.\S+/.test(mindUrl.trim())}
                    className="shrink-0 rounded-xl border border-gray-200 px-4 text-sm font-semibold transition hover:bg-gray-50 disabled:opacity-40 dark:border-gray-800 dark:hover:bg-gray-900">
                    {trial === "running" ? "Asking…" : "Test it"}
                  </button>
                </div>
                {!apiKey && <p className="mt-2 text-xs text-gray-400">Sign in to test it and to see your signing secret.</p>}
                {trial && trial !== "running" && (trial.ok ? (
                  <div className="mt-3 rounded-xl bg-gray-50 p-3 text-sm dark:bg-gray-900">
                    <p className="font-mono text-[11px] uppercase tracking-[0.15em] text-gray-400">It answered in {(trial.ms / 1000).toFixed(1)}s</p>
                    <p className="mt-1.5 leading-relaxed">{trial.thought}</p>
                    {trial.action && <p className="mt-1.5 font-mono text-[11px] text-gray-500 dark:text-gray-400">proposed: {trial.action.kind} with {trial.action.eth} ETH · {trial.verdict === "approved" ? "would pass the rule check" : `would be refused: ${trial.verdictReason ?? ""}`}</p>}
                  </div>
                ) : (
                  <p role="alert" className="mt-3 text-sm text-red-600 dark:text-red-400">It did not work: {trial.error}</p>
                ))}
              </div>
              {secret && (
                <div>
                  <label htmlFor="mind-secret" className={label}>Your signing secret</label>
                  <input id="mind-secret" readOnly value={secret} onFocus={(e) => e.currentTarget.select()} className={`${input} font-mono text-xs`} />
                  <p className="mt-2 text-xs text-gray-400">Axon signs every request with this so your server can refuse anybody else. Put it on your server; do not share it.</p>
                </div>
              )}
              <details className="rounded-xl border border-gray-200 dark:border-gray-800">
                <summary className="cursor-pointer px-4 py-3 text-sm font-medium">A server you can start from</summary>
                <pre className="max-h-80 overflow-auto border-t border-gray-200 px-4 py-3 font-mono text-[11px] leading-relaxed text-gray-700 dark:border-gray-800 dark:text-gray-300">{OWN_SERVER_EXAMPLE}</pre>
              </details>
            </div>
          )}
        </section>

        <section className="rounded-2xl border border-gray-200 p-5 sm:p-6 dark:border-gray-800">
          <label htmlFor="first-buy" className={label}>Your first buy (optional)</label>
          <div className="relative">
            <input id="first-buy" inputMode="decimal" value={settings.openingBuyEth} onChange={(e) => set("openingBuyEth", e.target.value.replace(/[^0-9.]/g, "").slice(0, 12))} placeholder="0" className={`${input} pr-14 font-mono`} />
            <span className="pointer-events-none absolute inset-y-0 right-4 flex items-center text-xs text-gray-400">ETH</span>
          </div>
          <p className="mt-2 text-xs text-gray-400">Bought in the launch transaction itself, before anybody else can buy. Any amount, or none.</p>
        </section>

        <section className="rounded-2xl border border-gray-200 dark:border-gray-800">
          <button type="button" onClick={() => setAdvanced((v) => !v)} aria-expanded={advanced} className="flex w-full items-center justify-between gap-4 p-5 text-left sm:p-6">
            <span>
              <span className={`${label} mb-1`}>Advanced</span>
              <span className="block text-sm text-gray-500 dark:text-gray-400">{pct(s.taxBps)} tax. {pct(you)} to you, {pct(s.burnBps)} burn, {pct(s.axonBps)} $AXON burn, {pct(s.mindBps)} to the mind.</span>
            </span>
            <span className={`shrink-0 text-gray-400 transition-transform ${advanced ? "rotate-180" : ""}`} aria-hidden>
              <svg width="16" height="16" viewBox="0 0 16 16" fill="none"><path d="M3 6l5 5 5-5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" /></svg>
            </span>
          </button>

          {advanced && (
            <div className="space-y-8 border-t border-gray-200 p-5 sm:p-6 dark:border-gray-800">
              <div>
                <div className="mb-1 flex items-baseline justify-between text-sm">
                  <label htmlFor="tax" className="font-medium">Tax on every trade</label>
                  <span className="font-mono tabular-nums">{pct(s.taxBps)}</span>
                </div>
                <input id="tax" type="range" min={0} max={CEILINGS.taxBps} step={50} value={settings.taxBps} onChange={(e) => set("taxBps", Number(e.target.value))} className="w-full accent-gray-900 dark:accent-white" />
                <p className="mt-1 text-xs text-gray-400">From 0 to 10%. This is what the shares below divide.</p>
              </div>

              <div className="space-y-5">
                <p className="text-sm font-medium">Where the fees go</p>
                <div className="flex h-3 overflow-hidden rounded-full bg-gray-100 dark:bg-gray-900" role="img" aria-label={shares.map((x) => `${x.label} ${pct(x.bps)}`).join(", ")}>
                  {shares.map((x) => x.bps > 0 && <div key={x.key} className={`${x.tone} border-r-2 border-white last:border-r-0 dark:border-[#0a0a0a]`} style={{ width: `${x.bps / 100}%` }} />)}
                </div>
                <div className="grid grid-cols-2 gap-x-4 gap-y-2 text-xs sm:grid-cols-4">
                  {shares.map((x) => (
                    <div key={x.key} className="flex items-center gap-2">
                      <span className={`h-2.5 w-2.5 shrink-0 rounded-sm ${x.tone}`} aria-hidden />
                      <span className="min-w-0 truncate text-gray-500 dark:text-gray-400">{x.label}</span>
                      <span className="ml-auto font-mono tabular-nums">{pct(x.bps)}</span>
                    </div>
                  ))}
                </div>
                {slider("burnBps", `Burn $${symbol || "TOKEN"}`, "Buys the token back and sends it to the dead address: out of circulation for good.")}
                {slider("axonBps", "Burn $AXON", "Optional. Buys $AXON and sends it to the dead address.")}
                {slider("mindBps", "The mind", "Fills the mind's treasury. Its thinking is paid from here.")}
                <p className="text-xs text-gray-400">You keep what is left: <b className="font-mono text-gray-900 dark:text-white">{pct(you)}</b>.</p>
              </div>

              <div>
                <label htmlFor="payout" className={label}>Your payout wallet</label>
                <input id="payout" value={payout} onChange={(e) => setPayout(e.target.value.trim().slice(0, 42))} placeholder={address ?? "0x… (the wallet you sign in with)"} spellCheck={false} className={`${input} font-mono`} />
              </div>

              <div>
                <p className="mb-3 text-sm font-medium">What the mind may do with its treasury</p>
                <div className="space-y-2">
                  {([["canBuyback", `Buy back and burn $${symbol || "TOKEN"}`], ["canReward", "Reward holders"], ["canBurnAxon", "Burn $AXON"]] as const).map(([k, t]) => (
                    <label key={k} className="flex cursor-pointer items-center gap-3 text-sm">
                      <input type="checkbox" checked={settings[k]} onChange={(e) => set(k, e.target.checked)} className="h-4 w-4 accent-gray-900 dark:accent-white" />
                      {t}
                    </label>
                  ))}
                </div>
                <p className="mt-3 text-xs text-gray-400">It can never withdraw. It thinks in public, and a fixed rule check stands between every thought and the chain.</p>
              </div>

              <div className="grid gap-4 sm:grid-cols-2">
                {ethField("maxPerDayEth", "Most it spends a day")}
                {ethField("maxPerActionEth", "Most in one action")}
                <div>
                  <label htmlFor="actions" className={label}>Actions a day</label>
                  <input id="actions" inputMode="numeric" value={settings.maxActionsPerDay} onChange={(e) => set("maxActionsPerDay", Math.min(CEILINGS.actionsPerDay, Number(e.target.value.replace(/\D/g, "")) || 0))} className={`${input} font-mono`} />
                </div>
                {ethField("maxCostPerDayEth", "Most its thinking costs a day")}
              </div>

              <div className="grid gap-4 sm:grid-cols-2">
                <div>
                  <label htmlFor="x-link" className={label}>X link (optional)</label>
                  <input id="x-link" value={settings.twitter} onChange={(e) => set("twitter", e.target.value.trim().slice(0, 120))} placeholder="https://x.com/…" spellCheck={false} className={input} />
                </div>
                <div>
                  <label htmlFor="site-link" className={label}>Website (optional)</label>
                  <input id="site-link" value={settings.website} onChange={(e) => set("website", e.target.value.trim().slice(0, 120))} placeholder="https://…" spellCheck={false} className={input} />
                </div>
              </div>
            </div>
          )}
        </section>
      </div>

      {/* ── what it becomes, and the signature ── */}
      <aside className="min-w-0 lg:sticky lg:top-24 lg:self-start">
        <div className="rounded-2xl border border-gray-200 p-5 sm:p-6 dark:border-gray-800">
          <div className="flex items-center gap-4">
            <div className="h-14 w-14 shrink-0 overflow-hidden rounded-xl bg-gray-100 dark:bg-gray-900">
              {picture && <img src={picture.preview} alt="" className="h-full w-full object-cover" />}
            </div>
            <div className="min-w-0">
              <p className="truncate text-lg font-bold leading-tight">{name.trim() || "Your token"}</p>
              <p className="truncate font-mono text-sm text-gray-400">${symbol || "TICKER"}</p>
            </div>
          </div>

          <p className={`${label} mb-3 mt-6`}>Locked at launch</p>
          <dl className="space-y-2.5 text-sm">
            {summary.map((r) => (
              <div key={r.label} className="flex items-baseline justify-between gap-4">
                <dt className="shrink-0 text-gray-500 dark:text-gray-400">{r.label}</dt>
                <dd className={`min-w-0 text-right ${/%$/.test(r.value) ? "font-mono tabular-nums" : "text-[13px]"} ${r.label === "To Axon" ? "font-semibold" : ""}`}>{r.value}</dd>
              </div>
            ))}
          </dl>

          <div className="mt-6 space-y-1.5 border-t border-gray-200 pt-4 text-sm dark:border-gray-800">
            <div className="flex justify-between"><span className="text-gray-500 dark:text-gray-400">Launch fee (Pons)</span><span className="font-mono tabular-nums">{feeWei !== null ? `${formatEther(feeWei)} ETH` : "…"}</span></div>
            {total !== null && feeWei !== null && total > feeWei && <div className="flex justify-between"><span className="text-gray-500 dark:text-gray-400">Your first buy</span><span className="font-mono tabular-nums">{formatEther(total - feeWei)} ETH</span></div>}
            <div className="flex justify-between font-semibold"><span>You send</span><span className="font-mono tabular-nums">{total !== null ? `${formatEther(total)} ETH` : "…"} <span className="font-normal text-gray-400">+ gas</span></span></div>
          </div>

          <label className="mt-5 flex cursor-pointer items-start gap-3 text-sm">
            <input type="checkbox" checked={agreed} onChange={(e) => setAgreed(e.target.checked)} className="mt-0.5 h-4 w-4 shrink-0 accent-gray-900 dark:accent-white" />
            <span>I understand that none of this can be changed after launch, by me or by anyone.</span>
          </label>

          {!apiKey ? (
            <button type="button" onClick={() => void signIn()} disabled={walletBusy}
              className="mt-5 w-full rounded-xl bg-gray-900 px-4 py-3.5 text-sm font-semibold text-white transition hover:bg-gray-700 disabled:opacity-60 dark:bg-white dark:text-gray-900 dark:hover:bg-gray-200">
              {walletBusy ? "Waiting for your wallet…" : "Sign in with your wallet to launch"}
            </button>
          ) : !info?.launcher ? (
            <p className="mt-5 rounded-xl bg-gray-50 px-4 py-3.5 text-center text-sm text-gray-500 dark:bg-gray-900 dark:text-gray-400">Launching is not open yet.</p>
          ) : (
            <button type="button" onClick={() => void launch()} disabled={working || Boolean(missing) || Boolean(bad) || !agreed}
              className="mt-5 w-full rounded-xl bg-gray-900 px-4 py-3.5 text-sm font-semibold text-white transition hover:bg-gray-700 disabled:opacity-50 dark:bg-white dark:text-gray-900 dark:hover:bg-gray-200">
              {working ? STEP_TEXT[step as keyof typeof STEP_TEXT] : missing ?? bad ?? (agreed ? `Launch $${symbol}` : "Tick the box to launch")}
            </button>
          )}
          {error && <p role="alert" className="mt-3 text-sm text-red-600 dark:text-red-400">{error}</p>}

          <p className="mt-5 text-xs leading-relaxed text-gray-400">
            One transaction, signed by your own wallet. Axon takes nothing from your token: no share of its fees and no launch fee of its own. Tokens can go to zero. Launch and trade at your own risk.
          </p>
        </div>
      </aside>
    </div>
  );
}
