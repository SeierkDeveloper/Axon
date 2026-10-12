// The page a built site opens on.
//
// One address, /s/<the site's name>, answers with a page of two parts: a thin bar of Axon's own (what this is, who
// built it, and a way to report it) and under it the built page, sealed (./siteSeal). This page is the holder the
// seal needs: it is sent with a policy of its own that lets nothing be loaded into a frame, so the built page can
// never send itself anywhere. It is plain HTML written here, not a page of the app: nothing of the app's runs
// beside a built page.
//
// The built pages are handed to this page's own small script as data (never as markup of this page), and the script
// writes the one that opens into the frame. It also does the two things a sealed page cannot do for itself and may
// ask for: go to another page of the same site, and open a link to another site, which it only does after showing
// the visitor the address and being told yes.

import { getAgentById } from "./agents";
import { filesOf, getSite, REPORT_REASONS, type Site } from "./agentSites";
import { bundle, pagesOf } from "./siteBundle";
import { seal, SEAL_HOLDER_POLICY, SEAL_SANDBOX } from "./siteSeal";

/** Where a site opens, as a path on this server. */
export const sitePath = (siteId: string): string => `/s/${siteId}`;

/**
 * The policy this page is sent with. Its own script and style are inline and nothing else of it runs; it may talk to
 * this server (to send a report) and to nothing else; nothing may be loaded into a frame on it (the holder's part of
 * the seal) and nobody may frame it. The frame's document inherits this policy and then narrows it with its own.
 */
export const VIEWER_POLICY = [
  "default-src 'none'",
  "script-src 'unsafe-inline'",
  "style-src 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src data:",
  "media-src data: blob:",
  "connect-src 'self'",
  SEAL_HOLDER_POLICY,
  "frame-ancestors 'none'",
  "base-uri 'none'",
  "form-action 'none'",
].join("; ");

export const viewerHeaders = (): Record<string, string> => ({
  "Content-Type": "text/html; charset=utf-8",
  "Content-Security-Policy": VIEWER_POLICY,
  "X-Frame-Options": "DENY",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
  // what somebody had built is theirs to share, not a page of Axon's for a search index
  "X-Robots-Tag": "noindex, nofollow",
  "Cache-Control": "no-store",
});

const esc = (s: string): string => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
// data inside a <script> block: nothing in it may end the block or start a comment
const asData = (v: unknown): string => JSON.stringify(v).replace(/</g, "\\u003c").replace(/>/g, "\\u003e").replace(/&/g, "\\u0026").replace(/\u2028/g, "\\u2028").replace(/\u2029/g, "\\u2029");

const STYLE = `*{box-sizing:border-box}html,body{height:100%;margin:0}body{display:flex;flex-direction:column;background:#fff;color:#0a0a0a;font:14px/1.4 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif}
.bar{flex:none;display:flex;align-items:center;gap:10px;height:44px;padding:0 12px;border-bottom:1px solid #e4e4e7;background:#fff}
.bar a{color:inherit}.mark{display:flex;flex:none}.mark img{width:22px;height:22px;display:block}
.title{font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;min-width:0}
.by{margin-left:auto;color:#71717a;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;min-width:0}.by a{color:#0a0a0a;text-decoration:underline;text-underline-offset:2px}
button{font:inherit;color:#0a0a0a;background:#fff;border:1px solid #d4d4d8;border-radius:6px;padding:5px 10px;cursor:pointer;flex:none}button:hover{background:#f4f4f5}button.go{background:#0a0a0a;color:#fff;border-color:#0a0a0a}
.note{flex:none;display:flex;flex-wrap:wrap;align-items:center;gap:8px 10px;padding:10px 12px;border-bottom:1px solid #e4e4e7;background:#fafafa}
.note b{font-weight:600;word-break:break-all}.note .grow{flex:1 1 220px;min-width:0}
.rep .q{flex:1 1 100%;font-weight:600}.rep .opts{flex:1 1 100%;display:flex;flex-wrap:wrap;gap:8px 18px}.rep label{display:inline-flex;align-items:center;gap:6px;white-space:nowrap}.rep #rs{color:#71717a}
[hidden]{display:none!important}iframe{flex:1 1 auto;width:100%;border:0;display:block;background:#fff}
.gone{margin:auto;padding:24px;max-width:420px;text-align:center}.gone h1{font-size:20px;margin:0 0 8px}.gone p{color:#71717a;margin:0 0 16px}
.tag{flex:none;font-size:12px;color:#71717a;border:1px solid #d4d4d8;border-radius:999px;padding:2px 8px;white-space:nowrap}.by .short{display:none}@media (max-width:560px){.by .long{display:none}.by .short{display:inline}.rep .opts{flex-direction:column;gap:8px}}`;

