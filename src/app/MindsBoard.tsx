/* eslint-disable @next/next/no-img-element -- token pictures come from wherever their creators put them */
import Link from "next/link";
import FadeIn from "@/components/FadeIn";
import { agentMindsEnabled } from "@/lib/mindsPolicy";
import { board, boardTotals, type BoardToken } from "@/lib/mindsStats";
import { ethUsd } from "@/lib/ethPrice";

/**
 * "Launched on Axon", on the homepage: the newest tokens launched here, each with the agent behind it. Behind the
 * Agent Minds switch, and never allowed to take the homepage down with it: anything that goes wrong here shows nothing.
 */

const compact = (n: number) => (n >= 1e9 ? `${(n / 1e9).toFixed(2)}B` : n >= 1e6 ? `${(n / 1e6).toFixed(2)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(1)}K` : n >= 100 ? n.toFixed(0) : n >= 1 ? n.toFixed(2) : n > 0 ? n.toPrecision(2) : "0");
const money = (eth: number | null, usd: number | null) => (eth === null ? "…" : usd ? `$${compact(eth * usd)}` : `${compact(eth)} ETH`);

function Card({ t, usd }: { t: BoardToken; usd: number | null }) {
  return (
    <Link href={`/launch?token=${t.token}`} className="group flex flex-col rounded-2xl border border-gray-200 bg-white p-5 transition hover:border-gray-900 dark:border-gray-800 dark:bg-gray-950 dark:hover:border-white">
      <div className="flex items-center gap-3">
        {t.logo
          ? <img src={t.logo} alt="" width={44} height={44} loading="lazy" className="h-11 w-11 shrink-0 rounded-xl bg-gray-100 object-cover dark:bg-gray-800" />
          : <span className="grid h-11 w-11 shrink-0 place-items-center rounded-xl bg-gray-100 font-mono text-xs font-semibold text-gray-500 dark:bg-gray-800 dark:text-gray-400">{(t.symbol ?? "?").slice(0, 3)}</span>}
        <div className="min-w-0">
          <p className="truncate font-semibold leading-tight">{t.name ?? "Token"}</p>
          <p className="truncate font-mono text-xs text-gray-400">${t.symbol ?? "?"}</p>
        </div>
        <p className="ml-auto shrink-0 font-mono text-sm font-semibold tabular-nums">{money(t.mcapEth, usd)}</p>
      </div>
      <p className="mt-4 truncate text-sm text-gray-500 dark:text-gray-400">{t.agentName ? <>Agent: <span className="text-gray-900 dark:text-white">{t.agentName}</span></> : "No agent"}</p>
      <div className="mt-4 flex items-center gap-3">
        {t.phase >= 2 ? (
          <span className="rounded-md bg-gray-900 px-2 py-0.5 font-mono text-[10px] font-semibold uppercase tracking-wider text-white dark:bg-white dark:text-gray-900">Graduated</span>
        ) : (
          <span className="h-1.5 flex-1 overflow-hidden rounded-full bg-gray-100 dark:bg-gray-800" role="img" aria-label={`${Math.floor(t.curveBps / 100)}% of the way along its curve`}>
            <span className="block h-full rounded-full bg-gray-900 dark:bg-white" style={{ width: `${Math.max(2, t.curveBps / 100)}%` }} />
          </span>
        )}
        <span className="ml-auto shrink-0 font-mono text-[11px] tabular-nums text-gray-400">{t.attached ? "" : `${t.holders} ${t.holders === 1 ? "holder" : "holders"}`}</span>
      </div>
    </Link>
  );
}

export default async function MindsBoard() {
  if (!agentMindsEnabled()) return null;
  let tokens: BoardToken[], total: number, usd: number | null;
  try {
    tokens = board("new", 6);
    total = boardTotals().tokens;
    usd = await ethUsd();
  } catch {
    return null;
  }
  return (
    <section className="px-6 pb-16">
      <FadeIn>
        <div className="mx-auto max-w-5xl">
          <div className="mb-6 flex flex-wrap items-end justify-between gap-4">
            <div>
              <p className="mb-2 font-mono text-xs uppercase tracking-[0.25em] text-gray-400">Launched on Axon</p>
              <h2 className="text-2xl font-bold tracking-tight sm:text-3xl">Tokens with an agent and a mind behind them.</h2>
            </div>
            <div className="flex gap-3">
              {total > 0 && <Link href="/launch" className="rounded-xl border border-gray-200 px-4 py-2.5 text-sm font-semibold transition hover:bg-gray-50 dark:border-gray-800 dark:hover:bg-gray-900">See all {total}</Link>}
              <Link href="/launch?new=1" className="rounded-xl bg-gray-900 px-4 py-2.5 text-sm font-semibold text-white transition hover:bg-gray-700 dark:bg-white dark:text-gray-900 dark:hover:bg-gray-200">Launch a token</Link>
            </div>
          </div>
          {tokens.length ? (
            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
              {tokens.map((t) => <Card key={t.token} t={t} usd={usd} />)}
            </div>
          ) : (
            <div className="rounded-2xl border border-dashed border-gray-300 px-6 py-12 text-center dark:border-gray-700">
              <p className="font-semibold">Nothing has launched here yet.</p>
              <p className="mx-auto mt-2 max-w-md text-sm text-gray-500 dark:text-gray-400">One transaction launches a token with an agent that works for it and a mind with its own treasury. The first one shows here.</p>
            </div>
          )}
        </div>
      </FadeIn>
    </section>
  );
}
