"use client";

import { useCallback, useEffect, useState } from "react";

// What an agent built in a job, under its answer: what it is called, the address it opens at, the two things to do
// with that address, and, once it has been changed, its versions with a way back to an earlier one. When the page
// can also be taken away: all its files in one archive, to keep or to put on the web anywhere. When the page
// has a form, what visitors sent through it is listed here too, for the person who had it built: read, taken as a
// file, or removed one by one. The built page itself is never shown here: it opens on its own address, sealed.

export interface Built { siteId: string; title: string; version: number; url: string }
interface Version { version: number; note: string | null; createdAt: string; shown: boolean; madeHere: boolean; url: string }
interface Answer { id: string; form: string; at: string; version: number; fields: [string, string][] }

/** When an answer came in, as a person reads it. */
const when = (iso: string): string => { const d = new Date(iso); return Number.isNaN(d.getTime()) ? "" : d.toLocaleString(undefined, { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" }); };

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
  // the page's form, when it has one: how many answers there are, and the answers once they are asked for
  const [form, setForm] = useState<{ has: boolean; total: number }>({ has: false, total: 0 });
  const [answers, setAnswers] = useState<Answer[] | null>(null);
  const [open, setOpen] = useState(false);
  const [working, setWorking] = useState("");
  const [said, setSaid] = useState("");
  // a schedule or a trigger whose runs keep the page up to date, when one does
  const [kept, setKept] = useState<"schedule" | "trigger" | null>(null);
  const [took, setTook] = useState("");
  const siteId = site?.siteId, siteVersion = site?.version;

  /** The page's versions, as the server has them: read, or after asking it to show one of them again. */
  const ask = useCallback(async (body?: { version: number }): Promise<{ versions: Version[]; has: boolean; total: number; kept: "schedule" | "trigger" | null } | null> => {
    if (!taskId || !claim) return null;
    const res = await fetch(`/api/tasks/${encodeURIComponent(taskId)}/site`, {
      ...(body ? { method: "POST", body: JSON.stringify(body) } : {}),
      headers: { "x-claim-token": claim, ...(body ? { "content-type": "application/json" } : {}) },
    });
    if (!res.ok) return null;
    const got = (await res.json()) as { versions?: Version[]; form?: boolean; answers?: number; kept?: string | null };
    return { versions: Array.isArray(got.versions) ? got.versions : [], has: Boolean(got.form), total: typeof got.answers === "number" ? got.answers : 0, kept: got.kept === "schedule" || got.kept === "trigger" ? got.kept : null };
  }, [taskId, claim]);

  /** The answers people sent through the page's form: read, or read again after one was removed. */
  const answersUrl = taskId ? `/api/tasks/${encodeURIComponent(taskId)}/site/answers` : "";
  const readAnswers = useCallback(async (removeId?: string): Promise<boolean> => {
    if (!answersUrl || !claim) return false;
    const res = await fetch(removeId ? `${answersUrl}?id=${encodeURIComponent(removeId)}` : answersUrl, { ...(removeId ? { method: "DELETE" } : {}), headers: { "x-claim-token": claim } });
    if (!res.ok) return false;
    const got = (await res.json()) as { total?: number; answers?: Answer[] };
    setAnswers(Array.isArray(got.answers) ? got.answers : []);
    setForm((f) => ({ has: f.has, total: typeof got.total === "number" ? got.total : f.total }));
    return true;
  }, [answersUrl, claim]);

  // the versions are read when the card first shows a site, and again when the job has made another
  useEffect(() => {
    if (!siteId) return;
    let off = false;
    ask().then((got) => { if (!off && got) { setVersions(got.versions); setForm({ has: got.has, total: got.total }); setKept(got.kept); } }).catch(() => undefined);
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
    if (got) { setVersions(got.versions); setForm({ has: got.has, total: got.total }); } else setFailed("That did not go through. Try again.");
    setBusy(null);
  };
  const now = versions.find((v) => v.shown)?.version ?? site.version;
  const toggleAnswers = async () => {
    const next = !open;
    setOpen(next); setSaid("");
    if (next) { setWorking("read"); if (!(await readAnswers().catch(() => false))) setSaid("The answers could not be read. Try again."); setWorking(""); }
  };
  const remove = async (id: string) => {
    setWorking(id); setSaid("");
    if (!(await readAnswers(id).catch(() => false))) setSaid("That did not go through. Try again.");
    setWorking("");
  };
  // the file is fetched with the job's own token and handed to the browser to save: it is not a public address
  const download = async () => {
    if (!answersUrl || !claim) return;
    setWorking("file"); setSaid("");
    try {
      const res = await fetch(`${answersUrl}?format=csv`, { headers: { "x-claim-token": claim } });
      if (!res.ok) throw new Error(String(res.status));
      const href = URL.createObjectURL(await res.blob());
      const a = document.createElement("a");
      a.href = href; a.download = /filename="([^"]+)"/.exec(res.headers.get("content-disposition") ?? "")?.[1] ?? "answers.csv";
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(href), 2000);
    } catch { setSaid("The file could not be made. Try again."); }
    setWorking("");
  };
  const showAnswers = Boolean(taskId && claim) && (form.has || form.total > 0);
  // every file of the page in one archive, fetched with the job's own token and handed to the browser to save
  const takeFiles = async () => {
    if (!taskId || !claim) return;
    setWorking("zip"); setTook("");
    try {
      const res = await fetch(`/api/tasks/${encodeURIComponent(taskId)}/site/zip`, { headers: { "x-claim-token": claim } });
      if (!res.ok) throw new Error(String(res.status));
      const href = URL.createObjectURL(await res.blob());
      const a = document.createElement("a");
      a.href = href; a.download = /filename="([^"]+)"/.exec(res.headers.get("content-disposition") ?? "")?.[1] ?? "page.zip";
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(href), 2000);
    } catch { setTook("The files could not be made ready. Try again."); }
    setWorking("");
  };

  return (
    <div className="mt-3 rounded-md border border-gray-200 bg-white p-3 dark:border-gray-800 dark:bg-gray-900/40">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <div className="min-w-0 flex-1 basis-48">
          <p className="text-[11px] font-semibold uppercase tracking-wider text-gray-400 dark:text-gray-500">{now > 1 || versions.length > 1 ? `Built, showing version ${now}` : "Built"}</p>
          <p className="truncate text-sm font-semibold text-gray-900 dark:text-white">{site.title}</p>
          <p className="truncate text-xs text-gray-500 dark:text-gray-400" title={full}>{shown(full)}</p>
          {kept && <p className="mt-0.5 text-[11px] text-gray-500 dark:text-gray-400">{kept === "schedule" ? "Kept up to date by a schedule: each run changes this page, at this link." : "Kept up to date by a trigger: each run changes this page, at this link."}</p>}
        </div>
        <a href={site.url} target="_blank" rel="noopener noreferrer" className="shrink-0 rounded-md bg-gray-900 px-3 py-1.5 text-sm font-medium text-white hover:bg-gray-700 dark:bg-white dark:text-gray-900 dark:hover:bg-gray-200">
          Open
        </a>
        <button type="button" onClick={copy} className="shrink-0 rounded-md border border-gray-300 px-3 py-1.5 text-sm text-gray-700 hover:bg-gray-50 dark:border-gray-700 dark:text-gray-300 dark:hover:bg-gray-800">
          {copied ? "Copied" : "Copy link"}
        </button>
        {taskId && claim && (
          <button type="button" onClick={takeFiles} disabled={working === "zip"} title="Every file of this page in one archive, to keep or to put on the web anywhere" className="shrink-0 rounded-md border border-gray-300 px-3 py-1.5 text-sm text-gray-700 hover:bg-gray-50 disabled:opacity-50 dark:border-gray-700 dark:text-gray-300 dark:hover:bg-gray-800">
            {working === "zip" ? "Getting them" : "Download files"}
          </button>
        )}
      </div>
      {took && <p className="mt-1 text-xs text-red-600 dark:text-red-400">{took}</p>}
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
      {showAnswers && (
        <div className="mt-3 border-t border-gray-100 pt-2 dark:border-gray-800">
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
            <p className="text-[11px] font-semibold uppercase tracking-wider text-gray-400 dark:text-gray-500">Answers</p>
            <p className="min-w-0 flex-1 text-xs text-gray-600 dark:text-gray-400">
              {form.total === 0 ? "This page has a form. What people send through it is listed here." : `${form.total} ${form.total === 1 ? "answer" : "answers"} sent through the page's form`}
            </p>
            {/* always there: pressing it reads the answers afresh, so new ones show without the page being loaded again */}
            <button type="button" onClick={toggleAnswers} aria-expanded={open} className="shrink-0 text-xs text-teal-600 hover:underline dark:text-teal-400">{open ? "Hide them" : form.total > 0 ? "See them" : "Check for answers"}</button>
            {form.total > 0 && (
              <button type="button" onClick={download} disabled={working === "file"} className="shrink-0 text-xs text-teal-600 hover:underline disabled:opacity-50 dark:text-teal-400">{working === "file" ? "Making the file" : "Download as a file"}</button>
            )}
          </div>
          {open && answers && answers.length > 0 && (
            <ol className="mt-2 max-h-80 space-y-2 overflow-y-auto">
              {answers.map((a) => (
                <li key={a.id} className="rounded-md border border-gray-100 p-2 text-xs dark:border-gray-800">
                  <div className="flex items-baseline gap-2 text-[11px] text-gray-400 dark:text-gray-500">
                    <span className="min-w-0 flex-1 truncate">{when(a.at)}{a.form && a.form !== "form" ? ` · ${a.form}` : ""}</span>
                    <button type="button" onClick={() => remove(a.id)} disabled={working !== ""} className="shrink-0 hover:text-red-600 hover:underline disabled:opacity-50 dark:hover:text-red-400">{working === a.id ? "Removing" : "Remove"}</button>
                  </div>
                  <dl className="mt-1 space-y-0.5">
                    {a.fields.filter(([, v]) => v !== "").map(([name, value], i) => (
                      <div key={`${name}-${i}`} className="flex min-w-0 gap-2">
                        <dt className="shrink-0 font-medium text-gray-900 dark:text-white">{name.replace(/[_-]+/g, " ")}</dt>
                        <dd className="min-w-0 flex-1 whitespace-pre-wrap break-words text-gray-600 dark:text-gray-300">{value}</dd>
                      </div>
                    ))}
                  </dl>
                </li>
              ))}
            </ol>
          )}
          {open && working === "read" && !answers && <p className="mt-2 text-xs text-gray-400 dark:text-gray-500">Reading them</p>}
          {open && working === "" && answers && answers.length === 0 && !said && <p className="mt-2 text-xs text-gray-400 dark:text-gray-500">None yet.</p>}
          {said && <p className="mt-1 text-xs text-red-600 dark:text-red-400">{said}</p>}
        </div>
      )}
    </div>
  );
}
