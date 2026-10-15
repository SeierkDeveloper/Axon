import Link from "next/link";
import type { ProductView } from "@/lib/agentShop";

// The marketplace's "For sale" view: what agents built and their owners sell, across every agent. Each product opens
// its live page to look at, and its agent's page to buy it.

const SORTS: { value: string; label: string }[] = [
  { value: "newest", label: "Newest" },
  { value: "sold", label: "Best selling" },
  { value: "price", label: "Lowest price" },
];

export function ForSale({ products, sort, q }: { products: ProductView[]; sort: string; q: string }) {
  return (
    <div>
      <div className="mb-6 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex gap-1 overflow-x-auto">
          {SORTS.map(({ value, label }) => (
            <Link
              key={value}
              href={`/agents?view=sale&sort=${value}${q ? `&q=${encodeURIComponent(q)}` : ""}`}
              className={`whitespace-nowrap rounded-md border px-3 py-1.5 text-xs transition-colors ${
                sort === value
                  ? "border-gray-900 bg-gray-900 text-white dark:border-white dark:bg-white dark:text-[#0a0a0a]"
                  : "border-gray-200 text-gray-500 hover:border-gray-400 hover:text-gray-700 dark:border-gray-700 dark:text-gray-400 dark:hover:text-white"
              }`}
            >
              {label}
            </Link>
          ))}
        </div>
        <form action="/agents" className="flex gap-2">
          <input type="hidden" name="view" value="sale" />
          <input type="hidden" name="sort" value={sort} />
          <input name="q" defaultValue={q} placeholder="Search what is for sale" aria-label="Search what is for sale" className="w-full min-w-0 rounded-lg border border-gray-200 bg-transparent px-3 py-1.5 text-sm text-gray-900 focus:border-gray-400 focus:outline-none sm:w-64 dark:border-gray-700 dark:text-white" />
        </form>
      </div>

      {products.length === 0 ? (
        <p className="py-16 text-center text-sm text-gray-400">{q ? "Nothing for sale matches that." : "Nothing is for sale yet."}</p>
      ) : (
        <ul className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {products.map((p) => (
            <li key={p.productId} className="flex flex-col rounded-xl border border-gray-200 bg-white p-5 dark:border-gray-800 dark:bg-gray-900">
              <div className="flex items-baseline justify-between gap-3">
                <p className="min-w-0 truncate text-sm font-semibold text-gray-900 dark:text-white">{p.title}</p>
                <span className="shrink-0 font-mono text-sm text-gray-900 dark:text-white">{p.price}</span>
              </div>
              <p className="mt-1 flex-1 text-xs text-gray-500 dark:text-gray-400">{p.description}</p>
              <p className="mt-3 font-mono text-[11px] text-gray-400">
                by <Link href={`/agents/${encodeURIComponent(p.agentId)}`} className="underline hover:text-gray-900 dark:hover:text-white">{p.agentName}</Link> · {p.sold} sold{p.madeByAgent ? " · made by the agent on its own" : ""}
              </p>
              <div className="mt-3 flex gap-2">
                <a href={p.preview} target="_blank" rel="noreferrer" className="rounded-lg border border-gray-200 px-3 py-1.5 text-xs text-gray-700 transition hover:border-gray-400 dark:border-gray-700 dark:text-gray-300">See it live</a>
                <Link href={`/agents/${encodeURIComponent(p.agentId)}#product-${p.productId}`} className="rounded-lg bg-gray-900 px-3 py-1.5 text-xs font-medium text-white transition hover:opacity-90 dark:bg-white dark:text-gray-900">Buy</Link>
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
