// Agents that sell what they make: buying.
//
// A buyer pays a product's price in ETH on Robinhood Chain, the same way a paid hire is paid: a transfer to Axon's
// receiving wallet, whose hash is handed over and checked on chain before anything is given out (./payments). The
// payment is kept as an ordinary escrow row in transactions under the sale's id, so from there it is settled, refunded
// and counted in the agent's earnings by exactly the code that does it for a paid job.
//
// The order matters, because what is paid for must be what is delivered:
//
//   check the payment on chain  ->  keep it as the sale's escrow  ->  check the product can still be sold
//   ->  make the files  ->  settle the escrow to the agent  ->  the buyer gets the files and a receipt
//
// Anything that stops a paid sale between the escrow and the files refunds the escrow, with the reason on the record,
// the way a paid job that fails is refunded: a product taken down while the payment was on its way, a page taken
// down after reports, a version no longer kept, files that no longer pass the build rules, a buyer who already owns
// it, or files that could not be made. One payment is one sale: the same hash a second time gives back the sale it
// already made, never a second one. A payment short of the price is refused like a short payment for a hire.
//
// The buyer finds a purchase again with their wallet, or with the key given at the purchase (like the claim token of
// a hire made without signing in): either one opens the files again and nothing else.

import { getDb } from "./db";
import { syncToTurso } from "./db-turso";
import { logger } from "./logger";
import { isWalletAddress, sameAddress } from "./address";
import { claimTokenFor, claimTokenValid } from "./claimToken";
import { createPayment, createBalancePayment, isTransientPaymentError, refundPayment, releasePayment } from "./payments";
import { addPaymentNote, getPaymentNotes, type PaymentNote } from "./paymentNotes";
import { formatEth, weiToDecimalString, weiToEth } from "./money";
import { getAgentById } from "./agents";
import { siteZip, type SiteArchive } from "./siteZip";
import { availability, getProduct, getSale, newId, now, sellable, shopLimits, toSale, type Product, type Sale, type ShopLimits } from "./agentShop";

export type Bought =
  | { ok: true; sale: Sale; claimToken: string | null; replay: boolean }
  | { ok: false; status: number; code: "NOT_FOUND" | "VALIDATION_ERROR" | "PAYMENT_FAILED" | "CONFLICT" | "PAYMENT_UNAVAILABLE" | "TASK_STATE_CONFLICT"; why: string; sale?: Sale };

/** The price a payment is checked against: the one shown, or the one just before it for a payment made while it changed. */
export function priceToPay(p: Product, quotedWei: unknown, limits: ShopLimits = shopLimits(), nowMs = Date.now()): bigint {
  const quoted = typeof quotedWei === "string" && /^\d{1,40}$/.test(quotedWei) ? BigInt(quotedWei) : typeof quotedWei === "bigint" ? quotedWei : null;
  if (quoted === null || quoted === p.priceWei) return p.priceWei;
  const recent = p.priceChangedAt !== null && nowMs - Date.parse(p.priceChangedAt) <= limits.priceGraceMinutes * 60_000;
  return recent && p.prevPriceWei !== null && quoted === p.prevPriceWei ? quoted : p.priceWei;
}

function saleBySignature(signature: string): Sale | null {
  const r = getDb().prepare("SELECT * FROM shop_sales WHERE payment_signature = ?").get(signature) as Record<string, unknown> | undefined;
  return r ? toSale(r) : null;
}

/** Does this buyer (a wallet, or an agent) already have this product? */
export function owns(buyer: string, productId: string, exceptSaleId = ""): boolean {
  return Boolean(getDb().prepare("SELECT 1 FROM shop_sales WHERE buyer = ? AND product_id = ? AND status = 'delivered' AND sale_id != ? LIMIT 1").get(buyer.toLowerCase(), productId, exceptSaleId));
}

/**
 * Is the buyer the seller: the wallet that owns the selling agent, or an agent with the same owner? Such a sale would
 * only move the owner's own money and make the product look sold.
 */
function ownBuyer(buyer: string, p: Product): boolean {
  const seller = getAgentById(p.agentId)?.walletAddress ?? p.sellerWallet;
  const buyerWallet = isWalletAddress(buyer) ? buyer : getAgentById(buyer)?.walletAddress ?? null;
  return sameAddress(buyerWallet, seller);
}

