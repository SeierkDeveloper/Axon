"use client";
// Your apps, on the dashboard: connect an app once (GitHub, Notion, Slack, Google Docs, Gmail) and say what each agent
// you hire may do in it. An app Axon has no client for yet shows "Coming soon".
//
// It shows nothing at all until the server says apps are on, so the dashboard is unchanged while they are off.
// Everything goes through /api/apps with the owner's key; no answer from it ever carries a token.

import { useCallback, useEffect, useState } from "react";

type Action = "read" | "draft" | "publish";
interface AppView {
  appId: string;
  name: string;
  blurb: string;
  available: boolean;
  actions: { action: Action; label: string }[];
  asks: string[];
  connection: { connectionId: string; accountLabel: string | null; scopes: string[]; needsReconnect: boolean; createdAt: string; lastUsedAt: string | null } | null;
}
interface Permission { agentId: string; agentName: string | null; appId: string; actions: Action[]; updatedAt: string }
interface AgentLite { agentId: string; name: string }

const input =
  "w-full rounded border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-950 px-2 py-1.5 text-sm text-gray-900 dark:text-gray-100 outline-none focus:border-gray-400 dark:focus:border-gray-500";
const button =
  "text-xs px-3 py-1.5 rounded-lg border border-gray-200 dark:border-gray-700 text-gray-600 dark:text-gray-300 hover:border-gray-400 dark:hover:border-gray-500 hover:text-gray-900 dark:hover:text-white transition-colors disabled:opacity-40 disabled:cursor-not-allowed";
const danger =
  "text-xs px-3 py-1.5 rounded-lg border border-red-200 dark:border-red-900 text-red-600 dark:text-red-400 hover:border-red-400 transition-colors disabled:opacity-40";
const label = "block text-[11px] uppercase tracking-wide text-gray-400 mb-1";
const chip = (tone: "on" | "off" | "warn") =>
  `text-[11px] px-2 py-0.5 rounded-full border whitespace-nowrap ${
    tone === "on"
      ? "border-green-200 dark:border-green-900 bg-green-50 dark:bg-green-950/30 text-green-700 dark:text-green-400"
      : tone === "warn"
        ? "border-amber-200 dark:border-amber-900 bg-amber-50 dark:bg-amber-950/30 text-amber-800 dark:text-amber-400"
        : "border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-800/60 text-gray-500 dark:text-gray-400"
  }`;
const MONOGRAM: Record<string, string> = { github: "GH", notion: "N", slack: "S", gdocs: "D", gmail: "M" };
const ACTION_WORD: Record<Action, string> = { read: "Read", draft: "Write drafts", publish: "Publish or send" };
const BACK: Record<string, { type: "success" | "error"; text: (app: string) => string }> = {
  connected: { type: "success", text: (a) => `${a} is connected` },
  declined: { type: "error", text: (a) => `${a} was not connected: you said no on its page` },
  expired: { type: "error", text: () => "That sign-in ran out. Start it again here." },
  browser: { type: "error", text: () => "That sign-in was started in another browser. Start it again here." },
  soon: { type: "error", text: (a) => `${a} is coming soon` },
  failed: { type: "error", text: (a) => `${a} could not be connected. Try again.` },
};
const when = (iso: string) => new Date(iso).toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" });

