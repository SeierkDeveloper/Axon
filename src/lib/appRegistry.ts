// The apps an owner can connect, and how each one signs in.
//
// Each app is described once: where its sign-in page and token endpoint are, the scopes each kind of action needs
// (said in plain words for the owner too), how it is told a connection was removed, and the names of the environment
// variables holding Axon's client id and secret for it. An app whose client id or secret is not set shows as "Coming
// soon" and cannot be started.
//
// Three kinds of action, the same for every app:
//   read     look at what is there
//   draft    make something new that nobody else sees until the owner uses it
//   publish  anything that publishes or sends; always waits for the owner's OK as well
//
// AGENT_APPS=on switches the whole thing on (see ./agentApps).

type Env = Record<string, string | undefined>;

export function appsEnabled(env: Env = process.env): boolean {
  return (env.AGENT_APPS ?? "off").trim().toLowerCase() === "on";
}

export type AppId = "github" | "notion" | "slack" | "gdocs" | "gmail";
export type AppAction = "read" | "draft" | "publish";
export const ACTIONS: readonly AppAction[] = ["read", "draft", "publish"] as const;
/** What an agent may do in an app its owner has not said anything about: the safest. */
export const DEFAULT_ACTIONS: readonly AppAction[] = ["read", "draft"] as const;

/** What a token endpoint answered, read the same way for every app. */
export interface TokenSet {
  accessToken: string;
  refreshToken: string | null;
  /** seconds until the access token stops working; null when it does not */
  expiresIn: number | null;
  /** the scopes granted, when the app says */
  scopes: string[] | null;
  /** who it is in the app, when the token answer already says */
  label: string | null;
}

export interface AppDef {
  id: AppId | string;
  name: string;
  /** one line for the dashboard */
  blurb: string;
  authorizeUrl: string;
  tokenUrl: string;
  /** how scopes are joined, and the parameter they go in */
  scopeSeparator: " " | ",";
  scopeParam: string;
  /** extra parameters on the sign-in page */
  authorizeParams?: Record<string, string>;
  /** how the client id and secret are sent to the token endpoint */
  tokenAuth: "body" | "basic";
  /** the body of a token request: a form, or JSON */
  tokenBody: "form" | "json";
  /** sends a PKCE challenge (S256). An app that ignores it is not harmed by it. */
  pkce: boolean;
  /** the scopes each action needs, with what they mean in plain words */
  actions: Record<AppAction, { label: string; scopes: string[] }>;
  /** scopes asked for whatever the actions, e.g. to learn the account's name */
  baseScopes: string[];
  /** plain words for each scope, shown to the owner */
  scopeWords: Record<string, string>;
  /** how a connection is withdrawn at the app; none when the app has no endpoint for it */
  revoke: { style: "rfc7009" | "github" | "slack" | "notion"; url: string } | null;
  /** where the account's name is read when the token answer does not say */
  userinfo: { url: string; label: (body: Record<string, unknown>) => string | null } | null;
  /** read a token endpoint's answer */
  parseToken: (body: Record<string, unknown>) => TokenSet | null;
  /** the env names for Axon's client id and secret at this app */
  env: { clientId: string; clientSecret: string };
}

const str = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v : null);
const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) && v > 0 ? v : typeof v === "string" && /^\d+$/.test(v) ? Number(v) : null);
const obj = (v: unknown): Record<string, unknown> => (v && typeof v === "object" ? (v as Record<string, unknown>) : {});
const splitScopes = (v: unknown, sep: RegExp): string[] | null => (typeof v === "string" ? v.split(sep).map((s) => s.trim()).filter(Boolean) : null);

/** The standard answer: access_token, refresh_token, expires_in, scope. */
export function standardToken(body: Record<string, unknown>): TokenSet | null {
  const accessToken = str(body.access_token);
  if (!accessToken) return null;
  return {
    accessToken,
    refreshToken: str(body.refresh_token),
    expiresIn: num(body.expires_in),
    scopes: splitScopes(body.scope, /[\s,]+/),
    label: null,
  };
}

const GOOGLE_AUTHORIZE = "https://accounts.google.com/o/oauth2/v2/auth";
const GOOGLE_TOKEN = "https://oauth2.googleapis.com/token";
const GOOGLE_REVOKE = "https://oauth2.googleapis.com/revoke";
const GOOGLE_USERINFO = "https://openidconnect.googleapis.com/v1/userinfo";
const googleLabel = (b: Record<string, unknown>) => str(b.email) ?? str(b.name);

