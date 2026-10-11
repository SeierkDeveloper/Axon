"use client";

import { useEffect, useState } from "react";

/** A step's picture as the job's reader is given it: the path and token that fetch it. */
export interface StepShot { id: string; token: string; path: string; size?: number }

/**
 * The picture of the page as it was after one step an agent took in its browser. The bytes are fetched with the
 * picture's own token in a header, never in the address, and drawn from memory: it is not a public image. Shows a
 * quiet placeholder of the right shape until they are here, and nothing if they never come. A click makes it large.
 */
export default function StepPicture({ shot, alt }: { shot: StepShot; alt: string }) {
  const [src, setSrc] = useState<string | null>(null);
  const [gone, setGone] = useState(false);
  const [large, setLarge] = useState(false);
  const { id, path, token } = shot;
  useEffect(() => {
    let alive = true, made: string | null = null;
    void (async () => {
      try {
        const r = await fetch(path, { headers: { "x-file-token": token } });
        if (!r.ok) throw new Error(String(r.status));
        const b = await r.blob();
        if (!alive) return;
        made = URL.createObjectURL(b);
        setSrc(made);
      } catch {
        if (alive) setGone(true);
      }
    })();
    return () => { alive = false; if (made) URL.revokeObjectURL(made); };
  }, [id, path, token]);
  if (gone) return <p className="mt-1.5 text-[11px] text-gray-400 dark:text-gray-500">The picture of this step is no longer kept.</p>;
  if (!src) return <div className="mt-1.5 aspect-[16/10] w-full max-w-md animate-pulse rounded-md border border-gray-200 bg-gray-100 dark:border-gray-800 dark:bg-gray-900" aria-hidden />;
  return (
    <button type="button" onClick={() => setLarge((v) => !v)} title={large ? "Make it smaller" : "Make it larger"} className={`mt-1.5 block overflow-hidden rounded-md border border-gray-200 bg-white text-left dark:border-gray-800 ${large ? "w-full" : "w-full max-w-md"}`}>
      {/* eslint-disable-next-line @next/next/no-img-element -- bytes fetched with a token, not a public image the optimizer can reach */}
      <img src={src} alt={alt} className="block h-auto w-full" />
    </button>
  );
}
