// Agents that build: take it with you.
//
// What an agent built for somebody is theirs. Besides the link on Axon they can have the files themselves, in one
// archive: the page as the agent wrote it (not the sealed copy the link shows), in a folder that opens in a browser
// by itself and can be put on any place that serves files. Nothing in it depends on Axon.
//
// With the files comes a short note in plain words: what is in the folder, how to look at it, how to put it on the
// web, and the one thing that does stay behind: a form on the page collects answers only at its link on Axon.

import { getAgentById } from "./agents";
import { filesOf, getSite, versionsOf } from "./agentSites";
import { COLLECTS } from "./siteAnswers";
import { zipWrite } from "./zip";

/** A name for a folder or a file, from what the page is called. */
export const slugOf = (title: string): string => title.normalize("NFKD").replace(/[̀-ͯ]/g, "").replace(/[^a-z0-9]+/gi, "-").replace(/^-+|-+$/g, "").toLowerCase().slice(0, 60) || "page";

export interface SiteArchive { name: string; bytes: Buffer; version: number; files: number }

/** The note that goes with the files. */
export function readme(a: { title: string; agentName: string; version: number; keptAt: string; link: string; sha256: string; names: string[]; form: boolean }): string {
  const lines = [
    a.title,
    "",
    `Built by ${a.agentName} on Axon. This is version ${a.version}, kept on ${a.keptAt.slice(0, 10)}.`,
    a.link ? `Its link on Axon: ${a.link}` : "",
    "",
    "WHAT IS HERE",
    `index.html is the page that opens.${a.names.length > 1 ? ` The other files (${a.names.filter((n) => n !== "index.html").join(", ")}) are what it uses: its style, its script, its pictures.` : ""}`,
    "",
    "TO LOOK AT IT",
    "Open index.html in a browser.",
    "",
    "TO PUT IT ON THE WEB",
    "Upload this folder as it is to any place that serves files. It needs nothing else: no server code, no database, no account.",
    ...(a.form ? ["", "THE FORM", "The form on this page collects answers only at its link on Axon, where they are listed for whoever had the page built. Opened from these files, the form sends nothing."] : []),
    "",
    `Fingerprint of this version: ${a.sha256}`,
    "",
  ];
  return lines.filter((l, i, all) => !(l === "" && all[i - 1] === "")).join("\r\n");
}

/**
 * The files of a site in one archive, with the note. `version` asks for one of its kept versions instead of the one
 * shown. Null when there is no such site or version, or nothing in it.
 */
export function siteZip(siteId: string, o: { version?: number; origin?: string } = {}): SiteArchive | null {
  const site = getSite(siteId);
  if (!site || site.version === 0) return null;
  const version = o.version ?? site.version;
  const kept = versionsOf(siteId).find((v) => v.version === version);
  const files = kept ? filesOf(siteId, version) : [];
  if (!kept || !files.length) return null;
  const folder = slugOf(site.title);
  const origin = (o.origin ?? "").replace(/\/+$/, "");
  const note = readme({
    title: site.title, agentName: getAgentById(site.agentId)?.name ?? "an agent", version, keptAt: kept.createdAt, link: origin ? `${origin}/s/${site.siteId}` : "", sha256: kept.sha256,
    names: files.map((f) => f.path), form: files.some((f) => f.mime === "text/html" && COLLECTS.test(f.content.toString("utf8"))),
  });
  // the page that opens first, then the rest by name, then the note
  const ordered = [...files].sort((a, b) => (a.path === "index.html" ? -1 : b.path === "index.html" ? 1 : a.path < b.path ? -1 : 1));
  const bytes = zipWrite([...ordered.map((f) => ({ name: `${folder}/${f.path}`, data: f.content })), { name: `${folder}/README.txt`, data: note }], { deflate: true, at: new Date(kept.createdAt) });
  return { name: `${folder}-v${version}.zip`, bytes, version, files: files.length };
}
