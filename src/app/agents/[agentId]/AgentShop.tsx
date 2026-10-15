"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { useWallet } from "@/components/WalletProvider";
import { payForBuild } from "@/lib/buildPaymentClient";
import ShopOwner from "./ShopOwner";

// What the agent sells, on its page: each product with its price, how often it sold, and its live page to look at
// first. Buying pays the price in ETH from the visitor's wallet, the way a paid hire does, and the files come at once
// with a receipt. What was bought here can be taken again later: this browser keeps the key each purchase came with,
// and a signed-in wallet finds its own purchases. For the agent's owner, signed in with the wallet that owns it, the
// shop's controls follow underneath.

export interface ShopProduct { productId: string; title: string; description: string; price: string; priceWei: string; sold: number; madeByAgent: boolean; preview: string; fingerprint: string }

interface Owned { saleId: string; productId: string; claimToken?: string }

// What this browser bought, by the key each purchase came with. Wrapped: storage throws in a private window, and the
// purchase is still the buyer's by their wallet.
const KEPT = "axon.purchases";
const readKept = (): Owned[] => {
  try { const v = JSON.parse(localStorage.getItem(KEPT) ?? "[]") as unknown; return Array.isArray(v) ? (v as Owned[]).filter((o) => o && typeof o.saleId === "string") : []; } catch { return []; }
};
const keep = (o: Owned) => {
  try { localStorage.setItem(KEPT, JSON.stringify([o, ...readKept().filter((k) => k.saleId !== o.saleId)].slice(0, 200))); } catch { /* the wallet still finds it */ }
};

const ethOf = (wei: string): string => {
  const w = BigInt(wei), base = 10n ** 18n;
  const frac = (w % base).toString().padStart(18, "0").replace(/0+$/, "");
  return `${w / base}${frac ? `.${frac}` : ""}`;
};

function payError(msg: string, price: string): string {
  if (msg === "WALLET_NOT_FOUND") return "No wallet found in this browser. Install one to pay here.";
  if (msg.startsWith("INSUFFICIENT_FUNDS")) return `Not enough ETH: this costs ${price}, and your wallet has ${msg.split(":")[1] ?? "0"} ETH.`;
  if (msg === "PAYMENT_FAILED") return "The payment did not go through, and nothing was charged. Try again.";
  if (/reject|declin|cancel/i.test(msg)) return "Payment cancelled.";
  return "The payment could not be made. Try again.";
}

const REASONS: [string, string][] = [["scam", "It is a scam"], ["not_delivered", "I paid and got nothing"], ["impersonation", "It pretends to be someone else"], ["harmful", "It is harmful"], ["illegal", "It is illegal"], ["other", "Something else"]];

/** Saying a product should not be sold: it counts against its page, and signed in it also reaches the moderators. */
function Report({ productId, apiKey }: { productId: string; apiKey: string | null }) {
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState("scam");
  const [said, setSaid] = useState<string | null>(null);
  const send = async () => {
    const r = await fetch(`/api/shop/products/${encodeURIComponent(productId)}/report`, { method: "POST", headers: { "content-type": "application/json", ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}) }, body: JSON.stringify({ reason }) }).catch(() => null);
    const j = r ? ((await r.json().catch(() => ({}))) as { error?: string }) : {};
    setSaid(r?.ok ? "Thank you. It was reported." : (j.error ?? "It could not be reported just now."));
    if (r?.ok) setOpen(false);
  };
  if (said && !open) return <p className="mt-2 text-[11px] text-gray-400">{said}</p>;
  if (!open) return <button type="button" onClick={() => setOpen(true)} className="mt-2 self-start text-[11px] text-gray-400 underline hover:text-gray-700 dark:hover:text-gray-200">Report</button>;
  return (
    <div className="mt-2 flex flex-wrap items-center gap-2">
      <select value={reason} onChange={(e) => setReason(e.target.value)} aria-label="Why it should not be sold" className="rounded-md border border-gray-200 bg-transparent px-2 py-1 text-[11px] text-gray-700 dark:border-gray-700 dark:text-gray-300">
        {REASONS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
      </select>
      <button type="button" onClick={() => void send()} className="rounded-md border border-gray-200 px-2 py-1 text-[11px] text-gray-700 dark:border-gray-700 dark:text-gray-300">Send</button>
      <button type="button" onClick={() => setOpen(false)} className="text-[11px] text-gray-400 underline">Cancel</button>
      {said && <span className="text-[11px] text-red-600 dark:text-red-400">{said}</span>}
    </div>
  );
}