const APPS: AppDef[] = [
  {
    id: "github",
    name: "GitHub",
    blurb: "Read code and issues, push work to a new branch, open a pull request.",
    authorizeUrl: "https://github.com/login/oauth/authorize",
    tokenUrl: "https://github.com/login/oauth/access_token",
    scopeSeparator: " ",
    scopeParam: "scope",
    authorizeParams: { allow_signup: "false" },
    tokenAuth: "body",
    tokenBody: "form",
    pkce: true,
    actions: {
      read: { label: "Read code, issues and pull requests", scopes: ["repo"] },
      draft: { label: "Push work to a new branch, never to your main one", scopes: ["repo"] },
      publish: { label: "Open a pull request", scopes: ["repo"] },
    },
    baseScopes: ["read:user"],
    scopeWords: { repo: "Read and write your repositories", "read:user": "See your GitHub name" },
    revoke: { style: "github", url: "https://api.github.com/applications/{client_id}/grant" },
    userinfo: { url: "https://api.github.com/user", label: (b) => str(b.login) },
    parseToken: standardToken,
    env: { clientId: "GITHUB_APP_CLIENT_ID", clientSecret: "GITHUB_APP_CLIENT_SECRET" },
  },
  {
    id: "notion",
    name: "Notion",
    blurb: "Read the pages you share with Axon, write new ones, change existing ones when you say so.",
    authorizeUrl: "https://api.notion.com/v1/oauth/authorize",
    tokenUrl: "https://api.notion.com/v1/oauth/token",
    scopeSeparator: " ",
    scopeParam: "scope",
    // Notion has no scopes: what Axon may touch is chosen by the owner on Notion's own page when they connect
    authorizeParams: { owner: "user" },
    tokenAuth: "basic",
    tokenBody: "json",
    pkce: false,
    actions: {
      read: { label: "Read the pages you shared with Axon", scopes: [] },
      draft: { label: "Write new pages", scopes: [] },
      publish: { label: "Change or share existing pages", scopes: [] },
    },
    baseScopes: [],
    scopeWords: {},
    revoke: { style: "notion", url: "https://api.notion.com/v1/oauth/revoke" },
    userinfo: null,
    parseToken: (b) => {
      const t = standardToken(b);
      if (!t) return null;
      const owner = obj(obj(b.owner).user);
      const label = str(b.workspace_name) ?? str(owner.name);
      return { ...t, scopes: ["pages you shared"], label };
    },
    env: { clientId: "NOTION_APP_CLIENT_ID", clientSecret: "NOTION_APP_CLIENT_SECRET" },
  },
  {
    id: "slack",
    name: "Slack",
    blurb: "Read the channels you are in, and post there when you say so.",
    authorizeUrl: "https://slack.com/oauth/v2/authorize",
    tokenUrl: "https://slack.com/api/oauth.v2.access",
    scopeSeparator: ",",
    // a token that acts as the owner, not as a bot
    scopeParam: "user_scope",
    tokenAuth: "body",
    tokenBody: "form",
    pkce: true,
    actions: {
      read: { label: "Read channels and messages", scopes: ["channels:read", "channels:history", "users:read"] },
      draft: { label: "Prepare a message here for you to look at", scopes: [] },
      publish: { label: "Post a message", scopes: ["chat:write"] },
    },
    baseScopes: [],
    scopeWords: {
      "channels:read": "See the channels in your workspace",
      "channels:history": "Read messages in public channels",
      "users:read": "See people's names",
      "chat:write": "Post messages as you",
    },
    revoke: { style: "slack", url: "https://slack.com/api/auth.revoke" },
    userinfo: null,
    parseToken: (b) => {
      if (b.ok === false) return null;
      // the owner's own token sits under authed_user
      const user = obj(b.authed_user);
      const accessToken = str(user.access_token);
      if (!accessToken) return null;
      return {
        accessToken,
        refreshToken: str(user.refresh_token),
        expiresIn: num(user.expires_in),
        scopes: splitScopes(user.scope, /[\s,]+/),
        label: str(obj(b.team).name),
      };
    },
    env: { clientId: "SLACK_APP_CLIENT_ID", clientSecret: "SLACK_APP_CLIENT_SECRET" },
  },
  {
    id: "gdocs",
    name: "Google Docs",
    blurb: "Read your documents, write new ones in your Drive, change existing ones when you say so.",
    authorizeUrl: GOOGLE_AUTHORIZE,
    tokenUrl: GOOGLE_TOKEN,
    scopeSeparator: " ",
    scopeParam: "scope",
    authorizeParams: { access_type: "offline", prompt: "consent", include_granted_scopes: "true" },
    tokenAuth: "body",
    tokenBody: "form",
    pkce: true,
    actions: {
      read: { label: "Read your documents", scopes: ["https://www.googleapis.com/auth/documents.readonly"] },
      draft: { label: "Write new documents in your Drive", scopes: ["https://www.googleapis.com/auth/drive.file"] },
      publish: { label: "Change or share existing documents", scopes: ["https://www.googleapis.com/auth/documents"] },
    },
    baseScopes: ["openid", "email"],
    scopeWords: {
      openid: "Know it is you",
      email: "See your email address",
      "https://www.googleapis.com/auth/documents.readonly": "Read your Google Docs",
      "https://www.googleapis.com/auth/drive.file": "Make new files in your Drive",
      "https://www.googleapis.com/auth/documents": "Change your Google Docs",
    },
    revoke: { style: "rfc7009", url: GOOGLE_REVOKE },
    userinfo: { url: GOOGLE_USERINFO, label: googleLabel },
    parseToken: standardToken,
    env: { clientId: "GOOGLE_APP_CLIENT_ID", clientSecret: "GOOGLE_APP_CLIENT_SECRET" },
  },
  {
    id: "gmail",
    name: "Gmail",
    blurb: "Read your email and write draft replies. Sending waits for your OK.",
    authorizeUrl: GOOGLE_AUTHORIZE,
    tokenUrl: GOOGLE_TOKEN,
    scopeSeparator: " ",
    scopeParam: "scope",
    authorizeParams: { access_type: "offline", prompt: "consent", include_granted_scopes: "true" },
    tokenAuth: "body",
    tokenBody: "form",
    pkce: true,
    actions: {
      read: { label: "Read your email", scopes: ["https://www.googleapis.com/auth/gmail.readonly"] },
      draft: { label: "Write draft replies in Gmail", scopes: ["https://www.googleapis.com/auth/gmail.compose"] },
      publish: { label: "Send email", scopes: ["https://www.googleapis.com/auth/gmail.send"] },
    },
    baseScopes: ["openid", "email"],
    scopeWords: {
      openid: "Know it is you",
      email: "See your email address",
      "https://www.googleapis.com/auth/gmail.readonly": "Read your email",
      "https://www.googleapis.com/auth/gmail.compose": "Write drafts",
      "https://www.googleapis.com/auth/gmail.send": "Send email as you",
    },
    revoke: { style: "rfc7009", url: GOOGLE_REVOKE },
    userinfo: { url: GOOGLE_USERINFO, label: googleLabel },
    parseToken: standardToken,
    // the same Google client as Docs: one Google Cloud project serves both
    env: { clientId: "GOOGLE_APP_CLIENT_ID", clientSecret: "GOOGLE_APP_CLIENT_SECRET" },
  },
];

