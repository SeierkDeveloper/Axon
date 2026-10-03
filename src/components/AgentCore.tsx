"use client";

import { useEffect, useRef } from "react";

// The agent core: Studio's living centrepiece. An orb with an eye that follows the cursor around the page, leaning
// a little towards it, and that shows what the build is doing: breathing when idle, orbiting while the draft is
// written, a sweep while the tests run, a spinning ring while it improves, a pulse when it is done. Drawn in the page's
// own ink, so it is black on white in the light theme and white on black in the dark.
//
// The eye moves in a requestAnimationFrame loop with easing, never in React state, so following the cursor costs no
// renders. With reduced motion asked for, it looks straight ahead and nothing animates.

export type CoreState = "idle" | "drafting" | "testing" | "improving" | "ready" | "failed";

export default function AgentCore({ state = "idle", size = 220, label }: { state?: CoreState; size?: number; label?: string }) {
  const root = useRef<HTMLDivElement>(null);
  const body = useRef<HTMLDivElement>(null);
  const pupil = useRef<SVGGElement>(null);
  const lid = useRef<SVGRectElement>(null);

  useEffect(() => {
    const el = root.current;
    if (!el) return;
    const still = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (still) return;
    // where the eye looks, and where it is heading: eased each frame so it glides rather than jumps
    let tx = 0, ty = 0, x = 0, y = 0, raf = 0, idleAt = performance.now();
    const onMove = (e: PointerEvent) => {
      const r = el.getBoundingClientRect();
      const dx = e.clientX - (r.left + r.width / 2);
      const dy = e.clientY - (r.top + r.height / 2);
      const d = Math.hypot(dx, dy) || 1;
      // far away it looks fully that way; close in, less, so it does not go cross-eyed under the cursor
      const reach = Math.min(1, d / (r.width * 1.6));
      tx = (dx / d) * reach;
      ty = (dy / d) * reach;
      idleAt = performance.now();
    };
    const tick = (now: number) => {
      // left alone for a while, it looks about on its own
      if (now - idleAt > 4_000) {
        tx = Math.sin(now / 1_900) * 0.45;
        ty = Math.cos(now / 2_600) * 0.25;
      }
      x += (tx - x) * 0.12;
      y += (ty - y) * 0.12;
      pupil.current?.setAttribute("transform", `translate(${(x * 15).toFixed(2)} ${(y * 13).toFixed(2)})`);
      if (body.current) body.current.style.transform = `perspective(700px) rotateY(${(x * 9).toFixed(2)}deg) rotateX(${(-y * 9).toFixed(2)}deg)`;
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    window.addEventListener("pointermove", onMove, { passive: true });
    // a blink every few seconds, at an uneven rhythm
    let blinkT: ReturnType<typeof setTimeout>;
    const blink = () => {
      lid.current?.animate([{ height: "0" }, { height: "56" }, { height: "0" }], { duration: 170, easing: "ease-in-out" });
      blinkT = setTimeout(blink, 2_600 + Math.random() * 3_800);
    };
    blinkT = setTimeout(blink, 1_800);
    return () => { cancelAnimationFrame(raf); clearTimeout(blinkT); window.removeEventListener("pointermove", onMove); };
  }, []);

  return (
    <div ref={root} className={`agent-core is-${state}`} style={{ width: size, height: size }} role="img" aria-label={label ?? `Agent core: ${state}`}>
      <div ref={body} className="agent-core-body">
        <svg viewBox="0 0 200 200" width={size} height={size} aria-hidden="true">
          <defs>
            <radialGradient id="core-shell" cx="38%" cy="32%" r="75%">
              <stop offset="0%" stopColor="var(--core-hi)" />
              <stop offset="60%" stopColor="var(--core-mid)" />
              <stop offset="100%" stopColor="var(--core-lo)" />
            </radialGradient>
            <radialGradient id="core-iris" cx="50%" cy="50%" r="50%">
              <stop offset="0%" stopColor="var(--core-iris-in)" />
              <stop offset="100%" stopColor="var(--core-iris-out)" />
            </radialGradient>
            <clipPath id="core-eye"><ellipse cx="100" cy="100" rx="42" ry="28" /></clipPath>
          </defs>

          {/* state rings, behind and around the orb */}
          <g className="core-ring core-orbit">
            <circle cx="100" cy="14" r="3.2" />
            <circle cx="186" cy="100" r="2.4" />
            <circle cx="100" cy="186" r="3.2" />
            <circle cx="14" cy="100" r="2.4" />
          </g>
          <circle className="core-ring core-sweep" cx="100" cy="100" r="88" pathLength="100" />
          <circle className="core-ring core-dash" cx="100" cy="100" r="92" pathLength="100" />
          <circle className="core-ring core-pulse" cx="100" cy="100" r="80" />

          {/* the orb */}
          <circle cx="100" cy="100" r="74" fill="url(#core-shell)" className="core-shell" />
          <circle cx="100" cy="100" r="74" fill="none" className="core-rim" />

          {/* the eye: white, iris and pupil that follow the cursor, a lid that blinks */}
          <ellipse cx="100" cy="100" rx="42" ry="28" className="core-white" />
          <g clipPath="url(#core-eye)">
            <g ref={pupil}>
              <circle cx="100" cy="100" r="20" fill="url(#core-iris)" />
              <circle cx="100" cy="100" r="9" className="core-pupil" />
              <circle cx="94" cy="94" r="3.4" className="core-glint" />
            </g>
            <rect ref={lid} x="58" y="72" width="84" height="0" className="core-lid" />
          </g>
          <ellipse cx="100" cy="100" rx="42" ry="28" fill="none" className="core-eye-rim" />
        </svg>
      </div>
    </div>
  );
}
