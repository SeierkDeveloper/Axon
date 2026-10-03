// While a page renders on the server: a plain screen. The face is PageTransition's, and it waits for this to go, so
// there is only ever one face on screen.
export default function Loading() {
  return <div data-route-loading className="min-h-[70vh] bg-white dark:bg-[#0a0a0a]" role="status" aria-label="Loading" />;
}
