"use client";

import { useEffect, useRef } from "react";

// The agent's face: Studio's centrepiece. A glossy black head, like a small robot's screen, with two glowing eyes that
// follow the cursor around the page while the head leans a little towards it. The eyes blink at an uneven rhythm and
// show what the build is doing: narrowed and glancing up while the draft is written, scanning side to side while the
// tests run, a focused squint while it improves, happy arcs when it is done, drooping if it failed.
//
// Following the cursor runs in a requestAnimationFrame loop with easing, never in React state, so it costs no renders.
// With reduced motion asked for, the face looks straight ahead and holds still.

export type CoreState = "idle" | "drafting" | "testing" | "improving" | "ready" | "failed";

export default function AgentCore({ state = "idle", size = 240, label }: { state?: CoreState; size?: number; label?: string }) {
  const root = useRef<HTMLDivElement>(null);
  const head = useRef<HTMLDivElement>(null);
  const look = useRef<SVGGElement>(null);
  const lids = useRef<SVGGElement>(null);

  useEffect(() => {
    const el = root.current;
    if (!el || window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    let tx = 0, ty = 0, x = 0, y = 0, raf = 0, idleAt = performance.now();
    const onMove = (e: PointerEvent) => {
      const r = el.getBoundingClientRect();
      const dx = e.clientX - (r.left + r.width / 2);
      const dy = e.clientY - (r.top + r.height / 2);
      const d = Math.hypot(dx, dy) || 1;
      // the further away the cursor, the further the eyes turn, up to a limit
      const reach = Math.min(1, d / (r.width * 1.4));
      tx = (dx / d) * reach;
      ty = (dy / d) * reach;
      idleAt = performance.now();
    };
    const tick = (now: number) => {
      // left alone, it looks around by itself
      if (now - idleAt > 3_500) {
        const t = now / 1_000;
        tx = Math.sin(t * 0.55) * 0.55 + Math.sin(t * 1.7) * 0.08;
        ty = Math.cos(t * 0.4) * 0.3;
      }
      x += (tx - x) * 0.14;
      y += (ty - y) * 0.14;
      look.current?.setAttribute("transform", `translate(${(x * 20).toFixed(2)} ${(y * 14).toFixed(2)})`);
      if (head.current) head.current.style.transform = `perspective(800px) rotateY(${(x * 12).toFixed(2)}deg) rotateX(${(-y * 10).toFixed(2)}deg) translateZ(0)`;
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    window.addEventListener("pointermove", onMove, { passive: true });
    // blinks: mostly single, now and then a double
    let blinkT: ReturnType<typeof setTimeout>;
    const blink = () => {
      const g = lids.current;
      if (g) {
        const once = [{ transform: "scaleY(1)" }, { transform: "scaleY(0.08)" }, { transform: "scaleY(1)" }];
        g.animate(once, { duration: 160, easing: "ease-in-out" });
        if (Math.random() < 0.22) setTimeout(() => g.animate(once, { duration: 150, easing: "ease-in-out" }), 230);
      }
      blinkT = setTimeout(blink, 2_400 + Math.random() * 3_600);
    };
    blinkT = setTimeout(blink, 1_400);
    return () => { cancelAnimationFrame(raf); clearTimeout(blinkT); window.removeEventListener("pointermove", onMove); };
  }, []);

  const h = Math.round(size * 0.72);
  return (
    <div ref={root} className={`agent-face is-${state}`} style={{ width: size, height: h }} role="img" aria-label={label ?? `Agent: ${state}`}>
      <div ref={head} className="agent-face-head">
        <svg viewBox="0 0 240 172" width={size} height={h} aria-hidden="true">
          <defs>
            <linearGradient id="face-shell" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="#2a2a2f" />
              <stop offset="55%" stopColor="#111114" />
              <stop offset="100%" stopColor="#050506" />
            </linearGradient>
            <radialGradient id="face-screen" cx="50%" cy="38%" r="70%">
              <stop offset="0%" stopColor="#141418" />
              <stop offset="100%" stopColor="#000000" />
            </radialGradient>
            <linearGradient id="face-gloss" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="#ffffff" stopOpacity="0.16" />
              <stop offset="100%" stopColor="#ffffff" stopOpacity="0" />
            </linearGradient>
            <filter id="face-glow" x="-60%" y="-60%" width="220%" height="220%">
              <feGaussianBlur stdDeviation="7" />
            </filter>
          </defs>

          {/* the head and its screen */}
          <rect x="6" y="6" width="228" height="160" rx="52" fill="url(#face-shell)" className="face-shell" />
          <rect x="6.5" y="6.5" width="227" height="159" rx="51.5" fill="none" className="face-edge" />
          <rect x="20" y="20" width="200" height="132" rx="40" fill="url(#face-screen)" />
          <path d="M44 24 H196 a36 36 0 0 1 20 10 Q120 46 26 40 a36 36 0 0 1 18 -16 Z" fill="url(#face-gloss)" />

          {/* the eyes: they follow the cursor (look), blink (lids), and take the build's expression (mood) */}
          <g ref={look}>
            <g className="face-mood">
              <g ref={lids} className="face-lids">
                <g className="face-eyes-glow" filter="url(#face-glow)">
                  <rect x="70" y="60" width="32" height="52" rx="16" />
                  <rect x="138" y="60" width="32" height="52" rx="16" />
                </g>
                <g className="face-eyes">
                  <rect x="70" y="60" width="32" height="52" rx="16" />
                  <rect x="138" y="60" width="32" height="52" rx="16" />
                </g>
              </g>
              {/* happy eyes, shown when the build is done */}
              <g className="face-happy">
                <path d="M72 96 Q86 70 100 96" />
                <path d="M140 96 Q154 70 168 96" />
              </g>
            </g>
          </g>
        </svg>
      </div>
      <div className="agent-face-shadow" aria-hidden />
    </div>
  );
}