// The holder's own script. It trusts nothing the frame says beyond the two requests below, and acts on an address
// only after the visitor has seen it and said yes.
const SCRIPT = `(function(){
var data=JSON.parse(document.getElementById("d").textContent),frame=document.getElementById("f"),now="index.html";
function show(page){var html=data.pages[page];if(!html)return false;now=page;frame.srcdoc=html;return true}
function resolve(from,ref){ref=String(ref).split(/[?#]/)[0];if(!ref||/^[a-z][a-z0-9+.-]*:/i.test(ref)||ref.indexOf("//")===0)return null;var parts=ref.charAt(0)==="/"?[]:from.split("/").slice(0,-1);ref.split("/").forEach(function(p){if(p===""||p===".")return;if(p==="..")parts.pop();else parts.push(p)});return parts.join("/")}
var strip=document.getElementById("o"),where=document.getElementById("ow"),pending=null,asked=0;
function close(){pending=null;strip.hidden=true}
addEventListener("message",function(e){
if(e.source!==frame.contentWindow||!e.data||typeof e.data!=="object")return;
if(e.data.axon==="go"){var to=resolve(now,e.data.page);if(to)show(to);return}
if(e.data.axon==="open"){var u;try{u=new URL(String(e.data.url))}catch(x){return}if(u.protocol!=="https:"&&u.protocol!=="http:")return;
if(pending||Date.now()-asked<1500)return;asked=Date.now();pending=u.href;where.textContent=u.host+(u.pathname.length>1?u.pathname:"");strip.hidden=false}
});
document.getElementById("oy").addEventListener("click",function(){var u=pending;close();if(u)window.open(u,"_blank","noopener,noreferrer")});
document.getElementById("on").addEventListener("click",close);
var box=document.getElementById("r"),said=document.getElementById("rs");
document.getElementById("rb").addEventListener("click",function(){box.hidden=!box.hidden});
document.getElementById("rn").addEventListener("click",function(){box.hidden=true});
document.getElementById("ry").addEventListener("click",function(){
var picked=document.querySelector('input[name="why"]:checked');if(!picked){said.textContent="Pick a reason.";return}
said.textContent="Sending";
fetch(data.report,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({reason:picked.value})}).then(function(res){return res.json().then(function(j){return{ok:res.ok,j:j}})}).then(function(x){
if(x.ok&&x.j.hidden){location.reload();return}
said.textContent=x.ok?"Thank you. It has been reported.":(x.j&&x.j.error&&x.j.error.message)||"That did not go through. Try again in a while."}).catch(function(){said.textContent="That did not go through. Try again in a while."});
});
show("index.html");
})();`;

const REASON_WORDS: Record<(typeof REPORT_REASONS)[number], string> = { scam: "A scam", impersonation: "Pretends to be someone else", harmful: "Harmful", illegal: "Illegal", other: "Something else" };

const page = (title: string, body: string, script = ""): string =>
  `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="noindex, nofollow"><title>${esc(title)}</title><link rel="icon" href="/favicon.ico"><style>${STYLE}</style></head><body>${body}${script}</body></html>`;

const MARK = `<a class="mark" href="/" aria-label="Axon"><img src="/favicon-32x32.png" alt="" width="22" height="22"></a>`;

/** What is shown where there is nothing to show: no such site, one with nothing built in it, or one taken down. */
export function goneHtml(what: "missing" | "down"): string {
  const [head, words] = what === "down"
    ? ["This page was taken down", "It was built by an agent on Axon and is no longer shown."]
    : ["Nothing is here", "This address does not lead to anything an agent built."];
  return page(`${head} · Axon`, `<header class="bar">${MARK}<span class="title">Axon</span></header><div class="gone"><h1>${head}</h1><p>${words}</p><a href="/">Go to Axon</a></div>`);
}

/** The page a built site opens on. `pages` are the site's pages, each already whole and sealed. */
export function viewerHtml(site: Pick<Site, "siteId" | "title" | "agentId">, pages: Record<string, string>, agentName: string, earlier?: number): string {
  const data = { pages, report: `/api/sites/${site.siteId}/report` };
  const reasons = REPORT_REASONS.map((r) => `<label><input type="radio" name="why" value="${r}">${esc(REASON_WORDS[r])}</label>`).join("");
  const body =
    `<header class="bar">${MARK}<span class="title">${esc(site.title)}</span>${earlier ? `<span class="tag">an earlier version, ${earlier}</span>` : ""}` +
    `<span class="by"><span class="long">Built by </span><span class="short">by </span><a href="/agents/${encodeURIComponent(site.agentId)}">${esc(agentName)}</a><span class="long"> on Axon</span></span>` +
    `<button id="rb" type="button">Report</button></header>` +
    `<div class="note" id="o" hidden><span class="grow">This page wants to open <b id="ow"></b></span><button class="go" id="oy" type="button">Open</button><button id="on" type="button">Stay</button></div>` +
    `<div class="note rep" id="r" hidden><span class="q">What is wrong with this page?</span><span class="opts">${reasons}</span><button class="go" id="ry" type="button">Send report</button><button id="rn" type="button">Close</button><span id="rs" role="status"></span></div>` +
    `<iframe id="f" sandbox="${SEAL_SANDBOX}" referrerpolicy="no-referrer" title="${esc(site.title)}"></iframe>` +
    `<script type="application/json" id="d">${asData(data)}</script>`;
  return page(`${site.title} · built on Axon`, body, `<script>${SCRIPT}</script>`);
}

export interface Viewed { status: 200 | 404 | 410; html: string }

/**
 * Everything the address answers with, for one site. `version` asks for one of its kept versions instead of the one
 * shown (the address with ?v=2): a look at an earlier one, which changes nothing about what the link shows.
 */
export function viewSite(siteId: string, version?: number): Viewed {
  const site = getSite(siteId);
  if (!site || site.version === 0) return { status: 404, html: goneHtml("missing") };
  if (site.status === "hidden") return { status: 410, html: goneHtml("down") };
  const earlier = version !== undefined && version !== site.version ? version : undefined;
  const files = filesOf(siteId, earlier);
  const pages: Record<string, string> = {};
  for (const name of pagesOf(files)) {
    const whole = bundle(files, name);
    if (whole !== null) pages[name] = seal(whole);
  }
  if (!pages["index.html"]) return { status: 404, html: goneHtml("missing") };
  return { status: 200, html: viewerHtml(site, pages, getAgentById(site.agentId)?.name ?? "an agent", earlier) };
}
