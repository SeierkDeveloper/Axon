"use client";

import { useCallback, useEffect, useState } from "react";

// What an agent built in a job, under its answer: what it is called, the address it opens at, the two things to do
// with that address, and, once it has been changed, its versions with a way back to an earlier one. The built page
// itself is never shown here: it opens on its own address, sealed.

export interface Built { siteId: string; title: string; version: number; url: string }
interface Version { version: number; note: string | null; createdAt: string; shown: boolean; madeHere: boolean; url: string }

/** The address as it reads: without the scheme. */
const shown = (url: string): string => url.replace(/^https?:\/\//i, "");
const local = (url: string): string => (/^https?:\/\//i.test(url) ? url : typeof window !== "undefined" ? `${window.location.origin}${url}` : url);

/**
 * `taskId` and `claim` are the job and the token that reads it: with them the card also lists the page's versions and
 * can show an earlier one again. Without them it is the address and nothing more.
 */
export default function BuiltSite({ site, taskId, claim }: { site: Built | null | undefined; taskId?: string; claim?: string }) {
  const [copied, setCopied] = useState(false);
  const [versions, setVersions] = useState<Version[]>([]);
  const [busy, setBusy] = useState<number | null>(null);
  const [failed, setFailed] = useState("");
  const siteId = site?.siteId, siteVersion = site?.version;

  /** The page's versions, as the server has them: read, or after asking it to show one of them again. */
  const ask = useCallback(async (body?: { version: number }): Promise<Version[] | null> => {
    if (!taskId || !claim) return null;
    const res = await fetch(`/api/tasks/${encodeURIComponent(taskId)}/site`, {
      ...(body ? { method: "POST", body: JSON.stringify(body) } : {}),
      headers: { "x-claim-token": claim, ...(body ? { "content-type": "application/json" } : {}) },
    });
    if (!res.ok) return null;
    const got = (await res.json()) as { versions?: Version[] };
    return Array.isArray(got.versions) ? got.versions : [];
  }, [taskId, claim]);

  // the versions are read when the card first shows a site, and again when the job has made another
  useEffect(() => {
    if (!siteId) return;
    let off = false;
    ask().then((got) => { if (!off && got) setVersions(got); }).catch(() => undefined);
    return () => { off = true; };
  }, [ask, siteId, siteVersion]);

  if (!site?.url) return null;
  const full = local(site.url);
  const copy = async () => {
    try { await navigator.clipboard.writeText(full); setCopied(true); setTimeout(() => setCopied(false), 1600); } catch { /* the address is on the page to copy by hand */ }
  };
  const goBack = async (version: number) => {
    setBusy(version); setFailed("");
    const got = await ask({ version }).catch(() => null);
    if (got) setVersions(got); else setFailed("That did not go through. Try again.");
    setBusy(null);
  };
  const now = versions.find((v) => v.shown)?.version ?? site.version;

  return (
    <div className="mt-3 rounded-md border border-gray-200 bg-white p-3 dark:border-gray-800 dark:bg-gray-900/40">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <div className="min-w-0 flex-1 basis-48">
          <p className="text-[11px] font-semibold uppercase tracking-wider text-gray-400 dark:text-gray-500">{now > 1 || versions.length > 1 ? `Built, showing version ${now}` : "Built"}</p>
          <p className="truncate text-sm font-semibold text-gray-900 dark:text-white">{site.title}</p>
          <p className="truncate text-xs text-gray-500 dark:text-gray-400" title={full}>{shown(full)}</p>
        </div>
        <a href={site.url} target="_blank" rel="noopener noreferrer" className="shrink-0 rounded-md bg-gray-900 px-3 py-1.5 text-sm font-medium text-white hover:bg-gray-700 dark:bg-white dark:text-gray-900 dark:hover:bg-gray-200">
          Open
        </a>
        <button type="button" onClick={copy} className="shrink-0 rounded-md border border-gray-300 px-3 py-1.5 text-sm text-gray-700 hover:bg-gray-50 dark:border-gray-700 dark:text-gray-300 dark:hover:bg-gray-800">
          {copied ? "Copied" : "Copy link"}
        </button>
      </div>
      {versions.length > 1 && (
        <div className="mt-3 border-t border-gray-100 pt-2 dark:border-gray-800">
          <p className="text-[11px] font-semibold uppercase tracking-wider text-gray-400 dark:text-gray-500">Versions</p>
          <ol className="mt-1 space-y-1">
            {versions.map((v) => (
              <li key={v.version} className="flex min-w-0 items-baseline gap-2 text-xs text-gray-600 dark:text-gray-400">
                <span className="shrink-0 tabular-nums font-medium text-gray-900 dark:text-white">{v.version}</span>
                <span className="min-w-0 flex-1 truncate">{v.note || (v.version === 1 ? "The first version" : "A change")}</span>
                {v.shown
                  ? <span className="shrink-0 text-gray-900 dark:text-white">showing now</span>
                  : (
                    <>
                      <a href={v.url} target="_blank" rel="noopener noreferrer" className="shrink-0 text-teal-600 hover:underline dark:text-teal-400">Look</a>
                      <button type="button" disabled={busy !== null} onClick={() => goBack(v.version)} className="shrink-0 text-teal-600 hover:underline disabled:opacity-50 dark:text-teal-400">
                        {busy === v.version ? "Switching" : "Show this one"}
                      </button>
                    </>
                  )}
              </li>
            ))}
          </ol>
          {failed && <p className="mt-1 text-xs text-red-600 dark:text-red-400">{failed}</p>}
        </div>
      )}
    </div>
  );
}
