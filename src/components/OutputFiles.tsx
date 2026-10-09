"use client";

import { useEffect, useState } from "react";

/**
 * What an agent handed back with its answer: each file with a download button, and a picture shown as it is. The
 * file's token goes in a header, never in the address, so it does not end up in a log or in browser history.
 */

export interface OutputFile { id: string; name: string; type: string; kind: "pdf" | "image" | "text"; size: number; sha256: string; token: string; path: string; madeBy?: { agentId: string; name: string; taskId: string } }

const size = (n: number) => (n >= 1048576 ? `${(n / 1048576).toFixed(1)} MB` : n >= 1024 ? `${Math.round(n / 1024)} KB` : `${n} B`);

async function bytesOf(f: OutputFile): Promise<Blob | null> {
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

export default function OutputFiles({ files }: { files: OutputFile[] }) {
  const [busy, setBusy] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  if (!files.length) return null;

  const download = async (f: OutputFile) => {
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
              <span className="shrink-0 font-mono text-[10px] uppercase text-gray-400">{f.kind === "image" ? "img" : f.kind}</span>
              <span className="min-w-0 truncate font-medium text-gray-900 dark:text-white">{f.name}</span>
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
          </li>
        ))}
      </ul>
      {note && <p role="status" className="mt-2 text-xs text-amber-600 dark:text-amber-400">{note}</p>}
      <p className="mt-1.5 text-[11px] text-gray-400 dark:text-gray-500">Each file&apos;s fingerprint is in the receipt.</p>
    </div>
  );
}