/** Why this product cannot be handed over right now, or null when it can. */
function cannotDeliver(p: Product): string | null {
  const open = availability(p);
  if (!open.ok) return open.why;
  // what passed the rules when it was listed must pass them again on the day it is sold
  const still = sellable({ siteId: p.siteId, agentId: p.agentId, wallet: p.sellerWallet, version: p.version });
  if (!still.ok) return still.why;
  if (still.sha256 !== p.sha256) return "This product's files are not the ones that were listed.";
  return null;
}

/** Give the paid escrow back, with the reason on the record. The sale is closed as refunded. */
function refundSale(saleId: string, why: string): Sale {
  refundPayment(saleId);
  try { addPaymentNote(saleId, "note", `Not delivered: ${why}`, null); } catch { /* the refund itself is on the record */ }
  getDb().prepare("UPDATE shop_sales SET status = 'refunded', error = ? WHERE sale_id = ?").run(why.slice(0, 300), saleId);
  logger.warn("shop.refunded", "A paid sale was refunded instead of delivered", { saleId, why });
  void syncToTurso();
  return getSale(saleId)!;
}

/**
 * Hand over a sale whose payment is in escrow: check the product once more, make its files, settle the escrow to the
 * agent. A refund in place of any step that does not work. The archive is made here so that a sale is only ever
 * settled for files that could be made; the buyer downloads the same files from the same version afterwards.
 */
function deliver(saleId: string, p: Product, buyer: string, make: typeof siteZip = siteZip): Sale {
  const why = cannotDeliver(p) ?? (owns(buyer, p.productId, saleId) ? "This buyer already has this product." : null) ?? (ownBuyer(buyer, p) ? "A seller cannot buy their own product." : null);
  if (why) return refundSale(saleId, why);
  let files: SiteArchive | null = null;
  try { files = make(p.siteId, { version: p.version }); } catch (err) { logger.error("shop.files_failed", "The files of a sold product could not be made", { saleId, err }); }
  if (!files) return refundSale(saleId, "The files could not be made.");
  // settled by the code that settles a paid job: the agent's earnings, a split or a remix share, the webhooks
  if (!releasePayment(saleId)) {
    logger.error("shop.not_in_escrow", "A sale's payment was not in escrow when it was delivered", { saleId });
    getDb().prepare("UPDATE shop_sales SET error = ? WHERE sale_id = ?").run("The payment was not found in escrow.", saleId);
    return getSale(saleId)!;
  }
  const db = getDb();
  db.prepare("UPDATE shop_sales SET status = 'delivered', delivered_at = ? WHERE sale_id = ?").run(now(), saleId);
  db.prepare("UPDATE shop_products SET sold = sold + 1 WHERE product_id = ?").run(p.productId);
  logger.info("shop.sold", "A product was sold and delivered", { saleId, productId: p.productId, agentId: p.agentId, priceEth: weiToEth(p.priceWei) });
  void syncToTurso();
  return getSale(saleId)!;
}

function insertSale(s: { saleId: string; p: Product; buyer: string; buyerKind: "wallet" | "agent"; forTaskId?: string | null; priceWei: bigint; signature: string | null }): void {
  getDb().prepare(
    `INSERT INTO shop_sales (sale_id, product_id, agent_id, buyer, buyer_kind, for_task_id, price_wei, payment_signature, status, version, sha256, title, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'paid', ?, ?, ?, ?)`,
  ).run(s.saleId, s.p.productId, s.p.agentId, s.buyer.toLowerCase(), s.buyerKind, s.forTaskId ?? null, s.priceWei.toString(), s.signature, s.p.version, s.p.sha256, s.p.title, now());
}

/**
 * Buy a product with an ETH payment already sent from the buyer's wallet to the receiving wallet. `quotedWei` is the
 * price the buyer was shown, so a payment sent while the price changed is still honoured for a short while.
 */
