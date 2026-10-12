// How a built page is shown: sealed.
//
// What an agent builds is code somebody asked for in a sentence and nobody has read. So it is never a page of Axon's
// own. It is put in a frame that has an origin of its own, which it shares with nothing: it cannot read this site's
// cookies or storage, cannot call Axon as whoever is looking, and cannot move the window it sits in. And the document
// itself begins with a policy that lets it load and reach nothing but what is written inside it: no request to any
// server, no socket, no form sent anywhere, no frame of its own.
//
// One way out is left by those two, and a real browser found it (scripts/seal-selftest.ts): a framed page may always
// send ITSELF somewhere else, by a refresh tag or by setting its own address, and carry what it likes in that
// address. No policy inside the document can forbid that. The page that HOLDS the frame can: with frame-src 'none'
// nothing but the built document itself is ever loaded into the frame. So the seal has three parts, and a built
// page is only ever shown where all three are in force:
//
//   the frame's permissions            SEAL_SANDBOX
//   the document's own policy          SEAL_POLICY, put first by seal()
//   the policy of the page around it   SEAL_HOLDER_POLICY, sent as a header by the page that holds the frame
//
// These are constants here, and seal() is the one way a built document is turned into what goes in the frame.
// Nothing else in the code base may put built files in front of a browser.

/**
 * The frame's permissions: it may run its own script, and that is all. Not listed, and therefore refused: sharing our
 * origin, sending a form, opening a window, moving the page around it, asking for the pointer, downloads.
 */
export const SEAL_SANDBOX = "allow-scripts";

/**
 * What the sealed document may load: only what is inside it. Its own inline script and style, pictures and fonts
 * given as data, and nothing over the network at all.
 */
export const SEAL_POLICY = [
  "default-src 'none'",
  "script-src 'unsafe-inline'",
  "style-src 'unsafe-inline'",
  "img-src data: blob:",
  "font-src data:",
  "media-src data: blob:",
  "connect-src 'none'",
  "form-action 'none'",
  "base-uri 'none'",
  "frame-src 'none'",
  "child-src 'none'",
  "worker-src 'none'",
  "object-src 'none'",
  "manifest-src 'none'",
].join("; ");

/**
 * What the page that holds the frame must send, as part of its own Content-Security-Policy header: nothing may be
 * loaded into a frame on it. The built document is written into the frame, not loaded, so it is still shown; what
 * stops is the frame going anywhere else afterwards.
 */
export const SEAL_HOLDER_POLICY = "frame-src 'none'";

const POLICY_TAG = `<meta http-equiv="Content-Security-Policy" content="${SEAL_POLICY}">`;

/**
 * A sealed page cannot go anywhere, so a link in it would do nothing, and even a link to a place on the same page
 * counts as going somewhere and would blank the frame (a real browser showed that: scripts/seal-selftest.ts). This
 * small script, put in right after the policy, takes every click on a link: a place on the same page is scrolled to;
 * a link to another site is handed to the page that holds the frame, which offers it to the visitor with its address
 * shown and opens it only if they say so; a link to another page of the same site is handed over too, and the holder
 * swaps the page. The built page can do the same asking itself, or take this script out: either way the holder
 * decides, and it only ever acts on a click of the visitor's own.
 */
export const SEAL_LINKS = `<script>(function(){document.addEventListener("click",function(e){var t=e.target;var a=t&&t.closest?t.closest("a[href]"):null;if(!a)return;var h=a.getAttribute("href")||"";e.preventDefault();if(h.charAt(0)==="#"){var n=h.slice(1);try{n=decodeURIComponent(n)}catch(x){}var el=n?document.getElementById(n)||document.getElementsByName(n)[0]:null;if(el&&el.scrollIntoView)el.scrollIntoView();else if(!n)scrollTo(0,0);return}try{parent.postMessage(/^https?:\\/\\//i.test(h)?{axon:"open",url:a.href}:{axon:"go",page:h},"*")}catch(x){}},true)})();</script>`;