export default function AppsPanel({ apiKey, onToast }: { apiKey: string; onToast: (type: "success" | "error", message: string) => void }) {
  const [on, setOn] = useState<boolean | null>(null);
  const [apps, setApps] = useState<AppView[]>([]);
  const [permissions, setPermissions] = useState<Permission[]>([]);
  const [agents, setAgents] = useState<AgentLite[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [confirming, setConfirming] = useState<string | null>(null);
  const [refreshes, setRefreshes] = useState(0);
  // the form for one agent in one app
  const [agentId, setAgentId] = useState("");
  const [appId, setAppId] = useState("");
  const [chosen, setChosen] = useState<Action[]>(["read", "draft"]);

  const authed = useCallback(
    async (path: string, init: RequestInit = {}) => {
      const res = await fetch(path, { ...init, headers: { "content-type": "application/json", Authorization: `Bearer ${apiKey}`, ...(init.headers ?? {}) } });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw Object.assign(new Error((body as { error?: string }).error ?? `Request failed (${res.status})`), { status: res.status });
      return body;
    },
    [apiKey],
  );

  useEffect(() => {
    let alive = true;
    void (async () => {
      try {
        const body = (await authed("/api/apps")) as { apps: AppView[]; permissions: Permission[] };
        if (!alive) return;
        setApps(body.apps);
        setPermissions(body.permissions);
        setOn(true);
        if (body.apps.some((a) => a.connection)) {
          const a = await fetch("/api/agents?limit=500").then((x) => x.json()).catch(() => ({ agents: [] }));
          if (alive) setAgents(((a as { agents: AgentLite[] }).agents ?? []).sort((x, y) => x.name.localeCompare(y.name)));
        }
      } catch (e) {
        if (alive) setOn((e as { status?: number }).status === 404 ? false : null);
      }
    })();
    return () => { alive = false; };
  }, [authed, refreshes]);

  // coming back from an app's sign-in page: say how it went once, then tidy the address
  useEffect(() => {
    if (!on) return;
    const q = new URLSearchParams(window.location.search);
    const outcome = q.get("apps");
    if (!outcome) return;
    const name = apps.find((a) => a.appId === q.get("app"))?.name ?? "The app";
    const said = BACK[outcome] ?? BACK.failed;
    onToast(said.type, said.text(name));
    q.delete("apps");
    q.delete("app");
    window.history.replaceState(null, "", `${window.location.pathname}${q.toString() ? `?${q}` : ""}#apps`);
  }, [on, apps, onToast]);

  if (!on) return null;
  const reload = () => setRefreshes((n) => n + 1);
  const connected = apps.filter((a) => a.connection);
  const nameOf = (id: string) => apps.find((a) => a.appId === id)?.name ?? id;

  const connect = async (app: AppView) => {
    setBusy(app.appId);
    try {
      const { url } = (await authed(`/api/apps/${app.appId}/connect`, { method: "POST" })) as { url: string };
      window.location.assign(url);
    } catch (e) {
      onToast("error", e instanceof Error ? e.message : "Something went wrong");
      setBusy(null);
    }
  };

  const disconnect = async (app: AppView) => {
    setBusy(app.appId);
    try {
      const r = (await authed(`/api/apps/${app.appId}`, { method: "DELETE" })) as { appTold: boolean; appHasRevoke: boolean };
      onToast(
        "success",
        r.appTold || !r.appHasRevoke ? `${app.name} is disconnected` : `${app.name} is disconnected here. Remove Axon in ${app.name}'s settings too.`,
      );
      setConfirming(null);
      reload();
    } catch (e) {
      onToast("error", e instanceof Error ? e.message : "Something went wrong");
    } finally {
      setBusy(null);
    }
  };

  const toggle = (a: Action) => {
    setChosen((now) => {
      const next = now.includes(a) ? now.filter((x) => x !== a) : [...now, a];
      // publishing comes with drafting, so the two cannot be split by a stray click
      if (a === "publish" && next.includes("publish") && !next.includes("draft")) next.push("draft");
      if (a === "draft" && !next.includes("draft")) return next.filter((x) => x !== "publish");
      return next;
    });
  };

  const save = async () => {
    setBusy("perm");
    try {
      await authed("/api/apps/permissions", { method: "PUT", body: JSON.stringify({ agentId, appId, actions: chosen }) });
      onToast("success", "Saved");
      setAgentId("");
      setChosen(["read", "draft"]);
      reload();
    } catch (e) {
      onToast("error", e instanceof Error ? e.message : "Something went wrong");
    } finally {
      setBusy(null);
    }
  };

  const reset = async (p: Permission) => {
    setBusy(`${p.agentId}:${p.appId}`);
    try {
      await authed(`/api/apps/permissions?agentId=${encodeURIComponent(p.agentId)}&appId=${encodeURIComponent(p.appId)}`, { method: "DELETE" });
      onToast("success", "Back to read and drafts");
      reload();
    } catch (e) {
      onToast("error", e instanceof Error ? e.message : "Something went wrong");
    } finally {
      setBusy(null);
    }
  };

  return (
    <section id="apps" className="rounded-lg border border-gray-200 dark:border-gray-800 bg-white dark:bg-gray-900 p-5">
      <h2 className="font-semibold text-gray-900 dark:text-white mb-1">Your apps</h2>
      <p className="text-sm text-gray-500 dark:text-gray-400 mb-5">
        Connect an app once and the agents you hire can work in it with your permission. They read and write drafts; anything
        that publishes or sends waits for your OK first. What the app gives Axon to sign in with is kept sealed and is never shown.
      </p>

      <ul className="rounded-lg border border-gray-100 dark:border-gray-800 divide-y divide-gray-100 dark:divide-gray-800">
        {apps.map((app) => {
          const c = app.connection;
          const state = c ? (c.needsReconnect ? "warn" : "on") : "off";
          return (
            <li key={app.appId} className="p-4 flex flex-col sm:flex-row sm:items-start gap-3 min-w-0">
              <div className="flex items-start gap-3 min-w-0 flex-1">
                <span aria-hidden className="shrink-0 w-9 h-9 rounded-lg bg-gray-900 dark:bg-white text-white dark:text-gray-900 text-xs font-semibold flex items-center justify-center">
                  {MONOGRAM[app.appId] ?? app.name.slice(0, 1)}
                </span>
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <p className="font-medium text-gray-900 dark:text-white">{app.name}</p>
                    <span className={chip(app.available || c ? state : "off")}>
                      {c ? (c.needsReconnect ? "Connect again" : "Connected") : app.available ? "Not connected" : "Coming soon"}
                    </span>
                  </div>
                  {c?.accountLabel && <p className="text-xs text-gray-500 dark:text-gray-400 truncate">as {c.accountLabel}</p>}
                  <p className="text-xs text-gray-500 dark:text-gray-400 mt-1">{app.blurb}</p>
                  {(c ? c.scopes : app.asks).length > 0 && (app.available || c) && (
                    <div className="mt-3">
                      <p className={label}>{c ? "Allowed by the app" : "Connecting asks for"}</p>
                      <ul className="text-xs text-gray-600 dark:text-gray-300 space-y-0.5">
                        {(c ? c.scopes : app.asks).map((s) => <li key={s}>{s}</li>)}
                      </ul>
                    </div>
                  )}
                  {c && <p className="mt-2 text-[11px] text-gray-400">Connected {when(c.createdAt)}{c.lastUsedAt ? ` · last used ${when(c.lastUsedAt)}` : " · not used yet"}</p>}
                </div>
              </div>

              {(c || app.available) && <div className="flex flex-wrap gap-2 sm:justify-end sm:max-w-xs pl-12 sm:pl-0">
                {!c && app.available && (
                  <button onClick={() => void connect(app)} disabled={busy !== null} className={button}>
                    {busy === app.appId ? "Opening…" : `Connect ${app.name}`}
                  </button>
                )}
                {c?.needsReconnect && app.available && (
                  <button onClick={() => void connect(app)} disabled={busy !== null} className={button}>Connect again</button>
                )}
                {c && confirming !== app.appId && (
                  <button onClick={() => setConfirming(app.appId)} disabled={busy !== null} className={danger}>Disconnect</button>
                )}
                {c && confirming === app.appId && (
                  <div className="w-full rounded-lg border border-red-200 dark:border-red-900 bg-red-50 dark:bg-red-950/30 p-3 text-xs text-red-800 dark:text-red-300 space-y-2">
                    <p>Disconnect {app.name}? Agents lose access at once, and anything waiting for your OK there is cancelled.</p>
                    <div className="flex gap-2">
                      <button onClick={() => void disconnect(app)} disabled={busy !== null} className={danger}>{busy === app.appId ? "Disconnecting…" : "Disconnect"}</button>
                      <button onClick={() => setConfirming(null)} className={button}>Keep it</button>
                    </div>
                  </div>
                )}
              </div>}
            </li>
          );
        })}
      </ul>

      <div className="mt-6 border-t border-gray-100 dark:border-gray-800 pt-5">
        <h3 className="text-sm font-semibold text-gray-900 dark:text-white mb-1">What each agent may do</h3>
        <p className="text-xs text-gray-500 dark:text-gray-400 mb-4">
          An agent you have not set may read and write drafts in your connected apps, nothing more. To let one publish or send,
          allow it here; each thing it wants to put out still waits for your OK.
        </p>

        {connected.length === 0 ? (
          <p className="text-sm text-gray-400">Connect an app first, then choose what each agent may do in it.</p>
        ) : (
          <div className="rounded-lg border border-gray-100 dark:border-gray-800 p-4 space-y-3">
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div>
                <label className={label} htmlFor="apps-agent">Agent</label>
                <select id="apps-agent" value={agentId} onChange={(e) => setAgentId(e.target.value)} className={input}>
                  <option value="">Choose an agent…</option>
                  {agents.map((a) => <option key={a.agentId} value={a.agentId}>{a.name}</option>)}
                </select>
              </div>
              <div>
                <label className={label} htmlFor="apps-app">App</label>
                <select id="apps-app" value={appId} onChange={(e) => setAppId(e.target.value)} className={input}>
                  <option value="">Choose an app…</option>
                  {connected.map((a) => <option key={a.appId} value={a.appId}>{a.name}</option>)}
                </select>
              </div>
            </div>
            <fieldset className="flex flex-wrap gap-x-5 gap-y-2">
              <legend className={label}>May</legend>
              {(["read", "draft", "publish"] as Action[]).map((a) => (
                <label key={a} className="flex items-center gap-2 text-sm text-gray-700 dark:text-gray-300">
                  <input type="checkbox" checked={chosen.includes(a)} onChange={() => toggle(a)} />
                  {apps.find((x) => x.appId === appId)?.actions.find((x) => x.action === a)?.label ?? ACTION_WORD[a]}
                </label>
              ))}
            </fieldset>
            <button onClick={() => void save()} disabled={!agentId || !appId || busy !== null} className={button}>{busy === "perm" ? "Saving…" : "Save"}</button>
          </div>
        )}

        {permissions.length > 0 && (
          <ul className="mt-4 divide-y divide-gray-100 dark:divide-gray-800">
            {permissions.map((p) => (
              <li key={`${p.agentId}:${p.appId}`} className="py-2 flex flex-wrap items-center justify-between gap-2 text-sm">
                <span className="text-gray-800 dark:text-gray-200 min-w-0 truncate">
                  {p.agentName ?? p.agentId} <span className="text-gray-400">in {nameOf(p.appId)}</span>
                </span>
                <span className="flex items-center gap-2">
                  <span className="text-xs text-gray-500 dark:text-gray-400">{p.actions.length ? p.actions.map((a) => ACTION_WORD[a]).join(", ") : "Nothing"}</span>
                  <button onClick={() => void reset(p)} disabled={busy !== null} className={button}>Reset</button>
                </span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </section>
  );
}
