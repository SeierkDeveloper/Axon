// Mylo's records: conversations and messages, what it remembers about a wallet, the notices it leaves a wallet, and
// what it says in public. Every cap here comes from myloPolicy; nothing private ever reaches the feed.

import { createHash, randomUUID } from "crypto";
import { getDb } from "./db";
import { FEED, FEED_KINDS, INBOX, MEMORY, type FeedKind } from "./myloPolicy";

const now = () => new Date().toISOString();
const dayAgo = () => new Date(Date.now() - 86_400_000).toISOString();

const hash = (v: string) => createHash("sha256").update(`mylo:${v}`).digest("hex").slice(0, 32);

/** Who owns a conversation: a wallet (lowercase), or a visitor as a hash of the random id their own browser keeps (so
 *  two people on one network never share history), or failing that of their address. Never the id or address itself. */
export function ownerOf(wallet: string | null | undefined, ip: string | null | undefined, visitor?: string | null): string {
  if (wallet) return wallet.toLowerCase();
  if (visitor && /^[0-9a-f-]{16,64}$/i.test(visitor)) return `guest:${hash(`v:${visitor.toLowerCase()}`)}`;
  return `guest:${hash(ip ?? "unknown")}`;
}

/** Who the day's limit counts against: the wallet, or a visitor's address (hashed), so clearing a browser resets nothing. */
export function limitKeyOf(wallet: string | null | undefined, ip: string | null | undefined): string {
  return wallet ? wallet.toLowerCase() : `guest-ip:${hash(ip ?? "unknown")}`;
}

// ── Conversations ─────────────────────────────────────────────────────────────

export interface Conversation { id: string; owner: string; title: string | null; createdAt: string; updatedAt: string }
export type Role = "user" | "assistant" | "tool";
export interface Message { id: string; conversationId: string; role: Role; content: string; meta: unknown; createdAt: string }

export function startConversation(owner: string, title: string | null = null): Conversation {
  const id = randomUUID(), at = now();
  getDb().prepare("INSERT INTO mylo_conversations (id, owner, title, created_at, updated_at) VALUES (?,?,?,?,?)").run(id, owner, title, at, at);
  return { id, owner, title, createdAt: at, updatedAt: at };
}

export function getConversation(id: string, owner: string): Conversation | null {
  const r = getDb().prepare("SELECT id, owner, title, created_at createdAt, updated_at updatedAt FROM mylo_conversations WHERE id = ? AND owner = ?").get(id, owner) as Conversation | undefined;
  return r ?? null;
}

export function conversationsOf(owner: string, limit = 30): Conversation[] {
  return getDb().prepare("SELECT id, owner, title, created_at createdAt, updated_at updatedAt FROM mylo_conversations WHERE owner = ? ORDER BY updated_at DESC LIMIT ?").all(owner, limit) as Conversation[];
}

export function setTitle(id: string, title: string): void {
  getDb().prepare("UPDATE mylo_conversations SET title = ? WHERE id = ?").run(title.slice(0, 80), id);
}

export function addMessage(conversationId: string, owner: string, role: Role, content: string, meta: unknown = null, limitKey: string = owner): Message {
  const id = randomUUID(), at = now(), db = getDb();
  db.prepare("INSERT INTO mylo_messages (id, conversation_id, owner, role, content, meta, limit_key, created_at) VALUES (?,?,?,?,?,?,?,?)")
    .run(id, conversationId, owner, role, content, meta === null ? null : JSON.stringify(meta), limitKey, at);
  db.prepare("UPDATE mylo_conversations SET updated_at = ? WHERE id = ?").run(at, conversationId);
  return { id, conversationId, role, content, meta, createdAt: at };
}

/** The last `limit` messages of a conversation, oldest first: what Mylo reads back for context. */
export function historyOf(conversationId: string, limit: number): Message[] {
  const rows = getDb().prepare("SELECT id, conversation_id conversationId, role, content, meta, created_at createdAt FROM mylo_messages WHERE conversation_id = ? ORDER BY created_at DESC, rowid DESC LIMIT ?")
    .all(conversationId, limit) as (Omit<Message, "meta"> & { meta: string | null })[];
  return rows.reverse().map((r) => ({ ...r, meta: r.meta ? JSON.parse(r.meta) : null }));
}

/** What was sent against a limit key in the last day: the number the daily limit is checked against. */
export function sentToday(limitKey: string): number {
  return (getDb().prepare("SELECT COUNT(*) n FROM mylo_messages WHERE limit_key = ? AND role = 'user' AND created_at >= ?").get(limitKey, dayAgo()) as { n: number }).n;
}

// ── Memory ────────────────────────────────────────────────────────────────────

export interface Fact { key: string; value: string; updatedAt: string }

