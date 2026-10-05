"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { encodeFunctionData, parseAbi } from "viem";
import { useWallet } from "@/components/WalletProvider";
import { CHAIN_ID_HEX, CHAIN_PARAMS, provider, readableWalletError } from "@/lib/chain";

// The admin's buttons. The first kind are Axon's own switches: they need no wallet and take effect on the next pass.
// The second kind are the chain's: only the guardian's wallet can sign them, and the page only builds the call.

const GUARD = parseAbi(["function setMindsPaused(bool paused)", "function setLaunchesPaused(bool paused)", "function setFrozen(bool frozen)"]);
const btn = "rounded-lg border border-gray-300 px-3 py-1.5 text-xs font-semibold transition hover:bg-gray-50 disabled:opacity-50 dark:border-gray-700 dark:hover:bg-gray-900";

function useAdmin(adminKey: string) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const call = async (body: Record<string, unknown>) => {
    setBusy(true); setNote(null);
    const r = await fetch("/api/admin/minds", { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${adminKey}` }, body: JSON.stringify(body) }).catch(() => null);
    const d = r ? ((await r.json().catch(() => ({}))) as { error?: string }) : { error: "No answer." };
    setBusy(false);
    if (!r?.ok) { setNote(d.error ?? "It did not work."); return; }
    router.refresh();
  };
  return { busy, note, call };
}

export function HaltAll({ adminKey, halted }: { adminKey: string; halted: boolean }) {
  const { busy, note, call } = useAdmin(adminKey);
  return (
    <span className="inline-flex items-center gap-3">
      <button type="button" disabled={busy} onClick={() => { if (halted || window.confirm("Stop every mind? None will think and nothing will be sent until you let them go on.")) void call({ action: halted ? "resume" : "halt" }); }}
        className={halted ? btn : "rounded-lg bg-red-600 px-3 py-1.5 text-xs font-semibold text-white transition hover:bg-red-700 disabled:opacity-50"}>
        {halted ? "Let every mind go on" : "Stop every mind"}
      </button>
      {note && <span role="alert" className="text-xs text-red-600">{note}</span>}
    </span>
  );
}

export function StopOne({ adminKey, token, stopped }: { adminKey: string; token: string; stopped: boolean }) {
  const { busy, note, call } = useAdmin(adminKey);
  return (
    <span className="inline-flex items-center gap-2">
      <button type="button" disabled={busy} onClick={() => void call({ action: stopped ? "start" : "stop", token })} className={btn}>{stopped ? "Let it go on" : "Stop"}</button>
      {note && <span role="alert" className="text-xs text-red-600">{note}</span>}
    </span>
  );
}

/** The chain's own stops. They only work signed by the guardian's wallet; any other wallet is refused by the contract. */
export function OnChain({ launcher }: { launcher: string }) {
  const { address, connect, busy } = useWallet();
  const [vault, setVault] = useState("");
  const [note, setNote] = useState<string | null>(null);
  const send = async (to: string, data: `0x${string}`, what: string) => {
    const p = provider();
    if (!p || !address) return;
    setNote(null);
    try {
      const chain = (await p.request({ method: "eth_chainId" })) as string;
      if (chain?.toLowerCase() !== CHAIN_ID_HEX) {
        try { await p.request({ method: "wallet_switchEthereumChain", params: [{ chainId: CHAIN_ID_HEX }] }); }
        catch (e) { if ((e as { code?: number }).code === 4902) await p.request({ method: "wallet_addEthereumChain", params: [CHAIN_PARAMS] }); else throw e; }
      }
      const hash = (await p.request({ method: "eth_sendTransaction", params: [{ from: address, to, data }] })) as string;
      setNote(`${what}: sent (${hash.slice(0, 10)}…). It holds once the transaction lands.`);
    } catch (e) {
      setNote(readableWalletError(e));
    }
  };
  const flag = (fn: "setMindsPaused" | "setLaunchesPaused", on: boolean) => encodeFunctionData({ abi: GUARD, functionName: fn, args: [on] });
  if (!address) return <button type="button" onClick={() => void connect()} disabled={busy} className={btn}>Connect the guardian&apos;s wallet</button>;
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap gap-2">
        <button type="button" className={btn} onClick={() => void send(launcher, flag("setMindsPaused", true), "Stop all minds")}>Stop all minds on chain</button>
        <button type="button" className={btn} onClick={() => void send(launcher, flag("setMindsPaused", false), "Let minds go on")}>Let them go on</button>
        <button type="button" className={btn} onClick={() => void send(launcher, flag("setLaunchesPaused", true), "Pause launches")}>Pause new launches</button>
        <button type="button" className={btn} onClick={() => void send(launcher, flag("setLaunchesPaused", false), "Open launches")}>Open launches</button>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <input aria-label="A mind's treasury address" value={vault} onChange={(e) => setVault(e.target.value.trim().slice(0, 42))} placeholder="0x… a mind's treasury" spellCheck={false} className="w-80 max-w-full rounded-lg border border-gray-300 bg-transparent px-3 py-1.5 font-mono text-xs dark:border-gray-700" />
        <button type="button" className={btn} disabled={!/^0x[0-9a-fA-F]{40}$/.test(vault)} onClick={() => void send(vault, encodeFunctionData({ abi: GUARD, functionName: "setFrozen", args: [true] }), "Freeze")}>Freeze this one</button>
        <button type="button" className={btn} disabled={!/^0x[0-9a-fA-F]{40}$/.test(vault)} onClick={() => void send(vault, encodeFunctionData({ abi: GUARD, functionName: "setFrozen", args: [false] }), "Unfreeze")}>Unfreeze it</button>
      </div>
      {note && <p role="status" className="text-xs text-gray-600 dark:text-gray-300">{note}</p>}
    </div>
  );
}