export async function buyProduct(a: { productId: string; paymentSignature: unknown; payerWallet: unknown; quotedWei?: unknown }, o: { pay?: typeof createPayment; make?: typeof siteZip } = {}): Promise<Bought> {
  const p = getProduct(a.productId);
  if (!p) return { ok: false, status: 404, code: "NOT_FOUND", why: "There is no such product." };
  const signature = typeof a.paymentSignature === "string" ? a.paymentSignature.trim() : "";
  if (!signature || signature.length > 200) return { ok: false, status: 400, code: "VALIDATION_ERROR", why: "paymentSignature is needed: the hash of the payment." };

  // the same payment again: the sale it made, never a second one, and never its key (the hash is public on chain)
  const before = saleBySignature(signature);
  if (before) {
    if (before.productId !== p.productId) return { ok: false, status: 409, code: "CONFLICT", why: "That payment already paid for something else." };
    return { ok: true, sale: before, claimToken: null, replay: true };
  }
  const payer = typeof a.payerWallet === "string" && isWalletAddress(a.payerWallet) ? a.payerWallet.toLowerCase() : null;
  if (!payer) return { ok: false, status: 400, code: "VALIDATION_ERROR", why: "payerWallet is needed: the wallet the payment came from." };

  const priceWei = priceToPay(p, a.quotedWei);
  const saleId = newId("sale");
  try {
    await (o.pay ?? createPayment)({ taskId: saleId, fromAgent: payer, toAgent: p.agentId, amountEth: weiToEth(priceWei), priceString: `${weiToDecimalString(priceWei)} ETH`, paymentSignature: signature, payerWallet: payer });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (/already used/i.test(msg)) {
      // a race with the same hash: the other request made the sale
      const raced = saleBySignature(signature);
      return raced ? { ok: true, sale: raced, claimToken: null, replay: true } : { ok: false, status: 409, code: "CONFLICT", why: "That payment was already used." };
    }
    if (isTransientPaymentError(err)) return { ok: false, status: 503, code: "PAYMENT_UNAVAILABLE", why: "The payment could not be checked just now. Send the same payment hash again in a minute; do not pay again." };
    return { ok: false, status: 402, code: "PAYMENT_FAILED", why: `The payment was not enough or not found. ${formatEth(priceWei)} must be sent from ${payer}.` };
  }
  insertSale({ saleId, p, buyer: payer, buyerKind: "wallet", priceWei, signature });
  const sale = deliver(saleId, getProduct(p.productId)!, payer, o.make);
  if (sale.status !== "delivered") return { ok: false, status: 410, code: "TASK_STATE_CONFLICT", why: `${sale.error ?? "It could not be delivered."} The payment was refunded.`, sale };
  return { ok: true, sale, claimToken: claimTokenFor(saleId), replay: false };
}

/**
 * An agent buys another agent's product during a job, as material for it, from its own earned balance. The same
 * delivery as any sale; the sale names the job, so both the job and the sale carry it on their receipts.
 */
export function buyFromBalance(a: { productId: string; buyerAgentId: string; forTaskId: string; priceWei: bigint }, o: { make?: typeof siteZip } = {}): Bought {
  const p = getProduct(a.productId);
  if (!p) return { ok: false, status: 404, code: "NOT_FOUND", why: "There is no such product." };
  const saleId = newId("sale");
  try {
    createBalancePayment({ taskId: saleId, fromAgent: a.buyerAgentId, toAgent: p.agentId, amountEth: weiToEth(a.priceWei), priceString: `${weiToDecimalString(a.priceWei)} ETH` });
  } catch (err) {
    return { ok: false, status: 402, code: "PAYMENT_FAILED", why: err instanceof Error ? err.message : "The agent's balance could not pay for it." };
  }
  insertSale({ saleId, p, buyer: a.buyerAgentId, buyerKind: "agent", forTaskId: a.forTaskId, priceWei: a.priceWei, signature: null });
  const sale = deliver(saleId, getProduct(p.productId)!, a.buyerAgentId, o.make);
  if (sale.status !== "delivered") return { ok: false, status: 410, code: "TASK_STATE_CONFLICT", why: `${sale.error ?? "It could not be delivered."} The payment went back to the balance.`, sale };
  return { ok: true, sale, claimToken: claimTokenFor(saleId), replay: false };
}

// ── Finding a purchase again ──────────────────────────────────────────────────

/** May this caller have the files of this sale: its key, or the buyer's own wallet? */
export function mayOpen(sale: Sale, who: { claimToken?: string | null; wallet?: string | null }): boolean {
  if (sale.status !== "delivered") return false;
  if (who.claimToken && claimTokenValid(sale.saleId, who.claimToken)) return true;
  return sale.buyerKind === "wallet" && Boolean(who.wallet) && sameAddress(sale.buyer, who.wallet);
}

/** The files of a sale, as delivered: the version that was sold. */
export function saleFiles(sale: Sale, make: typeof siteZip = siteZip): SiteArchive | null {
  const p = getProduct(sale.productId);
  return p ? make(p.siteId, { version: sale.version }) : null;
}

/** What a wallet bought, newest first: delivered, and refunded with why. */
export function purchasesOf(wallet: string, limit = 50): Sale[] {
  return (getDb().prepare("SELECT * FROM shop_sales WHERE buyer = ? AND buyer_kind = 'wallet' ORDER BY created_at DESC, rowid DESC LIMIT ?").all(wallet.toLowerCase(), Math.max(1, Math.min(200, limit))) as Record<string, unknown>[]).map(toSale);
}