/** Remember one fact about a wallet. The same key is updated, not duplicated; past the cap, the oldest goes. */
export function remember(wallet: string, key: string, value: string): Fact {
  const w = wallet.toLowerCase(), k = key.trim().toLowerCase().slice(0, 60), v = value.trim().slice(0, MEMORY.factChars), at = now(), db = getDb();
  db.prepare("INSERT INTO mylo_memory (wallet, key, value, created_at, updated_at) VALUES (?,?,?,?,?) ON CONFLICT(wallet, key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at")
    .run(w, k, v, at, at);
  db.prepare("DELETE FROM mylo_memory WHERE wallet = ? AND key NOT IN (SELECT key FROM mylo_memory WHERE wallet = ? ORDER BY updated_at DESC LIMIT ?)").run(w, w, MEMORY.factsPerWallet);
  return { key: k, value: v, updatedAt: at };
}

export function forget(wallet: string, key?: string): number {
  const w = wallet.toLowerCase();
  return key
    ? getDb().prepare("DELETE FROM mylo_memory WHERE wallet = ? AND key = ?").run(w, key.trim().toLowerCase()).changes
    : getDb().prepare("DELETE FROM mylo_memory WHERE wallet = ?").run(w).changes;
}

export function memoryOf(wallet: string): Fact[] {
  return getDb().prepare("SELECT key, value, updated_at updatedAt FROM mylo_memory WHERE wallet = ? ORDER BY updated_at DESC").all(wallet.toLowerCase()) as Fact[];
}

// ── Inbox ─────────────────────────────────────────────────────────────────────

export interface Notice { id: string; kind: string; title: string; body: string | null; link: string | null; readAt: string | null; createdAt: string }

/** Leave a wallet a notice. The same event (dedupeKey) lands once, however often it is noticed. Returns false if it was already there. */
export function notify(wallet: string, kind: string, title: string, body: string | null, link: string | null, dedupeKey: string): boolean {
  const w = wallet.toLowerCase(), db = getDb();
  const added = db.prepare("INSERT OR IGNORE INTO mylo_inbox (id, wallet, kind, title, body, link, dedupe_key, created_at) VALUES (?,?,?,?,?,?,?,?)")
    .run(randomUUID(), w, kind, title.slice(0, 140), body?.slice(0, 600) ?? null, link, dedupeKey, now()).changes > 0;
  if (added) {
    db.prepare("DELETE FROM mylo_inbox WHERE wallet = ? AND (created_at < ? OR id NOT IN (SELECT id FROM mylo_inbox WHERE wallet = ? ORDER BY created_at DESC LIMIT ?))")
      .run(w, new Date(Date.now() - INBOX.keepDays * 86_400_000).toISOString(), w, INBOX.perWallet);
  }
  return added;
}

export function inboxOf(wallet: string, unreadOnly = false, limit = 50): Notice[] {
  return getDb().prepare(`SELECT id, kind, title, body, link, read_at readAt, created_at createdAt FROM mylo_inbox WHERE wallet = ? ${unreadOnly ? "AND read_at IS NULL" : ""} ORDER BY created_at DESC LIMIT ?`)
    .all(wallet.toLowerCase(), limit) as Notice[];
}

export function markRead(wallet: string, ids?: string[]): number {
  const w = wallet.toLowerCase(), at = now(), db = getDb();
  if (!ids) return db.prepare("UPDATE mylo_inbox SET read_at = ? WHERE wallet = ? AND read_at IS NULL").run(at, w).changes;
  const run = db.prepare("UPDATE mylo_inbox SET read_at = ? WHERE wallet = ? AND id = ? AND read_at IS NULL");
  return ids.reduce((n, id) => n + run.run(at, w, id).changes, 0);
}

// ── Public thoughts ───────────────────────────────────────────────────────────

export interface Thought { id: string; kind: FeedKind; text: string; link: string | null; createdAt: string }

/** Say something in public. Only the kinds the policy lists; the same event (dedupeKey) once; past the cap, the oldest goes. */
export function think(kind: FeedKind, text: string, link: string | null = null, dedupeKey: string | null = null): Thought | null {
  if (!(FEED_KINDS as readonly string[]).includes(kind)) return null;
  const id = randomUUID(), at = now(), t = text.replace(/\s+/g, " ").trim().slice(0, FEED.textChars), db = getDb();
  if (!t) return null;
  const added = db.prepare("INSERT OR IGNORE INTO mylo_feed (id, kind, text, link, dedupe_key, created_at) VALUES (?,?,?,?,?,?)").run(id, kind, t, link, dedupeKey, at).changes > 0;
  if (!added) return null;
  db.prepare("DELETE FROM mylo_feed WHERE id NOT IN (SELECT id FROM mylo_feed ORDER BY created_at DESC LIMIT ?)").run(FEED.keep);
  return { id, kind, text: t, link, createdAt: at };
}

export function feed(limit = 50, before?: string): Thought[] {
  return (before
    ? getDb().prepare("SELECT id, kind, text, link, created_at createdAt FROM mylo_feed WHERE created_at < ? ORDER BY created_at DESC LIMIT ?").all(before, limit)
    : getDb().prepare("SELECT id, kind, text, link, created_at createdAt FROM mylo_feed ORDER BY created_at DESC LIMIT ?").all(limit)) as Thought[];
}
