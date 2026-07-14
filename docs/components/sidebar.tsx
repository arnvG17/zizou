"use client";

import { useState, useEffect } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { navItems } from "@/lib/nav-config";
import { X } from "lucide-react";

interface SidebarProps {
  isOpen: boolean;
  onClose: () => void;
}

export function Sidebar({ isOpen, onClose }: SidebarProps) {
  const pathname = usePathname();
  const [activeHash, setActiveHash] = useState("");

  // Monitor scroll to update active hash for scrollspy
  useEffect(() => {
    const handleScroll = () => {
      const scrollPosition = window.scrollY + 160; // Offset for header
      const sections = navItems
        .filter((item) => item.slug === pathname.replace(/^\//, ""))
        .map((item) => {
          const id = item.hash || item.slug;
          const element = document.getElementById(id);
          if (element) {
            return { id, offsetTop: element.offsetTop };
          }
          return null;
        })
        .filter(Boolean) as { id: string; offsetTop: number }[];

      // Find current section
      let currentSection = "";
      for (let i = 0; i < sections.length; i++) {
        if (scrollPosition >= sections[i].offsetTop) {
          currentSection = sections[i].id;
        }
      }

      if (currentSection) {
        const matchingItem = navItems.find((item) => (item.hash || item.slug) === currentSection);
        if (matchingItem) {
          setActiveHash(matchingItem.hash ? `#${matchingItem.hash}` : "");
        }
      }
    };

    window.addEventListener("scroll", handleScroll);
    setTimeout(handleScroll, 100);
    return () => window.removeEventListener("scroll", handleScroll);
  }, [pathname]);

  const renderNavList = () => {
    const categories: ("Guide" | "Reference")[] = ["Guide", "Reference"];
    return (
      <div className="space-y-6 font-mono">
        {categories.map((cat) => {
          const items = navItems.filter((item) => item.category === cat);
          if (items.length === 0) return null;
          return (
            <div key={cat}>
              <div className="mb-4">
                <h3 className="mb-2 px-4 text-xs font-semibold tracking-wider text-neutral-400 uppercase">
                  {cat}
                </h3>
              </div>
              <ul className="space-y-1">
                {items.map((item) => {
                  const href = item.hash ? `/${item.slug}#${item.hash}` : `/${item.slug}`;
                  const isPageActive = pathname === `/${item.slug}`;
                  const isHashActive = activeHash === (item.hash ? `#${item.hash}` : "");
                  const isActive = isPageActive && isHashActive;

                  return (
                    <li key={item.sidebarLabel}>
                      <Link
                        href={href}
                        onClick={onClose}
                        className={`block rounded-lg px-4 py-2 text-sm font-medium transition-colors ${
                          isActive
                            ? "bg-accent/15 text-accent"
                            : "text-neutral-500 dark:text-neutral-400 hover:bg-neutral-200/60 dark:hover:bg-neutral-800/60 hover:text-black dark:hover:text-white"
                        }`}
                      >
                        {item.sidebarLabel}
                      </Link>
                    </li>
                  );
                })}
              </ul>
            </div>
          );
        })}
      </div>
    );
  };

  return (
    <>
      {/* Desktop Sidebar (Sticky side column) */}
      <aside className="hidden w-72 shrink-0 border-r border-current border-opacity-15 px-4 py-8 md:block sticky top-0 h-screen overflow-y-auto bg-customBg text-customText">
        {renderNavList()}
      </aside>

      {/* Mobile Drawer Backdrop */}
      {isOpen && (
        <div
          className="fixed inset-0 z-40 bg-black/60 backdrop-blur-sm md:hidden"
          onClick={onClose}
        />
      )}

      {/* Mobile Drawer (Slideout content) */}
      <aside
        className={`fixed bottom-0 top-0 left-0 z-50 w-64 transform border-r border-current border-opacity-15 bg-customBg p-6 shadow-2xl transition-transform duration-300 ease-in-out md:hidden overflow-y-auto text-customText ${
          isOpen ? "translate-x-0" : "-translate-x-full"
        }`}
      >
        <div className="flex items-center justify-between mb-8">
          <Link href="/" className="flex items-center gap-2">
            <span className="text-accent text-sm font-bold animate-pulse font-pixel-line">§</span>
            <span className="font-instrument text-2xl italic text-customText">zizou</span>
          </Link>
          <button
            onClick={onClose}
            aria-label="Close Sidebar"
            className="rounded border border-current border-opacity-15 p-1.5 text-neutral-400 hover:text-white"
          >
            <X size={16} />
          </button>
        </div>
        {renderNavList()}

        {/* Mobile-only additional navigation */}
        <div className="mt-8 border-t border-current border-opacity-15 pt-6 space-y-4 font-mono">
          <Link
            href="/"
            onClick={onClose}
            className="block px-4 text-sm font-medium text-neutral-500 dark:text-neutral-400 hover:text-customText"
          >
            Home
          </Link>
          <a
            href="https://github.com/arnvG17/zizou"
            target="_blank"
            rel="noopener noreferrer"
            className="block px-4 text-sm font-medium text-neutral-500 dark:text-neutral-400 hover:text-customText"
          >
            Github
          </a>
        </div>
      </aside>
    </>
  );
}
