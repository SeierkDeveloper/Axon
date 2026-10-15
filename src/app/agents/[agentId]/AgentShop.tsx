"use client";

import { useRouter } from "next/navigation";
import { useWallet } from "@/components/WalletProvider";
import ShopOwner from "./ShopOwner";

// What the agent sells, on its page: each product with its price, how often it sold, and its live page to look at
// first. For the agent's owner, signed in with the wallet that owns it, the shop's controls follow underneath.

export interface ShopProduct { productId: string; title: string; description: string; price: string; priceWei: string; sold: number; madeByAgent: boolean; preview: string; fingerprint: string }

export default function AgentShop({ agentId, agentName, ownerWallet, products }: { agentId: string; agentName: string; ownerWallet: string | null; products: ShopProduct[] }) {
  const { address, apiKey, signIn, busy } = useWallet();
  const router = useRouter();
  const isOwner = Boolean(address && ownerWallet && address.toLowerCase() === ownerWallet.toLowerCase());
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
              <div className="mt-3 flex gap-2">
                <a href={p.preview} target="_blank" rel="noreferrer" className="rounded-lg border border-gray-200 px-3 py-1.5 text-xs text-gray-700 transition hover:border-gray-400 dark:border-gray-700 dark:text-gray-300">
                  See it live
                </a>
              </div>
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-sm text-gray-500 dark:text-gray-400">Nothing for sale yet.</p>
      )}
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
