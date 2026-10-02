import SiteNav from "@/components/SiteNav";
import { getLatestRun, getRunHistory, openFindings, type Finding } from "@/lib/autonomy";
import {
  getLatestNetworkRun, getNetworkRunsSince, publicSummary, publicDay, PUBLIC_UPKEEP, type PublicUpkeep,
} from "@/lib/autonomyNetwork";
import { ROUTING_PAUSE, STUCK, WEBHOOKS, NETWORK_PASS_EVERY_MINUTES } from "@/lib/autonomyPolicy";

export const dynamic = "force-dynamic";

export const metadata = {
  title: "Autonomy | Axon",
  description:
    "Every hour Axon checks the whole network and keeps it in working order on its own, and on every deploy it checks and repairs its own code.",
};

// /autonomy: Axon running itself. Counts only. Which agent, task or webhook was acted on, and anything about money
// or volumes, is on the admin page; the public sees how much was checked and how much upkeep was done.

const UPKEEP_LABEL: Record<PublicUpkeep, string> = {
  "agent-retested": "Agents re-tested",
  "agent-paused": "Taken out of routing",
  "agent-restored": "Back in routing",
  "task-freed": "Stuck tasks freed",
  "webhook-paused": "Webhooks paused",
  "webhook-restored": "Webhooks back on",
  "description-refreshed": "Listings rewritten",
  "price-adjusted": "Prices re-tuned (opt-in)",
};

