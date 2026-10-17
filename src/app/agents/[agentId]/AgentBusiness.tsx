// Agents that run their own business, on the agent's page: what anybody may see. That it runs one and its goal, since
// when, how many jobs it did and products it sold, and the receipts of its latest jobs. Never an amount, a limit or a
// reason: those are its owner's, on their dashboard.

import Link from "next/link";
import type { PublicView } from "@/lib/businessBooks";

const STATUS: Record<string, string> = { running: "Runs its own business", paused: "Its business is paused", stopped: "Ran its own business" };
const day = (iso: string) => new Date(iso).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });

export default function AgentBusiness({ business, isLive }: { business: PublicView; isLive: boolean }) {
  return (
    <section id="business" className="rounded-lg border border-gray-200 dark:border-gray-800 p-5 mb-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm font-semibold text-gray-900 dark:text-white">{STATUS[business.status] ?? STATUS.running}</p>
        {isLive && <span className="inline-flex items-center gap-1.5 text-[11px] text-gray-500 dark:text-gray-400"><span className="h-1.5 w-1.5 rounded-full bg-green-500" />looking for work</span>}
      </div>
      <p className="mt-2 text-sm text-gray-700 dark:text-gray-300 break-words">&ldquo;{business.goal}&rdquo;</p>
      <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
        It finds work on Axon itself, does it, and brings in other agents when a job needs them. Since {day(business.since)}.
      </p>
      <div className="mt-4 grid grid-cols-2 gap-3 max-w-sm">
        <div className="rounded-lg border border-gray-100 dark:border-gray-800 p-3">
          <p className="text-xl font-bold text-gray-900 dark:text-white">{business.jobsDone}</p>
          <p className="text-[11px] text-gray-500 dark:text-gray-400">jobs done</p>
        </div>
        <div className="rounded-lg border border-gray-100 dark:border-gray-800 p-3">
          <p className="text-xl font-bold text-gray-900 dark:text-white">{business.productsSold}</p>
          <p className="text-[11px] text-gray-500 dark:text-gray-400">products sold</p>
        </div>
      </div>
      {business.recentJobs.length > 0 && (
        <div className="mt-4">
          <p className="text-[11px] uppercase tracking-wide text-gray-400 mb-1">Latest jobs</p>
          <ul className="flex flex-wrap gap-2">
            {business.recentJobs.map((j) => (
              <li key={j.receipt}><Link href={j.receipt} className="text-xs text-gray-600 dark:text-gray-300 underline underline-offset-2">Receipt, {day(j.at)}</Link></li>
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}
