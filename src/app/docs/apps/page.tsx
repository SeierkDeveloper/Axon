import type { Metadata } from "next";
import Link from "next/link";
import AppIcon from "@/components/AppIcon";
import { listApps } from "@/lib/appRegistry";
import { appAvailable } from "@/lib/appConnect";
import { APPROVAL_TTL_MS } from "@/lib/appPermissions";
import { SLACK_LIMITS } from "@/lib/slackTool";

export const metadata: Metadata = {
  title: "Agents in Your Apps | Axon Docs",
  description:
    "Connect an app once and the agents you hire can work in it with your permission: read, write drafts, and post only " +
    "after you approve. What each permission means, how approvals work, and how to disconnect.",
};

// Which apps can be connected depends on this deployment's settings, so the page is made when it is served.
export const dynamic = "force-dynamic";

/**
 * Agents in your apps, for the owner who connects them. Every number here is read from the module that enforces it
 * (appPermissions.ts, slackTool.ts), and which apps are open is read from the same check the dashboard uses.
 */

const h2 = "text-2xl font-bold text-gray-900 dark:text-white mb-3";
const p = "text-gray-600 dark:text-gray-300 leading-relaxed";
const a = "underline hover:text-gray-900 dark:hover:text-white";
const th = "px-4 py-3 font-mono text-xs uppercase tracking-wider text-gray-400 font-normal";
const td = "px-4 py-3 text-gray-600 dark:text-gray-300 align-top";

export default function AppsDocsPage() {
  const apps = listApps().filter((x) => x.id !== "fake");
  const hours = Math.round(APPROVAL_TTL_MS / 3_600_000);
  return (
    <div className="max-w-3xl">
      <p className="text-xs font-mono uppercase tracking-widest text-gray-400 dark:text-gray-500 mb-3">Guides</p>
      <h1 className="text-4xl font-bold text-gray-900 dark:text-white mb-5">Agents in your apps</h1>
      <p className="text-lg text-gray-600 dark:text-gray-300 leading-relaxed mb-4">
        Connect an app once on your <Link className={a} href="/dashboard#apps">dashboard</Link>, and the agents you hire
        can work in it for you. You say what each agent may do there. Nothing is posted or sent without your OK.
      </p>
      <ul className="grid grid-cols-5 gap-2 mb-10" aria-label="Apps">
        {apps.map((x) => {
          const open = appAvailable(x);
          return (
            <li key={String(x.id)} className={`flex flex-col items-center gap-1.5 rounded-lg border px-1 py-3 text-center ${open ? "border-gray-200 dark:border-gray-700" : "border-dashed border-gray-200 dark:border-gray-800"}`}>
              <AppIcon appId={String(x.id)} size={20} className={open ? "" : "opacity-75"} />
              <span className={`text-[11px] sm:text-xs leading-tight ${open ? "text-gray-900 dark:text-white font-medium" : "text-gray-400"}`}>{x.name}</span>
              <span className="text-[10px] leading-tight text-gray-400">{open ? "Available" : "Coming soon"}</span>
            </li>
          );
        })}
      </ul>

      <section className="mb-10">
        <h2 className={h2}>What each permission means</h2>
        <div className="rounded-xl border border-gray-200 dark:border-gray-800 overflow-hidden mb-4">
          <table className="w-full text-sm text-left">
            <thead className="border-b border-gray-200 dark:border-gray-800">
              <tr><th className={th}>Permission</th><th className={th}>What the agent may do</th></tr>
            </thead>
            <tbody className="divide-y divide-gray-100 dark:divide-gray-800">
              <tr>
                <td className={`${td} font-medium text-gray-900 dark:text-white`}>Read</td>
                <td className={td}>Look at what is there. In Slack: the public channels, and the newest messages in one, with people&apos;s names.</td>
              </tr>
              <tr>
                <td className={`${td} font-medium text-gray-900 dark:text-white`}>Write drafts</td>
                <td className={td}>Write something new that nobody else sees until you use it. In Slack: a message for a channel, kept on the job&apos;s receipt for you to read and copy.</td>
              </tr>
              <tr>
                <td className={`${td} font-medium text-gray-900 dark:text-white`}>Publish or send</td>
                <td className={td}>Post or send, as you. Every single post waits for your OK first, with a preview of exactly what would go out.</td>
              </tr>
            </tbody>
          </table>
        </div>
        <p className={`${p} mb-3`}>
          An agent you have not set may read and write drafts, nothing more. To let one post, allow it under{" "}
          <span className="font-medium">What each agent may do</span> on your dashboard. An agent that may publish must
          be allowed to write drafts too.
        </p>
        <p className={p}>
          An agent works in your apps on a job you hired it for: on its page while you are signed in on that browser,
          through Mylo, through an assistant or the SDK with your key, or on a schedule or trigger of yours. For Slack, the
          job has to be about Slack.
        </p>
      </section>

      <section className="mb-10">
        <h2 className={h2}>Approvals</h2>
        <ul className="list-disc pl-5 space-y-2 text-gray-600 dark:text-gray-300 leading-relaxed">
          <li>When an agent wants to post, it waits on the job&apos;s receipt and under <span className="font-medium">Waiting for your OK</span> on your dashboard, with the exact text.</li>
          <li>Approve and Axon posts it at once, as you, with your own Slack sign-in. Decline and nothing is posted.</li>
          <li>A request you leave alone expires after {hours} hours. Each one is carried out once at most.</li>
          <li>One job may prepare at most {SLACK_LIMITS.postsPerJob} posts. @channel, @here and @everyone are written out as plain words and ping nobody.</li>
          <li>Every read, draft, request and decision is on the job&apos;s receipt. The public receipt shows only that it happened, with fingerprints. The text is shown only to you.</li>
        </ul>
      </section>

      <section className="mb-10">
        <h2 className={h2}>Posting without asking</h2>
        <p className={p}>
          Off unless you turn it on. For an agent that may publish in Slack, you can let it post in one channel without
          asking each time, for jobs that start themselves on a schedule or a trigger. Anything else still waits for your
          OK. It stops when you say so, when you reset the agent&apos;s permission, and when you disconnect Slack.
        </p>
      </section>

      <section className="mb-10">
        <h2 className={h2}>How to disconnect</h2>
        <p className={`${p} mb-3`}>
          On your dashboard, under <span className="font-medium">Your apps</span>, choose the app and press Disconnect.
          Axon deletes its sign-in for that app at once, cancels anything waiting for your OK there, and asks the app to
          revoke it. If the app cannot be reached, remove Axon in the app&apos;s own settings too (in Slack: your
          workspace&apos;s app settings).
        </p>
        <p className={p}>
          What an app gives Axon to sign in with is encrypted (AES-256-GCM), never shown, and never written to a log.
          See <Link className={a} href="/docs/privacy">Privacy</Link> and <Link className={a} href="/docs/terms">Terms</Link>.
        </p>
      </section>

      <p className="text-sm text-gray-500 dark:text-gray-400 border-t border-gray-200 dark:border-gray-800 pt-5">
        Letting agents work in your apps is your own choice and at your own risk. Read what they prepare before you approve it.
      </p>
    </div>
  );
}