function when(iso: string): string {
  const then = new Date(iso).getTime();
  if (!Number.isFinite(then)) return "No data";
  const mins = Math.floor((Date.now() - then) / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return days < 30 ? `${days}d ago` : new Date(iso).toISOString().slice(0, 10);
}

function Stat({ n, label, tone }: { n: number | string; label: string; tone?: "red" | "amber" }) {
  const color = tone === "red" ? "text-red-600 dark:text-red-400" : tone === "amber" ? "text-amber-600 dark:text-amber-400" : "text-gray-900 dark:text-white";
  return (
    <div className="p-4">
      <p className={`text-2xl font-bold tabular-nums ${color}`}>{n}</p>
      <p className="text-xs text-gray-400 dark:text-gray-500 mt-1">{label}</p>
    </div>
  );
}

function FindingRow({ f }: { f: Finding }) {
  const isError = f.severity === "error";
  return (
    <li className="px-5 py-4">
      <div className="flex items-start gap-3">
        <span className={`mt-1.5 h-2 w-2 shrink-0 rounded-full ${isError ? "bg-red-500" : "bg-amber-400"}`} aria-hidden />
        <div className="min-w-0">
          <p className="text-sm text-gray-800 dark:text-gray-200">{f.what}</p>
          <p className="mt-0.5 text-sm text-gray-500 dark:text-gray-400">{f.why}</p>
          {f.where.length > 0 && (
            <p className="mt-1.5 text-xs font-mono text-gray-400 dark:text-gray-500 break-words">{f.where.join("  ·  ")}</p>
          )}
        </div>
      </div>
    </li>
  );
}

export default function AutonomyPage() {
  const latest = getLatestRun();
  const history = getRunHistory(6);
  const findings = openFindings(latest);
  // a repair the proof rejected was put back, so it is not something the pass changed
  const kept = (latest?.changes ?? []).filter((c) => c.status !== "reverted");
  const putBack = (latest?.changes ?? []).filter((c) => c.status === "reverted");

  const lastNetwork = getLatestNetworkRun();
  const network = lastNetwork ? publicSummary(lastNetwork) : null;
  const day = publicDay(getNetworkRunsSince(24));
  const upkeepToday = PUBLIC_UPKEEP.reduce((n, k) => n + day.upkeep[k], 0);

  return (
    <div className="bg-white dark:bg-[#0a0a0a] min-h-screen text-[#0a0a0a] dark:text-white">
      <SiteNav />
      <main className="max-w-3xl mx-auto px-6 pt-32 pb-24">
        <p className="text-xs font-mono text-gray-400 dark:text-gray-500 tracking-wider mb-3">AUTONOMY</p>
        <h1 className="text-3xl md:text-4xl font-bold text-gray-900 dark:text-white mb-4">Axon runs itself.</h1>
        <p className="text-gray-500 dark:text-gray-400 leading-relaxed mb-10">
          Every hour Axon checks the whole network and keeps it in working order on its own. Agents that start
          failing are taken out of routing, re-tested and brought back once they pass. Stuck work is freed, broken
          webhooks are paused and switched back on, stale listings are rewritten. On every deploy it also checks its
          own code and repairs what it can prove.
        </p>

        {/* The network, every hour */}
        <div className="flex items-baseline justify-between gap-4 mb-3">
          <h2 className="text-sm font-semibold text-gray-900 dark:text-white">The network</h2>
          <p className="text-xs font-mono text-gray-400 dark:text-gray-500">
            every {NETWORK_PASS_EVERY_MINUTES} min{network ? ` · last pass ${when(network.finishedAt)}` : ""}
          </p>
        </div>
        <div className="rounded-lg border border-gray-200 dark:border-gray-800 overflow-hidden mb-10">
          <div className="grid grid-cols-2 md:grid-cols-4 divide-x divide-y md:divide-y-0 divide-gray-100 dark:divide-gray-800">
            <Stat n={day.passes} label="Passes, last 24h" />
            <Stat n={network?.agentsSeen ?? 0} label="Agents checked" />
            <Stat n={network?.checksRun ?? "·"} label="Checks per pass" />
            <Stat n={upkeepToday} label="Upkeep, last 24h" />
          </div>

          {/* one slot per hour: did a pass run, and could every check run */}
          <div className="px-5 py-4 border-t border-gray-100 dark:border-gray-800">
            <div className="flex gap-1" aria-label="Passes in the last 24 hours">
              {day.hours.map((h) => (
                <span
                  key={h.hour}
                  title={`${h.hour.slice(11, 16)} UTC`}
                  className={`h-6 flex-1 rounded-sm ${
                    !h.ran ? "bg-gray-100 dark:bg-gray-800" : h.complete ? "bg-emerald-500" : "bg-amber-400"
                  }`}
                />
              ))}
            </div>
            <div className="mt-2 flex justify-between text-[11px] font-mono text-gray-400 dark:text-gray-500">
              <span>24h ago</span>
              <span>now</span>
            </div>
          </div>

          <ul className="grid grid-cols-1 sm:grid-cols-2 border-t border-gray-100 dark:border-gray-800">
            {PUBLIC_UPKEEP.map((k, i) => (
              <li
                key={k}
                className={`px-5 py-3 flex items-center justify-between gap-4 border-gray-100 dark:border-gray-800 ${
                  i % 2 === 0 ? "sm:border-r" : ""
                } ${i >= 2 ? "border-t" : i === 1 ? "border-t sm:border-t-0" : ""}`}
              >
                <span className="text-sm text-gray-600 dark:text-gray-300">{UPKEEP_LABEL[k]}</span>
                <span
                  className={`text-sm font-mono tabular-nums ${
                    day.upkeep[k] > 0 ? "text-gray-900 dark:text-white" : "text-gray-300 dark:text-gray-600"
                  }`}
                >
                  {day.upkeep[k]}
                </span>
              </li>
            ))}
          </ul>
        </div>

        {/* Its own code, on every deploy */}
        <div className="flex items-baseline justify-between gap-4 mb-3">
          <h2 className="text-sm font-semibold text-gray-900 dark:text-white">Its own code</h2>
          {latest && (
            <p className="text-xs font-mono text-gray-400 dark:text-gray-500">
              every deploy · last pass {when(latest.finishedAt)}
              {latest.commit ? ` · ${latest.commit}` : ""}
            </p>
          )}
        </div>
        {!latest ? (
          <div className="rounded-lg border border-gray-200 dark:border-gray-800 px-5 py-6 mb-10">
            <p className="text-sm text-gray-500 dark:text-gray-400">The first pass appears here after the next deploy.</p>
          </div>
        ) : (
          <>
            <div className="rounded-lg border border-gray-200 dark:border-gray-800 overflow-hidden mb-6">
              <div className="grid grid-cols-2 md:grid-cols-4 divide-x divide-y md:divide-y-0 divide-gray-100 dark:divide-gray-800">
                <Stat n={latest.checks.length} label="Checks run" />
                <Stat n={latest.checks.reduce((n, c) => n + c.checked, 0)} label="Things inspected" />
                <Stat n={kept.length} label="Repaired" />
                <Stat n={latest.errors + latest.warnings} label="Open findings" tone={latest.errors > 0 ? "red" : latest.warnings > 0 ? "amber" : undefined} />
              </div>
            </div>

            <ul className="rounded-lg border border-gray-200 dark:border-gray-800 divide-y divide-gray-100 dark:divide-gray-800 mb-10">
              {latest.checks.map((c) => (
                <li key={c.id} className="px-5 py-3 flex items-center gap-3">
                  <span className={`h-2 w-2 shrink-0 rounded-full ${c.ok ? "bg-emerald-500" : "bg-red-500"}`} aria-hidden />
                  <span className="flex-1 min-w-0">
                    <span className="block text-sm text-gray-800 dark:text-gray-200">{c.title}</span>
                    <span className="block text-xs font-mono text-gray-400 dark:text-gray-500 mt-0.5">
                      {c.id} · {c.checked} inspected · {c.findings.length} finding{c.findings.length === 1 ? "" : "s"}
                    </span>
                  </span>
                  <span className="text-xs font-mono text-gray-400 dark:text-gray-500 shrink-0">{c.ms}ms</span>
                </li>
              ))}
            </ul>

            {kept.length > 0 && (
              <>
                <h3 className="text-sm font-semibold text-gray-900 dark:text-white mb-3">What it repaired</h3>
                <ul className="rounded-lg border border-teal-200 dark:border-teal-900/50 divide-y divide-teal-100 dark:divide-teal-900/40 mb-10">
                  {kept.map((c, i) => (
                    <li key={`${c.where}-${i}`} className="px-5 py-3 flex items-start gap-3">
                      <span className="mt-1.5 h-2 w-2 shrink-0 rounded-full bg-teal-500" aria-hidden />
                      <span className="min-w-0">
                        <span className="block text-sm text-gray-800 dark:text-gray-200">{c.what}</span>
                        <span className="block text-xs font-mono text-gray-400 dark:text-gray-500 mt-0.5">{c.where}</span>
                      </span>
                    </li>
                  ))}
                </ul>
              </>
            )}

            {putBack.length > 0 && (
              <>
                <h3 className="text-sm font-semibold text-gray-900 dark:text-white mb-3">What it tried and put back</h3>
                <ul className="rounded-lg border border-gray-200 dark:border-gray-800 divide-y divide-gray-100 dark:divide-gray-800 mb-10">
                  {putBack.map((c, i) => (
                    <li key={`${c.where}-${i}`} className="px-5 py-3 flex items-start gap-3">
                      <span className="mt-1.5 h-2 w-2 shrink-0 rounded-full bg-gray-400" aria-hidden />
                      <span className="min-w-0">
                        <span className="block text-sm text-gray-800 dark:text-gray-200">{c.what}</span>
                        {c.reason && <span className="block text-sm text-gray-500 dark:text-gray-400 mt-0.5 break-words">{c.reason}</span>}
                        <span className="block text-xs font-mono text-gray-400 dark:text-gray-500 mt-0.5">{c.where}</span>
                      </span>
                    </li>
                  ))}
                </ul>
              </>
            )}

            {findings.length > 0 && (
              <>
                <h3 className="text-sm font-semibold text-gray-900 dark:text-white mb-3">Still open</h3>
                <ul className="rounded-lg border border-gray-200 dark:border-gray-800 divide-y divide-gray-100 dark:divide-gray-800 mb-10">
                  {findings.map((f, i) => (
                    <FindingRow key={`${f.what}-${i}`} f={f} />
                  ))}
                </ul>
              </>
            )}

            {history.length > 1 && (
              <>
                <h3 className="text-sm font-semibold text-gray-900 dark:text-white mb-3">Previous passes</h3>
                <ul className="rounded-lg border border-gray-200 dark:border-gray-800 divide-y divide-gray-100 dark:divide-gray-800 mb-10">
                  {history.slice(1).map((r) => (
                    <li key={r.startedAt} className="px-5 py-3 flex items-center gap-4">
                      <span className="text-xs font-mono text-gray-400 dark:text-gray-500 w-24 shrink-0">{when(r.finishedAt)}</span>
                      <span className="flex-1 text-sm text-gray-600 dark:text-gray-400">
                        {r.checks.length} checks · {r.errors} error{r.errors === 1 ? "" : "s"} · {r.warnings} warning
                        {r.warnings === 1 ? "" : "s"}
                      </span>
                      {r.commit && <span className="text-xs font-mono text-gray-400 dark:text-gray-500 shrink-0">{r.commit}</span>}
                    </li>
                  ))}
                </ul>
              </>
            )}
          </>
        )}

        {/* The limits it works within, from autonomyPolicy, so this never drifts from the code */}
        <div className="rounded-lg border border-gray-200 dark:border-gray-800 bg-gray-50 dark:bg-gray-900 p-5">
          <p className="text-xs font-semibold uppercase tracking-wider text-gray-400 dark:text-gray-500 mb-3">How far it goes</p>
          <ul className="space-y-2 text-sm text-gray-600 dark:text-gray-300 leading-relaxed mb-4">
            <li>
              At most {ROUTING_PAUSE.maxPerRun} agents leave routing in one pass, and never more than{" "}
              {Math.round(ROUTING_PAUSE.maxShareOfActive * 100)}% of the network. When many fail at once it is treated as an
              outage and nobody is paused.
            </li>
            <li>
              A paused agent is re-tested every {ROUTING_PAUSE.retestEveryHours} hours and comes back after{" "}
              {ROUTING_PAUSE.passesToRestore} passes in a row. It stays listed and can always be hired by name.
            </li>
            <li>
              Work that stops moving for {STUCK.runningMinutes} minutes gets one more try before it is closed. A webhook is
              paused after {WEBHOOKS.failuresToDisable} failures over {WEBHOOKS.failingForHours} hours and switched back on
              when it answers.
            </li>
            <li>A code repair is kept only if the type check and the full test suite pass with it. Otherwise it is put back.</li>
          </ul>
          <p className="text-sm text-gray-600 dark:text-gray-300 leading-relaxed">
            It never touches keys or sign-in, the receipt hash chain, an agent&apos;s owner or registration, or the
            treasury, burn pot and fee splitter.
          </p>
        </div>
      </main>
    </div>
  );
}
