"use client";
import { createContext, useContext, useEffect, useSyncExternalStore } from "react";

type Theme = "light" | "dark";
const Ctx = createContext<{ theme: Theme; toggle: () => void }>({ theme: "light", toggle: () => {} });

// The theme is the visitor's saved choice, read from storage. The server cannot see it, so the first render (on the
// server, and hydrating in the browser) is light, and the saved one follows straight after: reading it during hydration
// made the browser's first render differ from the server's, React error #418 on every dark-mode visit.
const listeners = new Set<() => void>();
const subscribe = (fn: () => void) => { listeners.add(fn); return () => { listeners.delete(fn); }; };
// where storage is blocked (a private window), the choice lives in memory for the visit
let unsaved: Theme | null = null;
const readTheme = (): Theme => {
  if (unsaved) return unsaved;
  try { return localStorage.getItem("theme") === "dark" ? "dark" : "light"; } catch { return "light"; }
};

export function ThemeProvider({ children }: { children: React.ReactNode }) {
  const theme = useSyncExternalStore(subscribe, readTheme, (): Theme => "light");

  useEffect(() => {
    const dark = theme === "dark";
    document.documentElement.classList.toggle("dark", dark);
    const color = dark ? "#0a0a0a" : "#ffffff";
    document.querySelector('meta[name="theme-color"]')?.remove();
    const meta = document.createElement("meta");
    meta.name = "theme-color";
    meta.content = color;
    document.head.appendChild(meta);

    // Force Safari to re-evaluate the theme-color and repaint browser chrome
    history.replaceState(null, "", window.location.href);

    // Trigger a micro-scroll to force status bar repaint on older iOS
    const y = window.scrollY;
    window.scrollTo(0, y === 0 ? 1 : 0);
    requestAnimationFrame(() => window.scrollTo(0, y));
  }, [theme]);

  function toggle() {
    const next: Theme = readTheme() === "light" ? "dark" : "light";
    try { localStorage.setItem("theme", next); unsaved = null; } catch { unsaved = next; }
    listeners.forEach((l) => l());
  }

  const safeAreaBg = theme === "dark" ? "#0a0a0a" : "#ffffff";

  return (
    <Ctx.Provider value={{ theme, toggle }}>
      <div aria-hidden style={{ position: "fixed", top: 0, left: 0, right: 0, height: "env(safe-area-inset-top, 0px)", background: safeAreaBg, zIndex: 9999, pointerEvents: "none" }} />
      <div aria-hidden style={{ position: "fixed", bottom: 0, left: 0, right: 0, height: "env(safe-area-inset-bottom, 0px)", background: safeAreaBg, zIndex: 9999, pointerEvents: "none" }} />
      {children}
    </Ctx.Provider>
  );
}

export function useTheme() { return useContext(Ctx); }
