"use client";

import { useState } from "react";

// What an agent built in a job, under its answer: what it is called, the address it opens at, and the two things
// to do with that address. The built page itself is never shown here: it opens on its own address, sealed.

export interface Built { siteId: string; title: string; version: number; url: string }

/** The address as it reads: without the scheme. */
const shown = (url: string): string => url.replace(/^https?:\/\//i, "");

export default function BuiltSite({ site }: { site: Built | null | undefined }) {
  const [copied, setCopied] = useState(false);
  if (!site?.url) return null;
  const full = site.url.startsWith("/") && typeof window !== "undefined" ? `${window.location.origin}${site.url}` : site.url;
  const copy = async () => {
    try { await navigator.clipboard.writeText(full); setCopied(true); setTimeout(() => setCopied(false), 1600); } catch { /* the address is on the page to copy by hand */ }
  };
  return (
    <div className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-2 rounded-md border border-gray-200 bg-white p-3 dark:border-gray-800 dark:bg-gray-900/40">
      <div className="min-w-0 flex-1 basis-48">
        <p className="text-[11px] font-semibold uppercase tracking-wider text-gray-400 dark:text-gray-500">{site.version > 1 ? `Built, version ${site.version}` : "Built"}</p>
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
  );
}
