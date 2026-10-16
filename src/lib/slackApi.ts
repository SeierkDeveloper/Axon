// Talking to Slack's Web API with the owner's own token.
//
// Only the few calls the agents need: the channels in the workspace, recent messages in one, people's names, and
// posting a message. Every refusal Slack sends back is turned into plain words for the owner and the agent, with a
// kind that says what can be done about it:
//
//   auth     the token was revoked, or the owner removed Axon: only connecting again helps
//   expired  the token ran out: it is renewed and the call tried once more
//   scope    Slack did not grant what the call needs
//   channel  no such channel, not a member, archived, not allowed to post there
//   rate     Slack asked Axon to slow down; retryAfterS says for how long
//   down     Slack could not be reached or had trouble of its own; worth trying again
//   input    the message itself (too long, empty)
//
// No function here logs a token or lets one into an error. What Slack sends back is never put into an error as it is:
// only its short error code, when it looks like one.

type Fetch = typeof fetch;

const SLACK_API = "https://slack.com/api";
const TIMEOUT_MS = 15_000;

export type SlackErrorKind = "auth" | "expired" | "scope" | "channel" | "rate" | "down" | "input" | "other";

export class SlackError extends Error {
  constructor(message: string, public code: string, public kind: SlackErrorKind, public retryAfterS: number | null = null) {
    super(message);
    this.name = "SlackError";
  }
  /** Worth trying again later, with nothing changed. */
  get transient(): boolean {
    return this.kind === "rate" || this.kind === "down";
  }
}

export interface SlackDeps { fetch?: Fetch }

const AUTH = new Set(["invalid_auth", "not_authed", "token_revoked", "account_inactive", "no_permission", "org_login_required", "ekm_access_denied", "team_access_not_granted", "two_factor_setup_required", "user_removed_from_team"]);
const DOWN = new Set(["fatal", "internal_error", "service_unavailable", "request_timeout"]);
const NOT_HERE = new Set(["restricted_action", "restricted_action_read_only_channel", "restricted_action_thread_only_channel", "restricted_action_non_threadable_channel", "cant_post", "posting_to_general_channel_denied", "access_denied"]);

/** Slack's error code in plain words. `where` is the channel as people know it ("#team"), when there is one. */
export function slackRefusal(code: string, where?: string | null, retryAfterS: number | null = null): SlackError {
  const c = /^[a-z0-9_]{1,64}$/.test(code) ? code : "refused";
  const at = where || "that channel";
  if (AUTH.has(c)) return new SlackError("Slack no longer lets Axon in for you: the connection was removed in Slack or its sign-in was revoked. Connect Slack again on your dashboard.", c, "auth");
  if (c === "token_expired") return new SlackError("The Slack sign-in ran out and could not be renewed. Connect Slack again on your dashboard.", c, "expired");
  if (c === "missing_scope") return new SlackError("Slack has not given Axon permission for that. Connect Slack again on your dashboard to grant it.", c, "scope");
  if (c === "channel_not_found") return new SlackError(`There is no channel ${where ? `called ${where} ` : ""}that you can see in Slack. Public channels only.`, c, "channel");
  if (c === "not_in_channel") return new SlackError(`You are not in ${at}. Join it in Slack first, then try again.`, c, "channel");
  if (c === "is_archived") return new SlackError(`${at} is archived in Slack.`, c, "channel");
  if (NOT_HERE.has(c)) return new SlackError(`Your Slack workspace does not let you post in ${at}.`, c, "channel");
  if (c === "msg_too_long") return new SlackError("The message is too long for Slack.", c, "input");
  if (c === "no_text") return new SlackError("The message is empty.", c, "input");
  if (c === "ratelimited") return new SlackError(`Slack asked Axon to slow down. Try again in ${retryAfterS ?? 60} seconds.`, c, "rate", retryAfterS ?? 60);
  if (DOWN.has(c)) return new SlackError("Slack is having trouble right now. Try again in a minute.", c, "down");
  return new SlackError(`Slack said no (${c}).`, c, "other");
}

type Params = Record<string, string | number | boolean | undefined>;

/** One Web API call. Throws a SlackError in plain words for anything but a yes. */
export async function slackCall(token: string, method: string, params: Params, deps: SlackDeps = {}, where?: string | null): Promise<Record<string, unknown>> {
  const body = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined) body.set(k, String(v));
  let res: Response;
  try {
    res = await (deps.fetch ?? fetch)(`${SLACK_API}/${method}`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/x-www-form-urlencoded; charset=utf-8" },
      body: body.toString(),
      signal: AbortSignal.timeout(TIMEOUT_MS),
      redirect: "error",
    });
  } catch {
    throw new SlackError("Slack could not be reached. Try again in a minute.", "unreachable", "down");
  }
  if (res.status === 429) {
    const after = Number(res.headers.get("retry-after"));
    throw slackRefusal("ratelimited", where, Number.isFinite(after) && after > 0 ? Math.ceil(after) : 60);
  }
  if (res.status >= 500) throw slackRefusal("service_unavailable", where);
  const json = (await res.json().catch(() => null)) as Record<string, unknown> | null;
  if (!json || typeof json !== "object") throw slackRefusal("fatal", where);
  if (json.ok !== true) throw slackRefusal(typeof json.error === "string" ? json.error : "refused", where);
  return json;
}