/**
 * A sealed page cannot send a form either: in the frame a form does nothing at all when it is sent (a real browser
 * showed that it does not even say it was: scripts/seal-selftest.ts). So a form that is meant to collect answers says
 * so, with the attribute data-collect, and this script takes it when the visitor presses its button or Enter in one
 * of its fields: the form's own checks run (a required field left empty stops it there), then its fields are handed
 * to the page that holds the frame, which shows the visitor what is about to go and to whom, and sends it on only if
 * they say yes (./siteViewer, ./siteAnswers). The form waits meanwhile, and is told how it went: the event
 * "axon:sent" or "axon:notsent" is raised on it, and unless the page handles that itself the form is cleared and a
 * line under it says so (or, where the page has an element marked data-after-send, that is shown in its place).
 * A form without the mark is left alone: its buttons are the page's own. Files are not sent. A page that calls the
 * holder itself, or takes this script out, gains nothing: the holder asks the visitor every time and sends only what
 * they were shown.
 */
export const SEAL_FORMS = `<script>(function(){var n=0,wait={};function line(f,t,bad){var p=f.parentNode?f.parentNode.querySelector("[data-axon-said]"):null;if(!p){p=document.createElement("p");p.setAttribute("data-axon-said","");p.setAttribute("role","status");if(f.parentNode)f.parentNode.insertBefore(p,f.nextSibling)}p.textContent=t;p.style.color=bad?"#b91c1c":""}function lock(f,on){var b=f.querySelectorAll("button,input[type=submit]");for(var i=0;i<b.length;i++)b[i].disabled=on;if(on)f.setAttribute("aria-busy","true");else f.removeAttribute("aria-busy")}function send(f){if(!f||f.tagName!=="FORM"||!f.hasAttribute("data-collect")||f.getAttribute("aria-busy"))return;if(f.reportValidity&&!f.reportValidity())return;var fields=[],d;try{d=new FormData(f)}catch(x){return}d.forEach(function(v,k){if(typeof v==="string")fields.push([String(k),v])});var id=++n;wait[id]=f;lock(f,true);try{parent.postMessage({axon:"form",id:id,form:f.getAttribute("name")||f.id||"form",fields:fields},"*")}catch(x){delete wait[id];lock(f,false)}}function marked(f){return f&&f.tagName==="FORM"&&f.hasAttribute("data-collect")}document.addEventListener("submit",function(e){if(!marked(e.target))return;e.preventDefault();send(e.target)},true);document.addEventListener("click",function(e){var t=e.target,b=t&&t.closest?t.closest("button,input[type=submit],input[type=image]"):null;if(!b||b.disabled||!marked(b.form))return;var ty=(b.getAttribute("type")||"").toLowerCase();if(b.tagName==="BUTTON"&&ty&&ty!=="submit")return;e.preventDefault();send(b.form)},true);document.addEventListener("keydown",function(e){if(e.key!=="Enter"||e.isComposing)return;var t=e.target;if(!t||t.tagName!=="INPUT"||!marked(t.form))return;if(/^(button|submit|reset|checkbox|radio|file|image|range|color)$/.test((t.type||"text").toLowerCase()))return;e.preventDefault();send(t.form)},true);addEventListener("message",function(e){if(e.source!==parent||!e.data||e.data.axon!=="form-result")return;var f=wait[e.data.id];if(!f)return;delete wait[e.data.id];lock(f,false);var ok=!!e.data.ok,why=String(e.data.why||""),ev=null;try{ev=new CustomEvent(ok?"axon:sent":"axon:notsent",{bubbles:true,cancelable:true,detail:{why:why}})}catch(x){}if(ev&&!f.dispatchEvent(ev))return;if(ok){f.reset();var after=document.querySelector("[data-after-send]");if(after){after.hidden=false;after.style.display="";f.hidden=true}else line(f,"Sent. Thank you.")}else if(why)line(f,why,true)})})();</script>`;

/**
 * The document as it goes into the frame: the policy first, before anything the agent wrote, so that nothing in the
 * built page is read by the browser ahead of it. A byte-order mark and the page's own doctype are taken off the front
 * so the policy really is first; a policy or refresh tag of the page's own is never trusted to be absent (the store
 * refuses them), and if one is there it can only narrow what ours allows.
 */
export function seal(html: string): string {
  const body = html.replace(/^\uFEFF/, "").replace(/^\s*<!doctype[^>]*>/i, "");
  return `<!doctype html>${POLICY_TAG}${SEAL_LINKS}${SEAL_FORMS}${body}`;
}

/** The attributes of the frame a sealed document is shown in, for whichever component draws it. */
export const SEAL_FRAME = { sandbox: SEAL_SANDBOX, referrerPolicy: "no-referrer", loading: "lazy" } as const;
