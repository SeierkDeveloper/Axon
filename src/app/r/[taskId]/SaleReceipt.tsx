import type { SaleReceipt } from "@/lib/shopSales";
import type { Material } from "@/lib/receipts";
import { explorerTxUrl, isOnChainTxHash } from "@/lib/chain";

// The receipt of a sale, at the same address a job's receipt has: who bought what from which agent, the version that
// was sold and its fingerprint, and the payment. Never the files themselves; those are the buyer's. And on a job's
// receipt, what its agent bought from other agents as material, each linked to its sale's receipt.

function fmt(iso: string | null): string {
  if (!iso) return "No data";
  return new Date(iso).toUTCString().replace(" GMT", " UTC");
}

const TONE: Record<string, string> = {
  delivered: "bg-emerald-500/15 text-emerald-300 border-emerald-500/40",
  refunded: "bg-red-500/15 text-red-300 border-red-500/40",
  paid: "bg-amber-500/15 text-amber-300 border-amber-500/40",
};

export function SaleStatus({ status }: { status: string }) {
  return <span className={`inline-block rounded-full border px-3 py-0.5 text-xs font-semibold uppercase tracking-wider ${TONE[status] ?? TONE.paid}`}>{status}</span>;
}

export function SaleReceiptBody({ r }: { r: SaleReceipt }) {
  return (
    <>
      <div className="px-7 py-5 flex items-center gap-4">
        <div className="min-w-0">
          <p className="text-[11px] uppercase tracking-[0.2em] text-gray-500">Bought by</p>
          <p className="text-lg font-bold text-white truncate">{r.buyer.name ?? r.buyer.id}</p>
          <p className="font-mono text-[11px] text-gray-500 truncate">{r.buyer.id}</p>
        </div>
        <span className="text-2xl text-teal-400 shrink-0">←</span>
        <div className="min-w-0">
          <p className="text-[11px] uppercase tracking-[0.2em] text-gray-500">Sold by</p>
          <p className="text-lg font-bold text-white truncate">{r.seller.name ?? r.seller.agentId}</p>
          <p className="font-mono text-[11px] text-gray-500 truncate">{r.seller.agentId}</p>
        </div>
      </div>

      <div className="px-7 pb-5 grid grid-cols-2 gap-x-6 gap-y-2 text-sm border-b border-white/10">
        <p className="text-gray-500">Product</p>
        <p className="text-gray-300 text-right text-xs truncate" title={r.product.title}>{r.product.title}</p>
        <p className="text-gray-500">Bought</p>
        <p className="text-gray-300 text-right font-mono text-xs">{fmt(r.createdAt)}</p>
        <p className="text-gray-500">Delivered</p>
        <p className="text-gray-300 text-right font-mono text-xs">{fmt(r.deliveredAt)}</p>
        {r.forTaskId && (
          <>
            <p className="text-gray-500">Bought for a job</p>
            <p className="text-right text-xs">
              <a href={`/r/${encodeURIComponent(r.forTaskId)}`} className="text-teal-400 hover:text-teal-300">The job it was material for →</a>
            </p>
          </>
        )}
      </div>

      <div className="px-7 py-5 space-y-2 border-b border-white/10">
        <p className="text-[11px] uppercase tracking-[0.2em] text-gray-500 mb-1">What was sold: version {r.product.version}</p>
        <p className="font-mono text-[13px] text-teal-300 break-all rounded-lg bg-white/[0.04] border border-white/10 px-3 py-2" title={r.product.fingerprint}>{r.product.fingerprint}</p>
        <p className="text-[11px] text-gray-500">
          The fingerprint of the files the buyer received: SHA-256 over every file&apos;s name and hash. The note in the files ends with the same fingerprint.
        </p>
        {r.notes.length > 0 && (
          <ul className="pt-2 space-y-1">
            {r.notes.map((n) => <li key={n.id} className="text-xs text-gray-400">{n.note}</li>)}
          </ul>
        )}
      </div>

      <div className="px-7 py-5">
        <p className="text-[11px] uppercase tracking-[0.2em] text-gray-500 mb-2">Settlement</p>
        {r.settlement ? (
          <div className="flex items-center justify-between gap-4">
            <p className="text-2xl font-bold text-white">
              {Number(r.settlement.amount.toFixed(6))} <span className="text-teal-400 text-base">{r.settlement.currency}</span>
              <span className="text-xs text-gray-500 font-normal ml-2">{r.settlement.status}</span>
            </p>
            {r.settlement.signature && isOnChainTxHash(r.settlement.signature) ? (
              <a href={explorerTxUrl(r.settlement.signature)} target="_blank" rel="noopener noreferrer" className="text-xs font-semibold text-teal-400 hover:text-teal-300 border border-teal-500/40 rounded-full px-3 py-1.5">
                View on explorer →
              </a>
            ) : (
              <span className="text-xs text-gray-500">{r.buyer.kind === "agent" ? "paid from the agent's balance" : "off-chain record"}</span>
            )}
          </div>
        ) : (
          <p className="text-sm text-gray-400">Price: <span className="text-white font-semibold">{r.price}</span></p>
        )}
      </div>
    </>
  );
}

/** On a job's receipt: what its agent bought from other agents as material, each with its own sale's receipt. */
export function MaterialsBought({ materials }: { materials: Material[] }) {
  return (
    <div>
      <p className="text-[11px] uppercase tracking-[0.2em] text-gray-500 mb-1">{materials.length === 1 ? "Material bought" : `Material bought (${materials.length})`}</p>
      <ul className="space-y-1.5">
        {materials.map((m) => (
          <li key={m.saleId} className="rounded-lg bg-white/[0.04] border border-white/10 px-3 py-2">
            <p className="flex items-center justify-between gap-3 text-[11px] text-gray-400">
              <span className="truncate">{m.title} · from {m.seller.name ?? m.seller.agentId} · {m.price}{m.status === "refunded" ? " · refunded" : ""}</span>
              <a href={`/r/${encodeURIComponent(m.saleId)}`} className="shrink-0 text-gray-300 underline decoration-white/20 hover:text-white">Its receipt →</a>
            </p>
            <p className="font-mono text-[13px] text-teal-300 break-all" title={m.fingerprint}>{m.fingerprint}</p>
          </li>
        ))}
      </ul>
    </div>
  );
}
