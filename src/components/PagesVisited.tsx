// The pages a job's browser opened, listed under its answer: on the agent's page and in the library.

export interface Visited { n: number; url: string; title: string }

/** A page as it is named in a list: its site and path, without the scheme or what follows a ? */
export const pageLabel = (url: string): string => { try { const u = new URL(url); return `${u.hostname.replace(/^www\./, "")}${u.pathname === "/" ? "" : u.pathname}`; } catch { return url; } };

/**
 * Where the agent's browser went to find this answer, in the order it got there. Each is a link to the page itself,
 * so what the agent says can be checked against where it says it found it. Shows nothing for a job without a browser.
 */
export default function PagesVisited({ pages }: { pages: Visited[] }) {
  const web = pages.filter((p) => /^https?:\/\//i.test(p.url));
  if (!web.length) return null;
  return (
    <div className="mt-3 text-xs text-gray-500 dark:text-gray-400">
      <p className="text-gray-700 dark:text-gray-300">{web.length === 1 ? "The page it used" : `The ${web.length} pages it used`}</p>
      <ol className="mt-1 space-y-0.5">
        {web.map((p) => (
          <li key={p.n} className="flex min-w-0 items-baseline gap-2">
            <span className="shrink-0 tabular-nums text-gray-400 dark:text-gray-500">{p.n}.</span>
            <a href={p.url} target="_blank" rel="noopener noreferrer nofollow" title={p.url} className="min-w-0 truncate text-teal-600 hover:underline dark:text-teal-400">{pageLabel(p.url)}</a>
            {p.title && <span className="hidden min-w-0 truncate text-gray-400 sm:inline dark:text-gray-500">{p.title}</span>}
          </li>
        ))}
      </ol>
    </div>
  );
}
