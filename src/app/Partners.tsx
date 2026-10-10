import Link from "next/link";
import FadeIn from "@/components/FadeIn";
import { ExtArrow } from "@/components/ExtArrow";
import { partners } from "@/lib/partners";

// Partners, on the homepage below the case for Axon: each one's mark, name, what it does with Axon, and where to
// find it. The marks sit on a white plate in both themes, since they are drawn for a light ground.
export default function Partners() {
  if (!partners.length) return null;
  const link = "inline-flex items-center text-sm text-gray-500 dark:text-gray-400 hover:text-gray-900 dark:hover:text-white transition-colors";
  return (
    <section className="pb-24 px-6" id="partners">
      <div className="max-w-6xl mx-auto">
        <div className="text-center mb-12">
          <FadeIn>
            <p className="text-xs font-mono text-gray-400 dark:text-gray-500 tracking-wider mb-3">PARTNERS</p>
            <h2 className="text-3xl md:text-4xl font-bold mb-4 text-gray-900 dark:text-white">Who Axon works with.</h2>
            <p className="text-gray-500 dark:text-gray-400 max-w-2xl mx-auto leading-relaxed">
              The teams around Axon, and what each one does.
            </p>
          </FadeIn>
        </div>
        <div className="grid md:grid-cols-2 gap-4 max-w-4xl mx-auto">
          {partners.map((p, i) => (
            <FadeIn key={p.name} delay={i * 80}>
              <div className="rounded-xl border border-gray-200 dark:border-gray-800 bg-white dark:bg-gray-900 p-5 h-full flex flex-col">
                <div className="flex items-center justify-between gap-4 mb-4">
                  <span className={`inline-flex h-12 items-center justify-center overflow-hidden rounded-xl border border-gray-200 dark:border-gray-700 bg-white ${p.wide ? "px-3.5" : "w-12"}`}>
                    {/* eslint-disable-next-line @next/next/no-img-element -- a small mark from /public, shown at its own shape */}
                    <img src={p.mark} alt={`${p.name} logo`} loading="lazy" className={p.wide ? "h-[18px] w-auto" : "h-full w-full object-cover"} />
                  </span>
                  <span className="text-xs font-mono uppercase tracking-wider text-gray-400 dark:text-gray-500 text-right">{p.role}</span>
                </div>
                <h3 className="text-base font-semibold text-gray-900 dark:text-white mb-1.5">{p.name}</h3>
                <p className="text-sm text-gray-600 dark:text-gray-400 leading-relaxed mb-4">{p.how}</p>
                <div className="mt-auto flex flex-wrap items-center gap-x-4 gap-y-2 border-t border-gray-100 dark:border-gray-800 pt-3.5">
                  <a href={p.site.href} target="_blank" rel="noopener noreferrer" className={link}>{p.site.label}<ExtArrow /></a>
                  <a href={p.x.href} target="_blank" rel="noopener noreferrer" className={link}>{p.x.handle}<ExtArrow /></a>
                  {p.more.href.startsWith("/")
                    ? <Link href={p.more.href} className="ml-auto text-sm font-medium text-gray-900 dark:text-white hover:underline underline-offset-4">{p.more.label} →</Link>
                    : <a href={p.more.href} target="_blank" rel="noopener noreferrer" className="ml-auto inline-flex items-center text-sm font-medium text-gray-900 dark:text-white hover:underline underline-offset-4">{p.more.label}<ExtArrow /></a>}
                </div>
              </div>
            </FadeIn>
          ))}
        </div>
      </div>
    </section>
  );
}
