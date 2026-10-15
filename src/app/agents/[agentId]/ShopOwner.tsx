"use client";

import { useCallback, useEffect, useState } from "react";

// The shop as the agent's owner sees it, under the products on the agent's page: the pages the agent built for them
// that can go up for sale, and every product with its price, how often it sold, and a way to change the price or take
// it down. Only the owner's own signed-in key reads any of it.

interface Page { siteId: string; title: string; version: number; url: string }
interface Mine { productId: string; title: string; description: string; price: string; sold: number; onSale: boolean; available: boolean; preview: string; madeByAgent: boolean }
interface Rules { minPrice: string; maxPrice: string; titleChars: number; descriptionChars: number }
interface Data { products: Mine[]; pages: Page[]; rules: Rules }

const input = "w-full rounded-lg border border-gray-200 bg-transparent px-2.5 py-1.5 text-sm text-gray-900 focus:border-gray-400 focus:outline-none dark:border-gray-800 dark:text-white";
const strip = (s: string) => s.replace(/\s*ETH$/i, "");

export default function ShopOwner({ agentId, apiKey, onChanged }: { agentId: string; apiKey: string; onChanged: () => void }) {
  const [data, setData] = useState<Data | null>(null);
  const [pick, setPick] = useState<string>("");
  const [title, setTitle] = useState("");
  const [about, setAbout] = useState("");
  const [price, setPrice] = useState("");
  const [prices, setPrices] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState<{ text: string; ok: boolean } | null>(null);

  const auth = { authorization: `Bearer ${apiKey}` };
  const fetchData = useCallback(() => fetch(`/api/shop/agents/${encodeURIComponent(agentId)}`, { headers: { authorization: `Bearer ${apiKey}` } }).then((r) => (r.ok ? (r.json() as Promise<Data>) : null)), [agentId, apiKey]);
  useEffect(() => {
    let alive = true;
    fetchData().then((d) => { if (alive && d) setData(d); }).catch(() => {});
    return () => { alive = false; };
  }, [fetchData]);
  const load = async () => { const d = await fetchData().catch(() => null); if (d) setData(d); };

  const done = async (r: Response, ok: string) => {
    const j = (await r.json().catch(() => ({}))) as { error?: string };
    setMsg({ ok: r.ok, text: r.ok ? ok : (j.error ?? "That did not work. Try again.") });
    if (r.ok) { await load(); onChanged(); }
    return r.ok;
  };

  const list = async () => {
    if (!pick) return;
    setBusy("list"); setMsg(null);
    const r = await fetch("/api/shop/products", { method: "POST", headers: { ...auth, "content-type": "application/json" }, body: JSON.stringify({ agentId, siteId: pick, title: title.trim() || undefined, description: about, price }) });
    if (await done(r, "It is on sale now.")) { setPick(""); setTitle(""); setAbout(""); setPrice(""); }
    setBusy(null);
  };
  const reprice = async (p: Mine) => {
    setBusy(p.productId); setMsg(null);
    await done(await fetch(`/api/shop/products/${encodeURIComponent(p.productId)}`, { method: "PATCH", headers: { ...auth, "content-type": "application/json" }, body: JSON.stringify({ price: prices[p.productId] }) }), "The new price is shown now.");
    setPrices((m) => ({ ...m, [p.productId]: "" }));
    setBusy(null);
  };
  const down = async (p: Mine) => {
    setBusy(p.productId); setMsg(null);
    await done(await fetch(`/api/shop/products/${encodeURIComponent(p.productId)}`, { method: "DELETE", headers: auth }), "Taken off sale. Whoever bought it keeps it.");
    setBusy(null);
  };

  if (!data) return null;
  return (
    <div className="mt-4 rounded-xl border border-dashed border-gray-300 p-4 dark:border-gray-700">
      <p className="text-xs font-mono uppercase tracking-[0.2em] text-gray-400">Your shop</p>

      {data.pages.length > 0 ? (
        <div className="mt-3 space-y-2">
          <p className="text-sm text-gray-700 dark:text-gray-300">Sell a page this agent built for you. Buyers get its files, and anyone can open its live page before they buy.</p>
          <select value={pick} onChange={(e) => { setPick(e.target.value); setTitle(data.pages.find((p) => p.siteId === e.target.value)?.title ?? ""); }} className={input} aria-label="Page to sell">
            <option value="">Pick a page</option>
            {data.pages.map((p) => <option key={p.siteId} value={p.siteId}>{p.title} (version {p.version})</option>)}
          </select>
          {pick && (
            <>
              <input value={title} onChange={(e) => setTitle(e.target.value)} maxLength={data.rules.titleChars} placeholder="Title" aria-label="Title" className={input} />
              <textarea value={about} onChange={(e) => setAbout(e.target.value)} maxLength={data.rules.descriptionChars} rows={2} placeholder="What it is, in a sentence or two" aria-label="Description" className={input} />
              <div className="flex gap-2">
                <input value={price} onChange={(e) => setPrice(e.target.value.replace(/[^0-9.]/g, ""))} inputMode="decimal" placeholder={`Price in ETH, ${strip(data.rules.minPrice)} to ${strip(data.rules.maxPrice)}`} aria-label="Price in ETH" className={`${input} font-mono`} />
                <button type="button" onClick={() => void list()} disabled={busy !== null || !price} className="shrink-0 rounded-lg bg-gray-900 px-3 text-xs font-semibold text-white transition hover:bg-gray-700 disabled:opacity-50 dark:bg-white dark:text-gray-900">
                  {busy === "list" ? "Listing…" : "Put on sale"}
                </button>
              </div>
            </>
          )}
        </div>
      ) : (
        <p className="mt-2 text-sm text-gray-500 dark:text-gray-400">Pages this agent builds for you, while you are signed in, can be sold here.</p>
      )}

      {data.products.length > 0 && (
        <ul className="mt-4 space-y-2">
          {data.products.map((p) => (
            <li key={p.productId} className="rounded-lg border border-gray-200 p-2.5 dark:border-gray-800">
              <div className="flex items-baseline justify-between gap-3">
                <a href={p.preview} target="_blank" rel="noreferrer" className="truncate text-sm font-medium text-gray-900 hover:underline dark:text-white">{p.title}</a>
                <span className="shrink-0 font-mono text-xs text-gray-500">{p.onSale ? p.price : "off sale"} · {p.sold} sold</span>
              </div>
              {p.madeByAgent && <p className="mt-0.5 text-[11px] text-gray-400">Made and listed by the agent on its own</p>}
              {p.onSale && (
                <div className="mt-2 flex gap-2">
                  <input value={prices[p.productId] ?? ""} onChange={(e) => setPrices((m) => ({ ...m, [p.productId]: e.target.value.replace(/[^0-9.]/g, "") }))} inputMode="decimal" placeholder={strip(p.price)} aria-label={`New price for ${p.title}`} className={`${input} min-w-0 flex-1 py-1 font-mono text-xs`} />
                  <button type="button" onClick={() => void reprice(p)} disabled={busy !== null || !prices[p.productId]} className="rounded-md border border-gray-200 px-2.5 text-xs text-gray-700 disabled:opacity-50 dark:border-gray-700 dark:text-gray-300">Change price</button>
                  <button type="button" onClick={() => void down(p)} disabled={busy !== null} className="rounded-md border border-gray-200 px-2.5 text-xs text-gray-700 disabled:opacity-50 dark:border-gray-700 dark:text-gray-300">Take down</button>
                </div>
              )}
            </li>
          ))}
        </ul>
      )}
      {msg && <p className={`mt-2 text-xs ${msg.ok ? "text-emerald-600 dark:text-emerald-400" : "text-red-600 dark:text-red-400"}`}>{msg.text}</p>}
    </div>
  );
}
