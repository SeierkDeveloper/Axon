"use client";
// Your apps, on the dashboard: connect an app once (GitHub, Notion, Slack, Google Docs, Gmail) and say what each agent
// you hire may do in it. Each app is a tile with its own mark; one Axon has no client for yet is a tile that cannot be
// clicked and says "Coming soon", and works the moment its client is set.
//
// It shows nothing at all until the server says apps are on, so the dashboard is unchanged while they are off.
// Everything goes through /api/apps with the owner's key; no answer from it ever carries a token.

import { useCallback, useEffect, useState } from "react";
import AppIcon from "@/components/AppIcon";

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
interface Standing { agentId: string; agentName: string | null; appId: string; target: string; targetLabel: string; createdAt: string }
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
  const [standing, setStanding] = useState<Standing[]>([]);
  const [picked, setPicked] = useState<string | null>(null);
  // posting without asking: the channel typed for one agent
  const [channelFor, setChannelFor] = useState<{ agentId: string; channel: string } | null>(null);
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
        const body = (await authed("/api/apps")) as { apps: AppView[]; permissions: Permission[]; standing?: Standing[] };
        if (!alive) return;
        setApps(body.apps);
        setPermissions(body.permissions);
        setStanding(body.standing ?? []);
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
  // the tile whose details show: the one clicked, else the first connected, else the first that can be connected
  const selected = apps.find((a) => a.appId === picked && (a.available || a.connection)) ?? connected[0] ?? apps.find((a) => a.available) ?? null;
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

  const allowStanding = async (p: Permission) => {
    if (!channelFor?.channel.trim()) return;
    setBusy(`stand:${p.agentId}`);
    try {
      const r = (await authed("/api/apps/standing", { method: "PUT", body: JSON.stringify({ agentId: p.agentId, appId: p.appId, channel: channelFor.channel }) })) as { standing: Standing };
      onToast("success", `${p.agentName ?? p.agentId} may post in ${r.standing.targetLabel} without asking, on a schedule`);
      setChannelFor(null);
      reload();
    } catch (e) {
      onToast("error", e instanceof Error ? e.message : "Something went wrong");
    } finally {
      setBusy(null);
    }
  };

  const stopStanding = async (x: Standing) => {
    setBusy(`stand:${x.agentId}`);
    try {
      await authed(`/api/apps/standing?agentId=${encodeURIComponent(x.agentId)}&appId=${encodeURIComponent(x.appId)}&target=${encodeURIComponent(x.target)}`, { method: "DELETE" });
      onToast("success", `It asks you first in ${x.targetLabel} again`);
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

      <div className="grid grid-cols-1 sm:grid-cols-5 gap-2">
        {apps.map((app) => {
          const c = app.connection;
          const open = app.available || Boolean(c);
          const word = c ? (c.needsReconnect ? "Connect again" : "Connected") : app.available ? "Not connected" : "Coming soon";
          const tone = c ? (c.needsReconnect ? "warn" : "on") : "off";
          const chosen = selected?.appId === app.appId;
          return (
            <button
              key={app.appId}
              type="button"
              disabled={!open}
              aria-pressed={open ? chosen : undefined}
              aria-label={`${app.name}: ${word}`}
              onClick={() => setPicked(app.appId)}
              className={`group flex sm:flex-col items-center gap-3 sm:gap-2 rounded-lg border px-3 py-2.5 sm:py-4 text-left sm:text-center transition-colors ${
                !open
                  ? "border-dashed border-gray-200 dark:border-gray-800 cursor-not-allowed"
                  : chosen
                    ? "border-gray-900 dark:border-white bg-gray-50 dark:bg-gray-800/60"
                    : "border-gray-200 dark:border-gray-700 hover:border-gray-400 dark:hover:border-gray-500"
              }`}
            >
              <span className={`shrink-0 w-10 h-10 rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-950 flex items-center justify-center ${open ? "" : "opacity-75"}`}>
                <AppIcon appId={app.appId} size={22} />
              </span>
              <span className={`flex-1 sm:flex-none min-w-0 text-sm font-medium truncate ${open ? "text-gray-900 dark:text-white" : "text-gray-400 dark:text-gray-500"}`}>{app.name}</span>
              <span className={chip(tone)}>{word}</span>
            </button>
          );
        })}
      </div>

      {selected ? (
        <AppDetail
          app={selected}
          busy={busy}
          confirming={confirming === selected.appId}
          onConnect={() => void connect(selected)}
          onAskDisconnect={() => setConfirming(selected.appId)}
          onDisconnect={() => void disconnect(selected)}
          onKeep={() => setConfirming(null)}
        />
      ) : (
        <p className="mt-4 text-sm text-gray-400">These apps are coming soon.</p>
      )}

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
            {permissions.map((p) => {
              const mine = standing.filter((x) => x.agentId === p.agentId && x.appId === p.appId);
              const mayStand = p.appId === "slack" && p.actions.includes("publish");
              const typing = channelFor?.agentId === p.agentId;
              return (
                <li key={`${p.agentId}:${p.appId}`} className="py-2 text-sm">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <span className="flex items-center gap-2 text-gray-800 dark:text-gray-200 min-w-0">
                      <AppIcon appId={p.appId} size={14} />
                      <span className="truncate">{p.agentName ?? p.agentId} <span className="text-gray-400">in {nameOf(p.appId)}</span></span>
                    </span>
                    <span className="flex items-center gap-2">
                      <span className="text-xs text-gray-500 dark:text-gray-400">{p.actions.length ? p.actions.map((a) => ACTION_WORD[a]).join(", ") : "Nothing"}</span>
                      <button onClick={() => void reset(p)} disabled={busy !== null} className={button}>Reset</button>
                    </span>
                  </div>
                  {mayStand && (
                    <div className="mt-2 pl-6 space-y-1.5">
                      {mine.map((x) => (
                        <p key={x.target} className="flex flex-wrap items-center gap-2 text-xs text-gray-600 dark:text-gray-300">
                          <span>Posts in {x.targetLabel} without asking, on a schedule or trigger</span>
                          <button onClick={() => void stopStanding(x)} disabled={busy !== null} className="underline underline-offset-2 text-gray-500 dark:text-gray-400 disabled:opacity-40">Ask me again</button>
                        </p>
                      ))}
                      {typing ? (
                        <div className="flex flex-wrap items-center gap-2">
                          <input
                            value={channelFor.channel}
                            onChange={(e) => setChannelFor({ agentId: p.agentId, channel: e.target.value })}
                            placeholder="#channel"
                            aria-label="Channel"
                            className={`${input} max-w-[12rem]`}
                          />
                          <button onClick={() => void allowStanding(p)} disabled={busy !== null || !channelFor.channel.trim()} className={button}>{busy === `stand:${p.agentId}` ? "Saving…" : "Allow"}</button>
                          <button onClick={() => setChannelFor(null)} className={button}>Cancel</button>
                          <p className="w-full text-[11px] text-gray-400">Only for jobs that start themselves on a schedule or trigger. Everything else still waits for your OK.</p>
                        </div>
                      ) : (
                        <button onClick={() => setChannelFor({ agentId: p.agentId, channel: "" })} disabled={busy !== null} className="text-xs underline underline-offset-2 text-gray-500 dark:text-gray-400 disabled:opacity-40">
                          Let it post in one channel without asking
                        </button>
                      )}
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </section>
  );
}

/** The details of the app whose tile is chosen: what it is, what connecting asks for, and connect or disconnect. */
function AppDetail({ app, busy, confirming, onConnect, onAskDisconnect, onDisconnect, onKeep }: {
  app: AppView;
  busy: string | null;
  confirming: boolean;
  onConnect: () => void;
  onAskDisconnect: () => void;
  onDisconnect: () => void;
  onKeep: () => void;
}) {
  const c = app.connection;
  const list = c ? c.scopes : app.asks;
  return (
    <div className="mt-3 rounded-lg border border-gray-100 dark:border-gray-800 p-4 flex flex-col sm:flex-row sm:items-start gap-4 min-w-0">
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <AppIcon appId={app.appId} size={16} />
          <p className="font-medium text-gray-900 dark:text-white">{app.name}</p>
          {c?.accountLabel && <p className="text-xs text-gray-500 dark:text-gray-400 truncate">as {c.accountLabel}</p>}
        </div>
        <p className="text-xs text-gray-500 dark:text-gray-400 mt-1">{app.blurb}</p>
        {list.length > 0 && (
          <div className="mt-3">
            <p className={label}>{c ? "Allowed by the app" : "Connecting asks for"}</p>
            <ul className="text-xs text-gray-600 dark:text-gray-300 space-y-0.5">
              {list.map((s) => <li key={s}>{s}</li>)}
            </ul>
          </div>
        )}
        {c && <p className="mt-2 text-[11px] text-gray-400">Connected {when(c.createdAt)}{c.lastUsedAt ? ` · last used ${when(c.lastUsedAt)}` : " · not used yet"}</p>}
      </div>
      <div className="flex flex-wrap gap-2 sm:justify-end sm:max-w-xs">
        {!c && app.available && (
          <button onClick={onConnect} disabled={busy !== null} className={button}>
            {busy === app.appId ? "Opening…" : `Connect ${app.name}`}
          </button>
        )}
        {c?.needsReconnect && app.available && (
          <button onClick={onConnect} disabled={busy !== null} className={button}>Connect again</button>
        )}
        {c && !confirming && (
          <button onClick={onAskDisconnect} disabled={busy !== null} className={danger}>Disconnect</button>
        )}
        {c && confirming && (
          <div className="w-full rounded-lg border border-red-200 dark:border-red-900 bg-red-50 dark:bg-red-950/30 p-3 text-xs text-red-800 dark:text-red-300 space-y-2">
            <p>Disconnect {app.name}? Agents lose access at once, and anything waiting for your OK there is cancelled.</p>
            <div className="flex gap-2">
              <button onClick={onDisconnect} disabled={busy !== null} className={danger}>{busy === app.appId ? "Disconnecting…" : "Disconnect"}</button>
              <button onClick={onKeep} className={button}>Keep it</button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
