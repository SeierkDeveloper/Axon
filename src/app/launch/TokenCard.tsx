/* eslint-disable @next/next/no-img-element -- token pictures come from wherever their creators put them */
import type { BoardToken } from "@/lib/mindsStats";

/**
 * One token as a large card: its picture across the top, then its name, market cap, agent and how far along its curve
 * it is. Used wherever tokens are laid out side by side on a wide screen: the homepage and the launch page. It holds
 * no state, so a server page and a live list can both draw it; whatever wraps it decides what a click does.
 */

const compact = (n: number) => (n >= 1e9 ? `${(n / 1e9).toFixed(2)}B` : n >= 1e6 ? `${(n / 1e6).toFixed(2)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(1)}K` : n >= 100 ? n.toFixed(0) : n >= 1 ? n.toFixed(2) : n > 0 ? n.toPrecision(2) : "0");
const money = (eth: number | null, usd: number | null) => (eth === null ? "…" : usd ? `$${compact(eth * usd)}` : `${compact(eth)} ETH`);

/** The frame every large card shares, for the link or button that wraps one. */
export const tokenCardFrame = "group flex w-full flex-col rounded-2xl border bg-white p-3 text-left transition dark:bg-gray-950";

export default function TokenCard({ t, usd, age }: { t: BoardToken; usd: number | null; age?: string }) {
  const graduated = t.phase >= 2;
  const along = graduated ? 100 : Math.floor(t.curveBps / 100);
  return (
    <>
      <span className="relative block aspect-square w-full overflow-hidden rounded-xl bg-gray-100 dark:bg-gray-800">
        {t.logo
          ? <img src={t.logo} alt="" loading="lazy" className="h-full w-full object-cover transition duration-300 group-hover:scale-[1.03]" />
          : <span className="grid h-full w-full place-items-center font-mono text-2xl font-semibold text-gray-400">{(t.symbol ?? "?").slice(0, 4)}</span>}
        {graduated && <span className="absolute left-2 top-2 rounded-md bg-gray-900 px-2 py-0.5 font-mono text-[10px] font-semibold uppercase tracking-wider text-white dark:bg-white dark:text-gray-900">Graduated</span>}
      </span>
      <span className="mt-3 flex items-baseline justify-between gap-2 px-1">
        <span className="min-w-0 truncate text-[15px] font-semibold leading-tight">{t.name ?? "Token"}</span>
        <span className="shrink-0 font-mono text-[15px] font-semibold tabular-nums">{money(t.mcapEth, usd)}</span>
      </span>
      <span className="mt-0.5 flex items-baseline justify-between gap-2 px-1 font-mono text-[11px] text-gray-400">
        <span className="min-w-0 truncate">${t.symbol ?? "?"}</span>
        <span className="shrink-0 uppercase tracking-wider">Market cap</span>
      </span>
      <span className="mt-2.5 block truncate px-1 text-xs text-gray-500 dark:text-gray-400">{t.agentName ? <>Agent: <span className="text-gray-900 dark:text-white">{t.agentName}</span></> : "No agent"}</span>
      <span className="mt-2.5 flex items-center gap-2 px-1">
        <span className="h-1.5 flex-1 overflow-hidden rounded-full bg-gray-100 dark:bg-gray-800" role="img" aria-label={graduated ? "Graduated to its pool" : `${along}% of the way along its curve`}>
          <span className="block h-full rounded-full bg-gray-900 dark:bg-white" style={{ width: `${Math.max(2, along)}%` }} />
        </span>
        <span className="w-8 shrink-0 text-right font-mono text-[11px] tabular-nums text-gray-400">{along}%</span>
      </span>
      <span className="mt-2 flex items-baseline justify-between gap-2 px-1 pb-1 font-mono text-[11px] tabular-nums text-gray-400">
        <span>{t.attached ? "" : `${t.holders} ${t.holders === 1 ? "holder" : "holders"}`}</span>
        {age && <span suppressHydrationWarning>{age}</span>}
      </span>
    </>
  );
}
