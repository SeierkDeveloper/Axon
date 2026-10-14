import { timingSafeEqual } from "crypto";
import type { Metadata } from "next";
import SiteNav from "@/components/SiteNav";
import { autonomy3State, recentJobs } from "@/lib/autonomy3";
import "@/lib/autonomy3Parts";
import { latestReport } from "@/lib/autonomy3Upkeep";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Autonomy 3 | Axon Admin", robots: { index: false, follow: false } };

// /admin/autonomy3?key=<CRON_SECRET>: Autonomy 3 in full. Every part with its switch, how many of the day's jobs it
// has started, what today cost, and the latest jobs with what they found. Nothing of this is public.

function allowed(key: string | undefined): boolean {
  const secret = process.env.CRON_SECRET?.trim();
  if (!secret || !key) return false;
  const a = Buffer.from(key), b = Buffer.from(secret);
  return a.length === b.length && timingSafeEqual(a, b);
}

function ago(iso: string | null): string {
  if (!iso) return "never";
  const mins = Math.floor((Date.now() - Date.parse(iso)) / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const h = Math.floor(mins / 60);
  return h < 48 ? `${h}h ago` : `${Math.floor(h / 24)}d ago`;
}

const usd = (n: number): string => `$${n.toFixed(n < 1 ? 3 : 2)}`;
const aDay = (n: number): string => (n >= 1 ? `${n} a day` : `1 every ${Math.round(1 / n)} days`);

const card = "rounded-lg border border-gray-200 dark:border-gray-800";
const head = "text-sm font-semibold text-gray-900 dark:text-white mb-3 mt-10";

export default async function AdminAutonomy3Page({ searchParams }: { searchParams: Promise<{ key?: string }> }) {
  const { key } = await searchParams;
  if (!allowed(key)) {
    return (
      <div className="bg-white dark:bg-[#0a0a0a] min-h-screen">
        <SiteNav />
        <main className="max-w-xl mx-auto px-6 pt-32 text-sm text-gray-500">Not authorized.</main>
      </div>
    );
  }

  const s = autonomy3State();
  const lastWatch = recentJobs(1, "watch")[0];
  const report = latestReport();
  const watched = ((lastWatch?.detail ?? {}) as { found?: { kind: string; subject?: string; what: string }[] }).found ?? [];
  const onCount = s.parts.filter((p) => p.on).length;

  return (
    <div className="bg-white dark:bg-[#0a0a0a] min-h-screen text-[#0a0a0a] dark:text-white">
      <SiteNav />
      <main className="max-w-5xl mx-auto px-6 pt-32 pb-24">
        <p className="text-xs font-mono text-gray-400 tracking-wider mb-3">ADMIN · AUTONOMY 3</p>
        <h1 className="text-3xl font-bold mb-2">The work the network gives itself</h1>
        <p className="text-sm text-gray-500 dark:text-gray-400">
          Autonomy 3 is <b className={s.on ? "text-emerald-600" : "text-red-600"}>{s.on ? "on" : "off (AUTONOMY3 is not on)"}</b>.
          {` ${onCount} of ${s.parts.length} parts switched on. Today's jobs cost about ${usd(s.spentTodayUsd)}; with every part on a day costs at most about ${usd(s.worstDayUsd)}.`}
        </p>

        {report && (
          <>
            <h2 className={head}>The daily report, {ago(report.at)}</h2>
            <div className={`${card} px-5 py-4 text-sm`}>
              <p className="whitespace-pre-line text-gray-800 dark:text-gray-200">{report.text}</p>
              <p className="mt-2 text-xs text-gray-500">Written by <span className="font-mono">{report.by}</span>, hired by the network · <a className="underline" href={report.receipt}>receipt</a></p>
            </div>
          </>
        )}

        <h2 className={head}>The parts</h2>
        <ul className={`${card} divide-y divide-gray-100 dark:divide-gray-800`}>
          {s.parts.map((p) => (
            <li key={p.part} className="px-5 py-3 text-sm flex flex-wrap items-baseline gap-x-4 gap-y-1">
              <span className={`w-10 shrink-0 font-mono text-xs ${p.on ? "text-emerald-600" : "text-gray-400"}`}>{p.on ? "on" : "off"}</span>
              <span className="min-w-0 flex-1">
                <b>{p.name}</b>
                <span className="block text-xs text-gray-500 mt-0.5">{p.does}</span>
              </span>
              <span className="shrink-0 text-right font-mono text-xs text-gray-500">
                {!p.built ? "not built yet" : p.aDay === null ? `${p.started} today, no fixed number` : `${p.started} of ${p.dueByNow} due by now, ${aDay(p.aDay)}`}
                <span className="block mt-0.5 text-gray-400">{p.switch} · last job {ago(p.lastJobAt)}</span>
              </span>
            </li>
          ))}
        </ul>

        <h2 className={head}>What the watch found last{lastWatch ? `, ${ago(lastWatch.startedAt)}` : ""}</h2>
        {!lastWatch ? (
          <p className={`${card} px-5 py-4 text-sm text-gray-500`}>The watch has not looked yet.</p>
        ) : watched.length === 0 ? (
          <p className={`${card} px-5 py-4 text-sm text-gray-500`}>{lastWatch.summary}</p>
        ) : (
          <ul className={`${card} divide-y divide-gray-100 dark:divide-gray-800`}>
            {watched.map((f, i) => (
              <li key={`${f.kind}-${f.subject ?? i}`} className="px-5 py-2.5 text-sm">
                <span className="font-mono text-xs text-gray-500 mr-3">{f.kind}</span>
                {f.subject && <span className="font-mono text-xs text-gray-500 mr-3">{f.subject}</span>}
                <span className="text-gray-800 dark:text-gray-200">{f.what}</span>
              </li>
            ))}
          </ul>
        )}

        <h2 className={head}>Latest jobs</h2>
        {s.jobs.length === 0 ? (
          <p className={`${card} px-5 py-4 text-sm text-gray-500`}>No job yet.</p>
        ) : (
          <ul className={`${card} divide-y divide-gray-100 dark:divide-gray-800`}>
            {s.jobs.map((j) => (
              <li key={j.id} className="px-5 py-2.5 text-sm">
                <span className="font-mono text-xs text-gray-500 mr-3">{j.part}</span>
                {j.subject && <span className="font-mono text-xs text-gray-500 mr-3">{j.subject}</span>}
                <span className="text-gray-800 dark:text-gray-200">{j.summary ?? (j.finishedAt ? j.outcome : "running")}</span>
                <span className="block text-xs text-gray-500 mt-0.5">
                  {j.finishedAt ? `${j.outcome} · ` : ""}started {ago(j.startedAt)}{j.costUsd > 0 ? ` · about ${usd(j.costUsd)}` : ""}
                </span>
              </li>
            ))}
          </ul>
        )}
      </main>
    </div>
  );
}