// Tests stand a fake app up next to the real ones; nothing else can add one.
const extra: AppDef[] = [];
export function addAppForTests(def: AppDef): () => void {
  if (process.env.NODE_ENV !== "test" && !process.env.VITEST) throw new Error("addAppForTests is for tests only");
  extra.push(def);
  return () => { const i = extra.indexOf(def); if (i >= 0) extra.splice(i, 1); };
}

export function listApps(): AppDef[] {
  return [...APPS, ...extra];
}

export function getApp(id: string): AppDef | null {
  return listApps().find((a) => a.id === id) ?? null;
}

/** Axon's client id and secret at an app, or null when either is missing. Never returned by any route. */
export function appClient(app: AppDef, env: Env = process.env): { clientId: string; clientSecret: string } | null {
  const clientId = env[app.env.clientId]?.trim();
  const clientSecret = env[app.env.clientSecret]?.trim();
  return clientId && clientSecret ? { clientId, clientSecret } : null;
}

/** Every scope a connection asks for: the base ones and those of every action, once each, in a stable order. */
export function scopesFor(app: AppDef): string[] {
  return [...new Set([...app.baseScopes, ...ACTIONS.flatMap((a) => app.actions[a].scopes)])];
}

/** Scopes in plain words, for the owner. One the app describes no way is shown as it is. */
export function scopeWords(app: AppDef, scopes: string[]): string[] {
  return [...new Set(scopes.map((s) => app.scopeWords[s] ?? s))];
}

export const isAction = (v: unknown): v is AppAction => typeof v === "string" && (ACTIONS as readonly string[]).includes(v);
