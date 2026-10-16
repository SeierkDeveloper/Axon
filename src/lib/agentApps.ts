// Agents that work in your apps.
//
// An owner connects an app once (GitHub, Notion, Slack, Google Docs, Gmail) and says, per agent, what each agent they
// hire may do there: read, write a draft, publish or send. Anything that publishes or sends waits for the owner's OK
// with a preview of exactly what would go out; nothing is sent without it.
//
// What holds it:
//
//   A token an app hands back is sealed the moment it arrives (./appTokens) and opened only inside withAppToken, for
//   the one call that needs it. No route answers with one, no log line carries one, no receipt mentions one.
//
//   Signing in with an app is OAuth 2.0 with PKCE and a signed, ten-minute state bound to the owner who started it
//   and to the browser they started it in (./appConnect).
//
//   An agent the owner has said nothing about may read and write drafts and nothing more. Publishing or sending needs
//   the owner to allow it for that agent, and then the owner's OK on each one. An OK lasts 24 hours and is carried
//   out once (./appPermissions). Every request and decision is on the job's receipt.
//
// The internal API the app phases call: canDo, requestApproval, takeApproved, withAppToken.
//
// AGENT_APPS=on switches it on. Off (the default) every route answers as if it did not exist and nothing is shown.

export { appsEnabled } from "./appRegistry";
export { canDo, requestApproval, takeApproved, approvalStatus } from "./appPermissions";
export { withAppToken } from "./appConnect";