/** The products a job bought as material. */
export function materialsOf(taskId: string): Sale[] {
  return (getDb().prepare("SELECT * FROM shop_sales WHERE for_task_id = ? ORDER BY created_at ASC, rowid ASC").all(taskId) as Record<string, unknown>[]).map(toSale);
}

// ── The receipt ───────────────────────────────────────────────────────────────

/**
 * A sale's receipt, as anybody may read it: who bought what from which agent, the version and its fingerprint, the
 * price and the payment, and the notes on it. Like a job's public receipt, never the files themselves.
 */
export interface SaleReceipt {
  saleId: string;
  status: Sale["status"];
  product: { productId: string; title: string; version: number; fingerprint: string };
  seller: { agentId: string; name: string | null };
  buyer: { id: string; kind: "wallet" | "agent"; name: string | null };
  /** the job an agent bought it for, as material */
  forTaskId: string | null;
  price: string;
  priceWei: string;
  settlement: { amount: number; currency: string; status: string; signature: string | null; settledAt: string | null } | null;
  notes: PaymentNote[];
  createdAt: string;
  deliveredAt: string | null;
}

export function saleReceipt(saleId: string): SaleReceipt | null {
  const s = getSale(saleId);
  if (!s) return null;
  const pay = getDb().prepare(
    "SELECT amount_eth, currency, status, incoming_signature, settled_at FROM transactions WHERE task_id = ? ORDER BY (incoming_signature IS NULL) ASC, created_at ASC LIMIT 1",
  ).get(saleId) as { amount_eth: number; currency: string; status: string; incoming_signature: string | null; settled_at: string | null } | undefined;
  return {
    saleId: s.saleId, status: s.status,
    product: { productId: s.productId, title: s.title, version: s.version, fingerprint: s.sha256 },
    seller: { agentId: s.agentId, name: getAgentById(s.agentId)?.name ?? null },
    buyer: { id: s.buyer, kind: s.buyerKind, name: s.buyerKind === "agent" ? getAgentById(s.buyer)?.name ?? null : null },
    forTaskId: s.forTaskId, price: formatEth(s.priceWei), priceWei: s.priceWei.toString(),
    settlement: pay ? { amount: pay.amount_eth, currency: pay.currency, status: pay.status, signature: pay.incoming_signature, settledAt: pay.settled_at } : null,
    notes: getPaymentNotes(saleId), createdAt: s.createdAt, deliveredAt: s.deliveredAt,
  };
}

// ── What the owner earned from sales ──────────────────────────────────────────

/** One agent's sales, as its owner's earnings show them: how many were delivered and what they brought in. */
export interface AgentSales { agentId: string; sold: number; earnedEth: number }
/** One sale, as its seller sees it. */
export interface SoldLine { saleId: string; agentId: string; title: string; price: string; buyer: string; buyerKind: "wallet" | "agent"; at: string }

/**
 * What a wallet's agents sold: per agent, and the latest sales. Sums are of the price each sale settled at, in wei.
 * The ETH itself is already in each agent's earnings, as a paid job's is, and is withdrawn with them.
 */
export function salesOfOwner(wallet: string, recent = 10): { agents: AgentSales[]; recent: SoldLine[] } {
  const rows = getDb().prepare(
    `SELECT s.* FROM shop_sales s JOIN agents a ON a.agent_id = s.agent_id
     WHERE LOWER(a.wallet_address) = ? AND s.status = 'delivered' ORDER BY s.delivered_at DESC, s.rowid DESC`,
  ).all(wallet.toLowerCase()) as Record<string, unknown>[];
  const sales = rows.map(toSale);
  const by = new Map<string, { sold: number; wei: bigint }>();
  for (const s of sales) {
    const had = by.get(s.agentId) ?? { sold: 0, wei: 0n };
    by.set(s.agentId, { sold: had.sold + 1, wei: had.wei + s.priceWei });
  }
  return {
    agents: [...by].map(([agentId, v]) => ({ agentId, sold: v.sold, earnedEth: weiToEth(v.wei) })),
    recent: sales.slice(0, recent).map((s) => ({ saleId: s.saleId, agentId: s.agentId, title: s.title, price: formatEth(s.priceWei), buyer: s.buyerKind === "agent" ? getAgentById(s.buyer)?.name ?? s.buyer : s.buyer, buyerKind: s.buyerKind, at: s.deliveredAt ?? s.createdAt })),
  };
}
