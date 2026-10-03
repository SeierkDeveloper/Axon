"use client";

import { useEffect, useRef, useState } from "react";
import { useWallet } from "@/components/WalletProvider";

// The connected wallet in the header: its address, and a menu to switch to another account or sign out. Shown only
// while a wallet is connected; until then the header keeps its Get Started button. On a phone the same two actions sit
// in the menu (mobile = true).

const short = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;

export default function WalletMenu({ mobile = false, onDone }: { mobile?: boolean; onDone?: () => void }) {
  const { address, disconnect, switchWallet, busy } = useWallet();
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => { if (!box.current?.contains(e.target as Node)) setOpen(false); };
    const esc = (e: KeyboardEvent) => { if (e.key === "Escape") setOpen(false); };
    document.addEventListener("mousedown", close);
    document.addEventListener("keydown", esc);
    return () => { document.removeEventListener("mousedown", close); document.removeEventListener("keydown", esc); };
  }, [open]);

  if (!address) return null;
  const signOut = () => { setOpen(false); disconnect(); onDone?.(); };
  const change = () => { setOpen(false); onDone?.(); void switchWallet(); };

  if (mobile) {
    return (
      <div className="flex items-center gap-2 pt-3">
        <span className="flex flex-1 items-center gap-2 font-mono text-xs text-gray-600 dark:text-gray-300">
          <span className="h-1.5 w-1.5 rounded-full bg-emerald-500" />{short(address)}
        </span>
        <button type="button" onClick={change} disabled={busy} className="rounded-lg border border-gray-200 px-3 py-2 text-xs text-gray-700 transition-colors hover:border-gray-400 disabled:opacity-50 dark:border-gray-700 dark:text-gray-300">Switch wallet</button>
        <button type="button" onClick={signOut} className="rounded-lg border border-gray-200 px-3 py-2 text-xs text-gray-700 transition-colors hover:border-gray-400 dark:border-gray-700 dark:text-gray-300">Sign out</button>
      </div>
    );
  }

  return (
    <div ref={box} className="relative hidden sm:block">
      <button type="button" onClick={() => setOpen((v) => !v)} aria-expanded={open} aria-haspopup="menu"
        className="flex items-center gap-2 rounded-md border border-gray-200 px-3 py-1.5 font-mono text-xs text-gray-700 transition-colors hover:border-gray-400 dark:border-gray-700 dark:text-gray-300 dark:hover:border-gray-500">
        <span className="h-1.5 w-1.5 rounded-full bg-emerald-500" />
        {short(address)}
      </button>
      {open && (
        <div role="menu" className="absolute right-0 top-full mt-2 w-56 overflow-hidden rounded-xl border border-gray-200 bg-white shadow-lg dark:border-gray-800 dark:bg-gray-950">
          <p className="border-b border-gray-100 px-4 py-3 text-xs text-gray-400 dark:border-gray-800">Signed in as<br /><span className="font-mono text-gray-700 dark:text-gray-300">{short(address)}</span></p>
          <button type="button" role="menuitem" onClick={change} disabled={busy} className="block w-full px-4 py-2.5 text-left text-sm text-gray-700 transition-colors hover:bg-gray-50 disabled:opacity-50 dark:text-gray-300 dark:hover:bg-gray-900">Switch wallet</button>
          <button type="button" role="menuitem" onClick={signOut} className="block w-full px-4 py-2.5 text-left text-sm text-gray-700 transition-colors hover:bg-gray-50 dark:text-gray-300 dark:hover:bg-gray-900">Sign out</button>
        </div>
      )}
    </div>
  );
}
