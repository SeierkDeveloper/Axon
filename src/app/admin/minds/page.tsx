import { timingSafeEqual } from "crypto";
import type { Metadata } from "next";
import SiteNav from "@/components/SiteNav";
import { overview } from "@/lib/mindsAdmin";
import { agentMindsEnabled } from "@/lib/mindsPolicy";
import { mindLauncherAddress } from "@/lib/mindsChain";
import { thinkingMode } from "@/lib/mindsThinker";
import { dailyBudgetUsd } from "@/lib/mindsMind";
import { publicClient } from "@/lib/evm";
import { HaltAll, StopOne, OnChain } from "./MindsControls";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Minds | Axon Admin", robots: { index: false, follow: false } };

// /admin/minds?key=<CRON_SECRET>: what every mind has cost Axon's keys and what its treasury has paid back, what each
// has sent, what is stopped, and the switches. The public pages show each token's own numbers; the costs are here only.

function allowed(key: string | undefined): boolean {
  const secret = process.env.CRON_SECRET?.trim();
  if (!secret || !key) return false;
  const a = Buffer.from(key), b = Buffer.from(secret);
  return a.length === b.length && timingSafeEqual(a, b);
}

const eth = (v: number) => (v === 0 ? "0" : v >= 0.001 ? v.toFixed(4) : v.toPrecision(2));
const ago = (iso: string | null) => { if (!iso) return "never"; const m = Math.floor((Date.now() - Date.parse(iso)) / 60000); return m < 1 ? "just now" : m < 60 ? `${m}m ago` : m < 2880 ? `${Math.floor(m / 60)}h ago` : `${Math.floor(m / 1440)}d ago`; };
const card = "rounded-lg border border-gray-200 dark:border-gray-800";
const head = "text-sm font-semibold text-gray-900 dark:text-white mb-3 mt-10";
const th = "px-3 py-2 text-left font-mono text-[10px] font-normal uppercase tracking-wider text-gray-400 whitespace-nowrap";
const td = "px-3 py-2 font-mono text-xs tabular-nums whitespace-nowrap";

/** The signer's address and what it holds for gas, read from the chain. Null when no key is set or it cannot be read. */
async function signer(): Promise<{ address: string; eth: number } | null> {
  const key = process.env.MIND_SIGNER_KEY?.trim();
  if (!key) return null;
  try {
    const { privateKeyToAccount } = await import("viem/accounts");
    const address = privateKeyToAccount((key.startsWith("0x") ? key : `0x${key}`) as `0x${string}`).address;
    return { address, eth: Number(await publicClient().getBalance({ address })) / 1e18 };
  } catch {
    return null;
  }
}

