"use client";

import { useEffect, useRef, useState } from "react";

/**
 * Files for a hire: a button and a drop target that upload each file as it is chosen, and the list of what is
 * attached. It shows nothing at all until the server says files are on, so a page that includes it is unchanged
 * while the feature is off.
 */

export interface Attached { id: string; token: string; name: string; size: number; kind: "pdf" | "image" | "text" }
interface Limits {
  maxBytes: number;
  imageMaxBytes: number;
  perHire: { free: { files: number; bytes: number; pdfPages: number }; paid: { files: number; bytes: number; pdfPages: number } };
  reads?: { text: boolean; pdf: boolean; image: boolean; why: string | null };
}

const size = (n: number) => (n >= 1048576 ? `${(n / 1048576).toFixed(1)} MB` : n >= 1024 ? `${Math.round(n / 1024)} KB` : `${n} B`);
const ACCEPT = ".pdf,.png,.jpg,.jpeg,.gif,.webp,.txt,.md,.csv,.tsv,.json,application/pdf,image/png,image/jpeg,image/gif,image/webp,text/plain,text/markdown,text/csv,application/json";

export default function FileAttach({ agentId, paid, files, onChange, disabled, apiKey }: {
  agentId: string;
  paid: boolean;
  files: Attached[];
  onChange: (next: Attached[]) => void;
  disabled?: boolean;
  /** when the visitor is signed in, their files belong to their wallet */
  apiKey?: string | null;
}) {
  const [limits, setLimits] = useState<Limits | null>(null);
  const [busy, setBusy] = useState(0);
  const [note, setNote] = useState<string | null>(null);
  const [over, setOver] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  // the list as it stands right now, for uploads that finish one after another
  const current = useRef(files);
  useEffect(() => { current.current = files; }, [files]);

  useEffect(() => {
    let alive = true;
    fetch(`/api/files?agent=${encodeURIComponent(agentId)}`).then((r) => (r.ok ? (r.json() as Promise<Limits>) : null)).then((d) => { if (alive) setLimits(d); }).catch(() => {});
    return () => { alive = false; };
  }, [agentId]);

  if (!limits) return null;
  const cap = paid ? limits.perHire.paid : limits.perHire.free;
  const reads = limits.reads ?? { text: true, pdf: true, image: true, why: null };

  const add = async (list: FileList | File[]) => {
    setNote(null);
    for (const f of Array.from(list)) {
      if (current.current.length >= cap.files) { setNote(`${paid ? "A hire" : "A free hire"} carries at most ${cap.files} files.`); break; }
      if (f.size > limits.maxBytes) { setNote(`${f.name} is ${size(f.size)}. A file is at most ${size(limits.maxBytes)}.`); continue; }
      setBusy((n) => n + 1);
      try {
        const body = new FormData();
        body.append("file", f);
        const r = await fetch("/api/files", { method: "POST", body, headers: apiKey ? { authorization: `Bearer ${apiKey}` } : undefined });
        const d = (await r.json().catch(() => ({}))) as { file?: { id: string; name: string; size: number; kind: Attached["kind"] }; fileToken?: string; error?: string };
        if (!r.ok || !d.file || !d.fileToken) { setNote(d.error ?? `${f.name} could not be uploaded.`); continue; }
        if ((d.file.kind === "pdf" && !reads.pdf) || (d.file.kind === "image" && !reads.image)) {
          setNote(`${d.file.name}: ${reads.why ?? "this agent cannot read that kind of file."}`);
          void fetch(`/api/files/${d.file.id}`, { method: "DELETE", headers: { "x-file-token": d.fileToken } }).catch(() => {});
          continue;
        }
        const next = [...current.current, { id: d.file.id, token: d.fileToken, name: d.file.name, size: d.file.size, kind: d.file.kind }];
        current.current = next;
        onChange(next);
      } catch {
        setNote(`${f.name} could not be uploaded. Check your connection and try again.`);
      } finally {
        setBusy((n) => n - 1);
      }
    }
  };

  const remove = (f: Attached) => {
    const next = current.current.filter((x) => x.id !== f.id);
    current.current = next;
    onChange(next);
    void fetch(`/api/files/${f.id}`, { method: "DELETE", headers: { "x-file-token": f.token } }).catch(() => {});
  };

  const full = files.length >= cap.files;
  return (
    <div
      className={`mt-2 rounded-md border border-dashed px-3 py-2 transition-colors ${over ? "border-teal-400 bg-teal-50/60 dark:bg-teal-950/20" : "border-gray-200 dark:border-gray-700"}`}
      onDragOver={(e) => { if (!disabled && !full) { e.preventDefault(); setOver(true); } }}
      onDragLeave={() => setOver(false)}
      onDrop={(e) => { e.preventDefault(); setOver(false); if (!disabled && !full && e.dataTransfer.files.length) void add(e.dataTransfer.files); }}
    >
      {files.length > 0 && (
        <ul className="mb-2 flex flex-wrap gap-2">
          {files.map((f) => (
            <li key={f.id} className="flex max-w-full items-center gap-2 rounded-md border border-gray-200 bg-gray-50 py-1 pl-2.5 pr-1 text-xs dark:border-gray-700 dark:bg-gray-800">
              <span className="font-mono text-[10px] uppercase text-gray-400">{f.kind === "image" ? "img" : f.kind}</span>
              <span className="truncate text-gray-900 dark:text-white">{f.name}</span>
              <span className="shrink-0 tabular-nums text-gray-400">{size(f.size)}</span>
              <button type="button" onClick={() => remove(f)} disabled={disabled} aria-label={`Remove ${f.name}`} className="shrink-0 rounded px-1.5 py-0.5 text-gray-400 hover:bg-gray-200 hover:text-gray-900 disabled:opacity-50 dark:hover:bg-gray-700 dark:hover:text-white">×</button>
            </li>
          ))}
        </ul>
      )}
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <input ref={input} type="file" multiple accept={ACCEPT} className="hidden" onChange={(e) => { if (e.target.files?.length) void add(e.target.files); e.target.value = ""; }} />
        <button type="button" onClick={() => input.current?.click()} disabled={disabled || full || busy > 0} className="rounded-md border border-gray-200 px-2.5 py-1 text-xs font-medium text-gray-700 transition-colors hover:border-gray-400 disabled:opacity-50 dark:border-gray-700 dark:text-gray-200 dark:hover:border-gray-500">
          {busy > 0 ? "Uploading…" : files.length ? "Add another file" : "Attach a file"}
        </button>
        <span className="text-[11px] text-gray-400 dark:text-gray-500">
          {reads.pdf && reads.image ? "PDF, picture or text file" : "Text files (text, Markdown, CSV, JSON)"}, up to {cap.files} and {size(cap.bytes)} together. Or drop it here.
        </span>
      </div>
      {note && <p role="status" className="mt-2 text-xs text-amber-600 dark:text-amber-400">{note}</p>}
    </div>
  );
}
