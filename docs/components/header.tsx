"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

export function Header() {
  const pathname = usePathname();
  const isDocs = pathname !== "/";

  return (
    <header className="border-b border-current border-opacity-15 bg-customBg text-customText px-6 py-4 flex items-center justify-between sticky top-0 z-30 font-mono transition-colors">
      <div className="flex items-center gap-3">
        <Link href="/" className="flex items-center gap-2">
          {/* Logo with yellow/orange triangle */}
          <span className="text-accent text-sm font-bold animate-pulse">▲</span>
          <span className="font-pixel-square text-lg font-bold tracking-wider text-customText">zizou</span>
        </Link>
        <span className="hidden sm:inline-block rounded-full border border-current border-opacity-15 px-2 py-0.5 text-[9px] text-neutral-400 dark:text-neutral-500 bg-neutral-900/5 dark:bg-white/5">
          v0.1 · phase 1
        </span>
      </div>

      <nav className="flex items-center gap-6 text-[10px] uppercase font-bold tracking-widest">
        <Link
          href="/"
          className={`hover:text-accent transition-colors ${
            !isDocs ? "text-accent" : "text-neutral-400 dark:text-neutral-500"
          }`}
        >
          Home
        </Link>
        <Link
          href="/getting-started"
          className={`hover:text-accent transition-colors ${
            isDocs ? "text-accent" : "text-neutral-400 dark:text-neutral-500"
          }`}
        >
          Docs
        </Link>
        <a
          href="https://github.com/arnvG17/zizou"
          target="_blank"
          rel="noopener noreferrer"
          className="text-neutral-400 dark:text-neutral-500 hover:text-customText transition-colors"
        >
          Github
        </a>
        <Link
          href="/getting-started#installation"
          className="bg-accent text-black dark:text-black px-4 py-2 hover:bg-customText hover:text-customBg transition-colors rounded font-pixel-square text-[9px] tracking-normal font-bold"
        >
          $ Install
        </Link>
      </nav>
    </header>
  );
}