const str = (v: unknown): string => (typeof v === "string" ? v : "");
const obj = (v: unknown): Record<string, unknown> => (v && typeof v === "object" ? (v as Record<string, unknown>) : {});

export interface SlackChannel { id: string; name: string; isMember: boolean; topic: string; members: number | null }

const toChannel = (c: Record<string, unknown>): SlackChannel => ({
  id: str(c.id),
  name: str(c.name),
  isMember: c.is_member === true,
  topic: str(obj(c.topic).value).slice(0, 200),
  members: typeof c.num_members === "number" ? c.num_members : null,
});

/** The workspace's public channels that are not archived, up to `max`. */
export async function listChannels(token: string, deps: SlackDeps = {}, max = 600): Promise<SlackChannel[]> {
  const out: SlackChannel[] = [];
  let cursor = "";
  for (let page = 0; page < 5 && out.length < max; page++) {
    const r = await slackCall(token, "conversations.list", { types: "public_channel", exclude_archived: true, limit: 200, ...(cursor ? { cursor } : {}) }, deps);
    for (const c of Array.isArray(r.channels) ? r.channels : []) {
      const ch = toChannel(obj(c));
      if (ch.id && ch.name) out.push(ch);
    }
    cursor = str(obj(r.response_metadata).next_cursor);
    if (!cursor) break;
  }
  return out.slice(0, max);
}

/** A channel id as Slack writes one. */
export const isChannelId = (s: string): boolean => /^[CG][A-Z0-9]{6,20}$/.test(s);
/** How people write a channel: "#team", "team" or a link to it; reduced to its name, lowercase. */
export const channelName = (s: string): string => s.trim().replace(/^#/, "").toLowerCase();

/** The channel someone means: by its id, or by its name with or without "#". Throws when there is none. */
export async function findChannel(token: string, ref: string, deps: SlackDeps = {}): Promise<SlackChannel> {
  const raw = String(ref ?? "").trim();
  if (!raw) throw new SlackError("Say which channel.", "no_channel", "input");
  if (isChannelId(raw)) {
    const r = await slackCall(token, "conversations.info", { channel: raw }, deps, raw);
    return toChannel(obj(r.channel));
  }
  const want = channelName(raw);
  const found = (await listChannels(token, deps)).find((c) => c.name.toLowerCase() === want);
  if (!found) throw slackRefusal("channel_not_found", `#${want}`);
  return found;
}

export interface SlackMessage { ts: string; user: string | null; name: string | null; text: string; subtype: string | null }

/** The newest messages in a channel, newest first, at most `limit` (1 to 100). */
export async function history(token: string, channel: SlackChannel, limit: number, deps: SlackDeps = {}): Promise<SlackMessage[]> {
  const r = await slackCall(token, "conversations.history", { channel: channel.id, limit: Math.max(1, Math.min(100, Math.floor(limit))) }, deps, `#${channel.name}`);
  return (Array.isArray(r.messages) ? r.messages : []).map((m) => {
    const x = obj(m);
    return { ts: str(x.ts), user: str(x.user) || null, name: str(x.username) || str(obj(x.bot_profile).name) || null, text: str(x.text), subtype: str(x.subtype) || null };
  });
}

/** People's names for their ids, as Slack shows them. Ids it cannot name are left out; never throws for one. */
export async function userNames(token: string, ids: string[], deps: SlackDeps = {}, max = 25): Promise<Map<string, string>> {
  const names = new Map<string, string>();
  for (const id of [...new Set(ids)].slice(0, max)) {
    try {
      const u = obj((await slackCall(token, "users.info", { user: id }, deps)).user);
      const p = obj(u.profile);
      const name = str(p.display_name) || str(p.real_name) || str(u.real_name) || str(u.name);
      if (name) names.set(id, name);
    } catch (err) {
      // a revoked token or a busy Slack is the caller's to hear about; one person without a name is not
      if (err instanceof SlackError && (err.kind === "auth" || err.kind === "rate" || err.kind === "expired")) throw err;
    }
  }
  return names;
}

/**
 * Broadcast mentions (@channel, @here, @everyone) are written out as plain words, so a post never pings a whole
 * channel. Done when the message is made, so what the owner reads is exactly what goes out.
 */
export const quietMentions = (text: string): string => text.replace(/<!(channel|here|everyone)(\|[^>]*)?>/gi, "@$1");

/** Post a message in a channel as the owner. Returns where it is. */
export async function postMessage(token: string, channel: { id: string; label: string }, text: string, deps: SlackDeps = {}): Promise<{ channel: string; ts: string }> {
  const r = await slackCall(token, "chat.postMessage", { channel: channel.id, text, unfurl_links: false }, deps, channel.label);
  return { channel: str(r.channel) || channel.id, ts: str(r.ts) };
}

/** A link to a message, or null when Slack does not give one. Never throws. */
export async function permalink(token: string, channel: string, ts: string, deps: SlackDeps = {}): Promise<string | null> {
  try {
    const link = str((await slackCall(token, "chat.getPermalink", { channel, message_ts: ts }, deps)).permalink);
    return /^https:\/\/[a-z0-9-]+\.slack\.com\//i.test(link) ? link : null;
  } catch {
    return null;
  }
}
