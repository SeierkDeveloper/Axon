"use client";

import { useEffect, useState } from "react";

/**
 * What an agent handed back with its answer: each file with a download button, and a picture shown as it is. The
 * file's token goes in a header, never in the address, so it does not end up in a log or in browser history.
 */

export interface OutputFile { id: string; name: string; type: string; kind: "pdf" | "image" | "text" | "office"; size: number; sha256: string; token: string; path: string; madeBy?: { agentId: string; name: string; taskId: string }; version?: number; revises?: string; first?: { sha256: string; taskId: string | null } }

/** One version of a file, as GET /api/files/{id}/versions lists it. */
interface Version { version: number; id: string; name: string; size: number; sha256: string; taskId: string | null; uploaded?: boolean; token: string; path: string; current: boolean }

const size = (n: number) => (n >= 1048576 ? `${(n / 1048576).toFixed(1)} MB` : n >= 1024 ? `${Math.round(n / 1024)} KB` : `${n} B`);

async function bytesOf(f: { path: string; token: string }): Promise<Blob | null> {
  try {
    const r = await fetch(f.path, { headers: { "x-file-token": f.token } });
    return r.ok ? await r.blob() : null;
  } catch {
    return null;
  }
}

/** A returned picture, drawn from its bytes. Shows nothing until they are here, and nothing if they never come. */
function Picture({ file }: { file: OutputFile }) {
  const [src, setSrc] = useState<string | null>(null);
  useEffect(() => {
    let alive = true, made: string | null = null;
    void bytesOf(file).then((b) => {
      if (!b || !alive) return;
      made = URL.createObjectURL(b);
      setSrc(made);
    });
    return () => { alive = false; if (made) URL.revokeObjectURL(made); };
  }, [file]);
  if (!src) return null;
  // eslint-disable-next-line @next/next/no-img-element -- bytes fetched with a token, not a public image the optimizer can reach
  return <img src={src} alt={file.name} className="mt-2 max-h-72 w-auto max-w-full rounded-md border border-gray-200 bg-white dark:border-gray-800" />;
}

/**
 * The versions before this one, each with its own fingerprint and download. Asked for only when somebody opens the
 * list. Nothing is shown for a file that was never revised.
 */
function EarlierVersions({ file, onDownload, busy }: { file: OutputFile; onDownload: (f: { id: string; name: string; path: string; token: string }) => void; busy: string | null }) {
  const [list, setList] = useState<Version[] | null>(null);
  const [failed, setFailed] = useState(false);
  const load = async () => {
    if (list || failed) return;
    try {
      const r = await fetch(`/api/files/${encodeURIComponent(file.id)}/versions`, { headers: { "x-file-token": file.token } });
      const d = (await r.json()) as { versions?: Version[] };
      if (r.ok && Array.isArray(d.versions)) setList(d.versions.filter((v) => !v.current).reverse());
      else setFailed(true);
    } catch {
      setFailed(true);
    }
  };
  return (
    <details className="mt-1.5" onToggle={(e) => { if ((e.target as HTMLDetailsElement).open) void load(); }}>
      <summary className="cursor-pointer select-none text-[11px] text-gray-500 hover:text-gray-900 dark:text-gray-400 dark:hover:text-white">
        Earlier {file.version === 2 ? "version" : "versions"}, each kept with its own fingerprint
      </summary>
      {failed && <p className="mt-1.5 text-[11px] text-amber-600 dark:text-amber-400">The earlier versions could not be listed. Try again.</p>}
      {list && list.length === 0 && <p className="mt-1.5 text-[11px] text-gray-400">No earlier version is stored any more.</p>}
      {list && list.length > 0 && (
        <ul className="mt-1.5 space-y-1.5">
          {list.map((v) => (
            <li key={v.id} className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px] text-gray-500 dark:text-gray-400">
              <span className="shrink-0 rounded border border-gray-200 px-1 font-mono text-[10px] dark:border-gray-700">v{v.version}</span>
              <span className="min-w-0 truncate">{v.name}</span>
              <span className="shrink-0 tabular-nums text-gray-400">{size(v.size)}</span>
              <span className="min-w-0 truncate font-mono text-[10px] text-gray-400" title={`SHA-256 ${v.sha256}`}>sha256 {v.sha256.slice(0, 16)}…</span>
              {v.taskId && (
                <a href={`/r/${encodeURIComponent(v.taskId)}`} target="_blank" rel="noopener noreferrer" className="shrink-0 text-teal-600 hover:underline dark:text-teal-400">Receipt →</a>
              )}
              {v.uploaded && <span className="shrink-0 text-gray-400">your upload</span>}
              <button type="button" onClick={() => onDownload(v)} disabled={busy === v.id} className="ml-auto shrink-0 rounded-md border border-gray-200 px-2 py-0.5 font-medium text-gray-700 transition-colors hover:border-gray-400 disabled:opacity-50 dark:border-gray-700 dark:text-gray-200 dark:hover:border-gray-500">
                {busy === v.id ? "Downloading…" : "Download"}
              </button>
            </li>
          ))}
        </ul>
      )}
    </details>
  );
}

