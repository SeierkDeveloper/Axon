"use client";

import { useCallback, useEffect, useState } from "react";

// The shop as the agent's owner sees it, under the products on the agent's page: the pages the agent built for them
// that can go up for sale, every product with its price, how often it sold, and a way to change the price or take it
// down, and whether the agent makes and lists products on its own. Only the owner's own signed-in key reads any of it.

interface Page { siteId: string; title: string; version: number; url: string }
interface Mine { productId: string; title: string; description: string; price: string; sold: number; onSale: boolean; available: boolean; preview: string; madeByAgent: boolean }
interface Rules { minPrice: string; maxPrice: string; titleChars: number; descriptionChars: number; kindChars: number; makeEveryHours: { min: number; max: number }; makePerDayMax: number }
interface Run { runId: string; at: string; status: string; productId: string | null; error: string | null }
interface Make { can: boolean; on: boolean; kind: string | null; price: string | null; everyHours: number; perDay: number; nextAt: string | null; runs: Run[] }
interface Data { products: Mine[]; pages: Page[]; settings: { make: Make }; rules: Rules }

const EVERY = [4, 6, 12, 24, 48, 72, 168];
const everyText = (h: number) => (h % 24 === 0 ? (h === 24 ? "every day" : h === 168 ? "every week" : `every ${h / 24} days`) : `every ${h} hours`);

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
  // making products on its own: what is typed, before it is saved
  const [make, setMake] = useState<{ kind: string; price: string; everyHours: number; perDay: number } | null>(null);

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

  const saveMaking = async (on: boolean) => {
    if (!data) return;
    const m = make ?? { kind: data.settings.make.kind ?? "", price: strip(data.settings.make.price ?? ""), everyHours: data.settings.make.everyHours, perDay: data.settings.make.perDay };
    setBusy("make"); setMsg(null);
    const ok = await done(await fetch(`/api/shop/agents/${encodeURIComponent(agentId)}`, { method: "PUT", headers: { ...auth, "content-type": "application/json" }, body: JSON.stringify({ make: { on, ...m } }) }), on ? "Saved. It makes its first one shortly." : "It no longer makes products on its own.");
    if (ok) setMake(null);
    setBusy(null);
  };

  if (!data) return null;
  const m = data.settings.make;
  const form = make ?? { kind: m.kind ?? "", price: strip(m.price ?? ""), everyHours: m.everyHours, perDay: m.perDay };
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
      {m.can && (
        <div className="mt-4 border-t border-gray-200 pt-3 dark:border-gray-800">
          <p className="text-sm font-medium text-gray-900 dark:text-white">Let it make products on its own</p>
          <p className="mt-0.5 text-xs text-gray-500 dark:text-gray-400">
            {m.on ? `On: ${everyText(m.everyHours)}, at most ${m.perDay} a day, listed at ${m.price}.` : "It builds something new of the kind you say, on a schedule, and puts it up for sale at your price. Each one is marked as made by the agent on its own."}
          </p>
          <div className="mt-2 space-y-2">
            <textarea value={form.kind} onChange={(e) => setMake({ ...form, kind: e.target.value })} maxLength={data.rules.kindChars} rows={2} placeholder="What kind of products, for example: small calculators for freelancers" aria-label="What kind of products" className={input} />
            <div className="flex flex-wrap gap-2">
              <input value={form.price} onChange={(e) => setMake({ ...form, price: e.target.value.replace(/[^0-9.]/g, "") })} inputMode="decimal" placeholder="Price in ETH" aria-label="Price in ETH for each product" className={`${input} w-32 font-mono`} />
              <select value={form.everyHours} onChange={(e) => setMake({ ...form, everyHours: Number(e.target.value) })} aria-label="How often" className={`${input} w-auto`}>
                {EVERY.filter((h) => h >= data.rules.makeEveryHours.min && h <= data.rules.makeEveryHours.max).map((h) => <option key={h} value={h}>{everyText(h)}</option>)}
              </select>
              <select value={form.perDay} onChange={(e) => setMake({ ...form, perDay: Number(e.target.value) })} aria-label="At most a day" className={`${input} w-auto`}>
                {Array.from({ length: data.rules.makePerDayMax }, (_, i) => i + 1).map((k) => <option key={k} value={k}>at most {k} a day</option>)}
              </select>
            </div>
            <div className="flex gap-2">
              <button type="button" onClick={() => void saveMaking(true)} disabled={busy !== null || form.kind.trim().length < 10 || !form.price} className="rounded-lg bg-gray-900 px-3 py-1.5 text-xs font-semibold text-white disabled:opacity-50 dark:bg-white dark:text-gray-900">{m.on ? "Save" : "Switch on"}</button>
              {m.on && <button type="button" onClick={() => void saveMaking(false)} disabled={busy !== null} className="rounded-lg border border-gray-200 px-3 py-1.5 text-xs text-gray-700 disabled:opacity-50 dark:border-gray-700 dark:text-gray-300">Switch off</button>}
            </div>
          </div>
          {m.runs.length > 0 && (
            <ul className="mt-2 space-y-0.5">
              {m.runs.slice(0, 5).map((r) => (
                <li key={r.runId} className="font-mono text-[11px] text-gray-400">
                  {new Date(r.at).toLocaleString(undefined, { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" })} · {r.status === "listed" ? "made and listed" : r.status === "running" ? "making it now" : r.status === "failed" ? `nothing listed${r.error ? `: ${r.error}` : ""}` : r.status}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
      {msg && <p className={`mt-2 text-xs ${msg.ok ? "text-emerald-600 dark:text-emerald-400" : "text-red-600 dark:text-red-400"}`}>{msg.text}</p>}
    </div>
  );
}
