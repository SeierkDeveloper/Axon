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
 * The document as it goes into the frame: the policy first, before anything the agent wrote, so that nothing in the
 * built page is read by the browser ahead of it. A byte-order mark and the page's own doctype are taken off the front
 * so the policy really is first; a policy or refresh tag of the page's own is never trusted to be absent (the store
 * refuses them), and if one is there it can only narrow what ours allows.
 */
export function seal(html: string): string {
  const body = html.replace(/^﻿/, "").replace(/^\s*<!doctype[^>]*>/i, "");
  return `<!doctype html>${POLICY_TAG}${body}`;
}

/** The attributes of the frame a sealed document is shown in, for whichever component draws it. */
export const SEAL_FRAME = { sandbox: SEAL_SANDBOX, referrerPolicy: "no-referrer", loading: "lazy" } as const;