function Buy({ p, owned, apiKey, receiver, rpcUrl, onBought, mine }: { p: ShopProduct; owned: Owned | null; apiKey: string | null; receiver: string; rpcUrl: string; onBought: (o: Owned) => void; mine: boolean }) {
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  // a payment that was sent but not yet turned into a sale: sent again, never paid twice
  const paid = useRef<{ paymentSignature: string; payerWallet: string } | null>(null);
  const [hasPaid, setHasPaid] = useState(false);

  const download = async (o: Owned) => {
    setError(null);
    const headers: Record<string, string> = o.claimToken ? { "x-claim-token": o.claimToken } : apiKey ? { authorization: `Bearer ${apiKey}` } : {};
    const r = await fetch(`/api/shop/sales/${encodeURIComponent(o.saleId)}/zip`, { headers }).catch(() => null);
    if (!r?.ok) { setError("The files could not be opened. Sign in with the wallet that paid, and try again."); return; }
    const url = URL.createObjectURL(await r.blob());
    const a = document.createElement("a");
    a.href = url;
    a.download = /filename="([^"]+)"/.exec(r.headers.get("content-disposition") ?? "")?.[1] ?? "files.zip";
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 10_000);
  };

  const buy = async () => {
    if (busy || !receiver) return;
    setError(null);
    try {
      if (!paid.current) {
        setBusy("Confirm the payment in your wallet…");
        const { signature, payer } = await payForBuild({ rpcUrl, treasury: receiver, ethAmount: ethOf(p.priceWei) });
        paid.current = { paymentSignature: signature, payerWallet: payer };
        setHasPaid(true);
      }
      setBusy("Payment sent, getting your files…");
      const r = await fetch(`/api/shop/products/${encodeURIComponent(p.productId)}/buy`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ ...paid.current, quotedWei: p.priceWei }) });
      const j = (await r.json().catch(() => ({}))) as { saleId?: string; claimToken?: string; error?: string; code?: string };
      if (r.ok && j.saleId) {
        paid.current = null;
        setHasPaid(false);
        const o = { saleId: j.saleId, productId: p.productId, ...(j.claimToken ? { claimToken: j.claimToken } : {}) };
        if (j.claimToken) keep(o);
        onBought(o);
        if (j.claimToken) await download(o);
        return;
      }
      // a payment the chain has not shown yet can be sent again; any other answer closes this payment
      if (j.code !== "PAYMENT_UNAVAILABLE") { paid.current = null; setHasPaid(false); }
      setError(j.error ?? "It could not be bought. Try again.");
    } catch (e) {
      setError(payError(e instanceof Error ? e.message : "", p.price));
    } finally {
      setBusy(null);
    }
  };

  if (owned) {
    return (
      <div className="mt-3">
        <div className="flex flex-wrap items-center gap-2">
          <button type="button" onClick={() => void download(owned)} className="rounded-lg bg-gray-900 px-3 py-1.5 text-xs font-medium text-white transition hover:opacity-90 dark:bg-white dark:text-gray-900">Download the files</button>
          <a href={`/r/${encodeURIComponent(owned.saleId)}`} className="text-xs text-gray-500 underline hover:text-gray-900 dark:hover:text-white">Receipt</a>
          <span className="text-[11px] text-gray-400">You have this</span>
        </div>
        {error && <p className="mt-1.5 text-xs text-red-600 dark:text-red-400">{error}</p>}
      </div>
    );
  }
  return (
    <div className="mt-3">
      <div className="flex gap-2">
        <a href={p.preview} target="_blank" rel="noreferrer" className="rounded-lg border border-gray-200 px-3 py-1.5 text-xs text-gray-700 transition hover:border-gray-400 dark:border-gray-700 dark:text-gray-300">See it live</a>
        {receiver && !mine && (
          <button type="button" onClick={() => void buy()} disabled={busy !== null} className="rounded-lg bg-gray-900 px-3 py-1.5 text-xs font-medium text-white transition hover:opacity-90 disabled:opacity-50 dark:bg-white dark:text-gray-900">
            {hasPaid ? "Get my files" : `Buy for ${p.price}`}
          </button>
        )}
      </div>
      {busy && <p className="mt-1.5 text-xs text-gray-500">{busy}</p>}
      {error && <p className="mt-1.5 text-xs text-red-600 dark:text-red-400">{error}</p>}
    </div>
  );
}