export default function OutputFiles({ files }: { files: OutputFile[] }) {
  const [busy, setBusy] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  if (!files.length) return null;

  const download = async (f: { id: string; name: string; path: string; token: string }) => {
    setBusy(f.id);
    setNote(null);
    const b = await bytesOf(f);
    setBusy(null);
    if (!b) { setNote(`${f.name} could not be downloaded. Try again.`); return; }
    const url = URL.createObjectURL(b), a = document.createElement("a");
    a.href = url;
    a.download = f.name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10_000);
  };

  return (
    <div className="mt-3">
      <p className="mb-1.5 text-xs font-semibold uppercase tracking-wider text-teal-700 dark:text-teal-400">{files.length === 1 ? "File" : "Files"}</p>
      <ul className="space-y-2">
        {files.map((f) => (
          <li key={f.id} className="rounded-md border border-gray-200 bg-gray-50/60 p-2.5 dark:border-gray-800 dark:bg-gray-900/40">
            <div className="flex items-center gap-2 text-xs">
              <span className="shrink-0 font-mono text-[10px] uppercase text-gray-400">{f.kind === "image" ? "img" : f.kind === "office" ? (/\.([a-z]{3,4})$/i.exec(f.name)?.[1] ?? "doc") : f.kind}</span>
              <span className="min-w-0 truncate font-medium text-gray-900 dark:text-white">{f.name}</span>
              {f.version && f.version > 1 && (
                <span className="shrink-0 rounded border border-teal-200 bg-teal-50 px-1.5 font-mono text-[10px] text-teal-700 dark:border-teal-900/50 dark:bg-teal-950/30 dark:text-teal-400" title={`Version ${f.version} of this file`}>v{f.version}</span>
              )}
              <span className="shrink-0 tabular-nums text-gray-400">{size(f.size)}</span>
              {f.madeBy && (
                <a href={`/r/${encodeURIComponent(f.madeBy.taskId)}`} target="_blank" rel="noopener noreferrer" className="hidden shrink-0 truncate text-gray-500 hover:text-teal-600 hover:underline dark:text-gray-400 dark:hover:text-teal-400 sm:inline" title={`Made by ${f.madeBy.name}. Open that job's receipt.`}>
                  by {f.madeBy.name}
                </a>
              )}
              <button type="button" onClick={() => void download(f)} disabled={busy === f.id} className="ml-auto shrink-0 rounded-md border border-gray-200 px-2.5 py-1 font-medium text-gray-700 transition-colors hover:border-gray-400 disabled:opacity-50 dark:border-gray-700 dark:text-gray-200 dark:hover:border-gray-500">
                {busy === f.id ? "Downloading…" : "Download"}
              </button>
            </div>
            {f.kind === "image" && <Picture file={f} />}
            {f.madeBy && <p className="mt-1.5 text-[11px] text-gray-500 dark:text-gray-400 sm:hidden">Made by {f.madeBy.name}</p>}
            <p className="mt-1.5 truncate font-mono text-[10px] text-gray-400" title={`SHA-256 ${f.sha256}`}>sha256 {f.sha256}</p>
            {f.version && f.version > 1 && <EarlierVersions file={f} onDownload={(v) => void download(v)} busy={busy} />}
          </li>
        ))}
      </ul>
      {note && <p role="status" className="mt-2 text-xs text-amber-600 dark:text-amber-400">{note}</p>}
      <p className="mt-1.5 text-[11px] text-gray-400 dark:text-gray-500">Each file&apos;s fingerprint is in the receipt.</p>
    </div>
  );
}
