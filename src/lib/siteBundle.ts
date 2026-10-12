// A built site as one document.
//
// A sealed page can load nothing over the network, not even its own style sheet (./siteSeal). So before a site is
// shown, each of its pages is made whole: the style sheets, scripts and pictures it names from its own files are
// written into it. What it names that is NOT one of its files is left as it stands, and the seal refuses it.
//
// This only ever copies a site's own bytes into its own page. It adds nothing and reads nothing else.

import type { SiteFile } from "./agentSites";

type Files = ReadonlyMap<string, SiteFile>;

/** A name a page uses for another file, as that file's place in the site; null when it points anywhere else. */
export function resolve(from: string, ref: string): string | null {
  const raw = ref.trim().split(/[?#]/)[0];
  if (!raw || /^[a-z][a-z0-9+.-]*:/i.test(raw) || raw.startsWith("//")) return null;
  const parts = raw.startsWith("/") ? [] : from.split("/").slice(0, -1);
  for (const p of raw.split("/")) {
    if (p === "" || p === ".") continue;
    if (p === "..") { if (!parts.length) return null; parts.pop(); continue; }
    parts.push(p);
  }
  return parts.join("/") || null;
}

const dataUri = (f: SiteFile): string => `data:${f.mime};base64,${f.content.toString("base64")}`;
// text put inside a <script> or <style> must not end it early
const inScript = (s: string): string => s.replace(/<\/script/gi, "<\\/script").replace(/<!--/g, "<\\!--");
const inStyle = (s: string): string => s.replace(/<\/style/gi, "<\\/style");
const attr = (tag: string, name: string): string | null => {
  const m = new RegExp(`\\b${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, "i").exec(tag);
  return m ? (m[1] ?? m[2] ?? m[3] ?? "") : null;
};

/** A style sheet with the pictures it names from the site written into it. */
function css(text: string, from: string, files: Files): string {
  return text.replace(/url\(\s*(?:"([^"]*)"|'([^']*)'|([^)\s]+))\s*\)/gi, (whole, a, b, c) => {
    const to = resolve(from, a ?? b ?? c ?? "");
    const f = to ? files.get(to) : undefined;
    return f && f.mime.startsWith("image/") ? `url("${dataUri(f)}")` : whole;
  });
}

/**
 * One page of a site, whole: every style sheet, script and picture it names from the site's own files is inside it.
 * Returns null when the site has no such page.
 */
export function bundle(list: readonly SiteFile[], page = "index.html"): string | null {
  const files: Files = new Map(list.map((f) => [f.path, f]));
  const entry = files.get(page);
  if (!entry || entry.mime !== "text/html") return null;
  let html = entry.content.toString("utf8");
  const own = (ref: string | null, kind: (f: SiteFile) => boolean): SiteFile | null => {
    const to = ref === null ? null : resolve(page, ref);
    const f = to ? files.get(to) : undefined;
    return f && kind(f) ? f : null;
  };
  // <link rel="stylesheet" href="style.css"> becomes the style sheet itself
  html = html.replace(/<link\b[^>]*>/gi, (tag) => {
    if (!/\brel\s*=\s*["']?[^"'>]*\bstylesheet\b/i.test(tag)) {
      // an icon from the site's own files is written in; any other link is left
      const icon = /\brel\s*=\s*["']?[^"'>]*\bicon\b/i.test(tag) ? own(attr(tag, "href"), (f) => f.mime.startsWith("image/")) : null;
      return icon ? tag.replace(/\bhref\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/i, `href="${dataUri(icon)}"`) : tag;
    }
    const f = own(attr(tag, "href"), (x) => x.mime === "text/css");
    return f ? `<style>${inStyle(css(f.content.toString("utf8"), f.path, files))}</style>` : tag;
  });
  // <script src="app.js"></script> becomes the script itself
  html = html.replace(/<script\b([^>]*)>\s*<\/script>/gi, (tag, attrs: string) => {
    const f = own(attr(`<script ${attrs}>`, "src"), (x) => x.mime === "text/javascript");
    if (!f) return tag;
    const rest = attrs.replace(/\bsrc\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/i, "").replace(/\s+/g, " ").trim();
    return `<script${rest ? ` ${rest}` : ""}>${inScript(f.content.toString("utf8"))}</script>`;
  });
  // pictures by name become the pictures themselves
  html = html.replace(/<(img|source|image|use|video|audio)\b[^>]*>/gi, (tag) =>
    tag.replace(/\b(src|href|xlink:href|poster)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/gi, (whole, name: string, a, b, c) => {
      const f = own(a ?? b ?? c ?? "", (x) => x.mime.startsWith("image/"));
      return f ? `${name}="${dataUri(f)}"` : whole;
    }),
  );
  // and the ones a page's own <style> blocks and style="" name
  html = html.replace(/(<style\b[^>]*>)([\s\S]*?)(<\/style>)/gi, (_w, open: string, body: string, close: string) => `${open}${css(body, page, files)}${close}`);
  html = html.replace(/\bstyle\s*=\s*"([^"]*)"/gi, (whole, body: string) => (/url\(/i.test(body) ? `style="${css(body.replace(/&quot;/g, "'"), page, files).replace(/"/g, "'")}"` : whole));
  return html;
}

/** The pages of a site: every html file, the one that opens first. */
export function pagesOf(list: readonly SiteFile[]): string[] {
  const pages = list.filter((f) => f.mime === "text/html").map((f) => f.path);
  return pages.sort((a, b) => (a === "index.html" ? -1 : b === "index.html" ? 1 : a < b ? -1 : 1));
}