export default function AgentShop({ agentId, agentName, ownerWallet, products, receiver, rpcUrl }: { agentId: string; agentName: string; ownerWallet: string | null; products: ShopProduct[]; receiver: string; rpcUrl: string }) {
  const { address, apiKey, signIn, busy } = useWallet();
  const router = useRouter();
  const [owned, setOwned] = useState<Owned[]>([]);
  const isOwner = Boolean(address && ownerWallet && address.toLowerCase() === ownerWallet.toLowerCase());

  // what this browser kept, and what the signed-in wallet bought
  const fetchMine = useCallback(async (): Promise<Owned[]> => {
    const kept = readKept();
    if (!apiKey) return kept;
    const r = await fetch("/api/shop/purchases", { headers: { authorization: `Bearer ${apiKey}` } }).catch(() => null);
    const j = r?.ok ? ((await r.json()) as { purchases?: { saleId: string; status: string; product: { productId: string } }[] }) : null;
    const signed = (j?.purchases ?? []).filter((s) => s.status === "delivered").map((s) => ({ saleId: s.saleId, productId: s.product.productId }));
    return [...kept, ...signed.filter((s) => !kept.some((k) => k.saleId === s.saleId))];
  }, [apiKey]);
  useEffect(() => {
    let alive = true;
    fetchMine().then((o) => { if (alive) setOwned(o); }).catch(() => {});
    return () => { alive = false; };
  }, [fetchMine]);

  if (!products.length && !isOwner) return null;
  return (
    <section id="shop" className="mb-10">
      <p className="mb-3 text-xs font-semibold uppercase tracking-wider text-gray-400 dark:text-gray-500">For sale</p>
      {products.length > 0 ? (
        <ul className="grid gap-3 sm:grid-cols-2">
          {products.map((p) => (
            <li key={p.productId} id={`product-${p.productId}`} className="flex flex-col rounded-xl border border-gray-200 p-4 dark:border-gray-800">
              <div className="flex items-baseline justify-between gap-3">
                <p className="min-w-0 truncate text-sm font-semibold text-gray-900 dark:text-white">{p.title}</p>
                <span className="shrink-0 font-mono text-sm text-gray-900 dark:text-white">{p.price}</span>
              </div>
              <p className="mt-1 flex-1 text-xs text-gray-500 dark:text-gray-400">{p.description}</p>
              <p className="mt-2 font-mono text-[11px] text-gray-400">
                {p.sold} sold{p.madeByAgent ? ` · made by ${agentName} on its own` : ""}
              </p>
              <Buy p={p} owned={owned.find((o) => o.productId === p.productId) ?? null} apiKey={apiKey} receiver={receiver} rpcUrl={rpcUrl} mine={isOwner} onBought={(o) => { setOwned((had) => [o, ...had]); router.refresh(); }} />
              {!isOwner && <Report productId={p.productId} apiKey={apiKey} />}
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-sm text-gray-500 dark:text-gray-400">Nothing for sale yet.</p>
      )}
      {products.length > 0 && <p className="mt-2 text-[11px] text-gray-400">You get the page&apos;s files to keep and host anywhere, with a receipt that carries their fingerprint.</p>}
      {isOwner && (apiKey
        ? <ShopOwner agentId={agentId} apiKey={apiKey} onChanged={() => router.refresh()} />
        : (
          <button type="button" onClick={() => void signIn()} disabled={busy} className="mt-4 rounded-lg border border-gray-200 px-3 py-1.5 text-xs text-gray-700 disabled:opacity-50 dark:border-gray-700 dark:text-gray-300">
            Sign in to manage your shop
          </button>
        ))}
    </section>
  );
}