export default async function AdminMindsPage({ searchParams }: { searchParams: Promise<{ key?: string }> }) {
  const { key } = await searchParams;
  if (!allowed(key)) {
    return (
      <div className="bg-white dark:bg-[#0a0a0a] min-h-screen">
        <SiteNav />
        <main className="max-w-xl mx-auto px-6 pt-32 text-sm text-gray-500">Not authorized.</main>
      </div>
    );
  }
  const o = overview();
  const who = await signer();
  const launcher = mindLauncherAddress();
  const acting = (process.env.MINDS_ACTING ?? "off").trim().toLowerCase() === "on" && Boolean(who);
  const facts = [
    ["Agent Minds", agentMindsEnabled() ? "on" : "off"],
    ["Thinking", thinkingMode()],
    ["Sending", acting ? "on" : "off"],
    ["Tokens", String(o.tokens)],
    ["Spent on models today", `$${o.spentTodayUsd.toFixed(4)} of $${dailyBudgetUsd()}`],
    ["Thinking, all time", `${eth(o.thinkingEth)} ETH`],
    ["Paid back by treasuries", `${eth(o.paidBackEth)} ETH`],
    ["Still owed", `${eth(o.owedEth)} ETH`],
    ["Signer", who ? `${who.address.slice(0, 8)}… holds ${eth(who.eth)} ETH for gas` : "no key set"],
  ];

  return (
    <div className="bg-white dark:bg-[#0a0a0a] min-h-screen text-gray-900 dark:text-white">
      <SiteNav />
      <main className="mx-auto max-w-6xl px-6 pt-28 pb-24">
        <h1 className="text-2xl font-bold">Minds</h1>
        <p className="mt-2 max-w-2xl text-sm text-gray-500 dark:text-gray-400">What minds cost and paid back, what they sent, and the switches. Nothing here can move a treasury&apos;s ETH.</p>

        {o.halted && <p className="mt-6 rounded-lg bg-red-50 px-4 py-3 text-sm font-semibold text-red-700 dark:bg-red-950/40 dark:text-red-300">Every mind is stopped. None thinks and nothing is sent until you let them go on.</p>}
        {who && who.eth < 0.0001 && <p className="mt-6 rounded-lg bg-amber-50 px-4 py-3 text-sm font-semibold text-amber-800 dark:bg-amber-950/40 dark:text-amber-200">The signer is almost out of gas. Nothing can be sent until it holds some ETH.</p>}

        <dl className={`${card} mt-6 grid grid-cols-2 gap-px overflow-hidden bg-gray-200 sm:grid-cols-3 dark:bg-gray-800`}>
          {facts.map(([k, v]) => (
            <div key={k} className="bg-white px-4 py-3 dark:bg-[#0a0a0a]">
              <dt className="font-mono text-[10px] uppercase tracking-wider text-gray-400">{k}</dt>
              <dd className="mt-1 text-sm font-semibold">{v}</dd>
            </div>
          ))}
        </dl>

        <h2 className={head}>Axon&apos;s own switch</h2>
        <div className={`${card} flex flex-wrap items-center justify-between gap-4 p-4`}>
          <p className="max-w-xl text-sm text-gray-500 dark:text-gray-400">Stops every mind from thinking and anything from being sent, on the next pass. No wallet needed. Treasuries are untouched.</p>
          <HaltAll adminKey={key!} halted={o.halted} />
        </div>

        <h2 className={head}>The chain&apos;s own stops</h2>
        <div className={`${card} p-4`}>
          <p className="mb-3 max-w-2xl text-sm text-gray-500 dark:text-gray-400">These are enforced by the contracts themselves and can only be signed by the guardian&apos;s wallet. Use them if the signer&apos;s key is ever in doubt: a stopped treasury refuses the signer too.</p>
          {launcher ? <OnChain launcher={launcher} /> : <p className="text-sm text-gray-400">No launcher is set.</p>}
        </div>

        <h2 className={head}>Every mind</h2>
        <div className={`${card} overflow-x-auto`}>
          <table className="w-full border-collapse">
            <thead className="border-b border-gray-200 dark:border-gray-800">
              <tr>{["Token", "Mind", "Treasury", "Fees in", "Thoughts", "Last", "Cost $", "Cost ETH", "Paid back", "Owed", "Bought back", "$AXON", "Rewards", "Not sent", ""].map((h) => <th key={h} className={th}>{h}</th>)}</tr>
            </thead>
            <tbody>
              {o.minds.length === 0 && <tr><td colSpan={15} className="px-3 py-6 text-center text-sm text-gray-400">No tokens yet.</td></tr>}
              {o.minds.map((m) => (
                <tr key={m.token} className="border-b border-gray-100 last:border-b-0 dark:border-gray-800/70">
                  <td className={`${td} font-sans`}><a href={`/launch?token=${m.token}`} className="font-semibold underline-offset-2 hover:underline">${m.symbol ?? "?"}</a>{m.attached && <span className="ml-1 text-gray-400">earlier</span>}{m.stoppedAt && <span className="ml-2 rounded bg-red-100 px-1.5 py-0.5 text-[10px] font-semibold text-red-700 dark:bg-red-950 dark:text-red-300">stopped</span>}</td>
                  <td className={`${td} font-sans`}>{m.model}</td>
                  <td className={td}>{eth(m.treasuryEth)}</td>
                  <td className={td}>{eth(m.paidInEth)}</td>
                  <td className={td}>{m.thoughts}{m.failedThoughts ? <span className="text-gray-400"> +{m.failedThoughts} failed</span> : null}</td>
                  <td className={td}>{ago(m.lastThoughtAt)}</td>
                  <td className={td}>{m.thinkingUsd.toFixed(4)}</td>
                  <td className={td}>{eth(m.thinkingEth)}</td>
                  <td className={td}>{eth(m.paidBackEth)}</td>
                  <td className={td}>{eth(m.owedEth)}</td>
                  <td className={td}>{eth(m.boughtBackEth)}</td>
                  <td className={td}>{eth(m.axonBurnedEth)}</td>
                  <td className={td}>{eth(m.rewardedEth)}</td>
                  <td className={td}>{m.notSent}</td>
                  <td className={td}><StopOne adminKey={key!} token={m.token} stopped={Boolean(m.stoppedAt)} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <h2 className={head}>Sent and not confirmed yet</h2>
        <div className={`${card} p-4 text-sm`}>
          {o.open.length === 0 ? <p className="text-gray-400">Nothing is waiting.</p> : (
            <ul className="space-y-1 font-mono text-xs">
              {o.open.map((a) => <li key={a.id}>{a.status} · {a.kind} {eth(a.eth)} ETH · {a.token.slice(0, 10)}… · {ago(a.at)}{a.txHash ? ` · ${a.txHash.slice(0, 12)}…` : ""}</li>)}
            </ul>
          )}
        </div>
      </main>
    </div>
  );
}
