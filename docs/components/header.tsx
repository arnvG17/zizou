"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useTheme } from "./theme-context";
import { Sun, Moon, Menu } from "lucide-react";

interface HeaderProps {
  onMenuClick?: () => void;
  showMenuButton?: boolean;
}

export function Header({ onMenuClick, showMenuButton = false }: HeaderProps) {
  const pathname = usePathname();
  const isDocs = pathname !== "/";
  const { isDarkMode, setIsDarkMode } = useTheme();

  return (
    <header className="border-b border-current border-opacity-15 bg-customBg/85 backdrop-blur-md text-customText px-6 md:px-10 py-4 md:py-6 flex items-center justify-between sticky top-0 z-30 font-mono transition-colors">
      <div className="flex items-center gap-3">
        <Link href="/" className="flex items-center gap-2">
          {/* Logo with section sign */}
          <span className="text-accent text-lg font-bold animate-pulse font-pixel-line">§</span>
          <span className="font-instrument text-3xl italic text-customText">zizou</span>
        </Link>
      </div>

      <nav className="hidden md:flex items-center gap-8 text-xs uppercase font-bold tracking-widest">
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
        
        {/* Sun/Moon Theme Toggle */}
        <button
          onClick={() => setIsDarkMode(!isDarkMode)}
          title="Toggle Theme"
          className="rounded border border-current border-opacity-15 p-1.5 text-neutral-400 dark:text-neutral-500 hover:text-customText transition-all"
        >
          {isDarkMode ? <Sun size={13} /> : <Moon size={13} />}
        </button>

        <Link
          href="/getting-started#installation"
          className="bg-accent text-black dark:text-black px-5 py-2.5 hover:bg-customText hover:text-customBg transition-colors rounded font-pixel-square text-[10px] tracking-normal font-bold"
        >
          $ Install
        </Link>
      </nav>

      {/* Mobile Controls */}
      <div className="flex items-center gap-3 md:hidden">
        {/* Sun/Moon Theme Toggle */}
        <button
          onClick={() => setIsDarkMode(!isDarkMode)}
          title="Toggle Theme"
          className="rounded border border-current border-opacity-15 p-1.5 text-neutral-400 dark:text-neutral-500 hover:text-customText transition-all"
        >
          {isDarkMode ? <Sun size={13} /> : <Moon size={13} />}
        </button>

        {showMenuButton && (
          <button
            onClick={onMenuClick}
            aria-label="Toggle Sidebar"
            className="rounded border border-current border-opacity-15 p-1.5 text-neutral-400 hover:text-customText transition-colors"
          >
            <Menu size={16} />
          </button>
        )}
      </div>
    </header>
  );
}
