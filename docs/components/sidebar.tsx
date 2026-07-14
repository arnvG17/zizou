"use client";

import { useState, useEffect } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { navItems } from "@/lib/nav-config";
import { Menu, X } from "lucide-react";

export function Sidebar() {
  const pathname = usePathname();
  const [isOpen, setIsOpen] = useState(false);
  const [activeHash, setActiveHash] = useState("");

  const toggleSidebar = () => setIsOpen(!isOpen);
  const closeSidebar = () => setIsOpen(false);

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

  const renderNavList = () => (
    <div className="space-y-6 font-mono">
      <div>
        <div className="mb-4">
          <h3 className="mb-2 px-4 text-sm font-semibold tracking-wide text-neutral-400">
            Getting started
          </h3>
        </div>
        <ul className="space-y-1">
          {navItems.map((item) => {
            const href = item.hash ? `/${item.slug}#${item.hash}` : `/${item.slug}`;
            const isPageActive = pathname === `/${item.slug}`;
            const isHashActive = activeHash === (item.hash ? `#${item.hash}` : "");
            const isActive = isPageActive && isHashActive;

            return (
              <li key={item.sidebarLabel}>
                <Link
                  href={href}
                  onClick={closeSidebar}
                  className={`block rounded-lg px-4 py-2 text-sm font-medium transition-colors ${
                    isActive
                      ? "bg-orange-600/20 text-orange-400"
                      : "text-neutral-400 hover:bg-neutral-800 hover:text-white"
                  }`}
                >
                  {item.sidebarLabel}
                </Link>
              </li>
            );
          })}
        </ul>
      </div>
    </div>
  );

  return (
    <>
      {/* Mobile Toggle Bar */}
      <div className="flex h-14 items-center justify-between border-b border-current border-opacity-15 px-4 md:hidden bg-customBg/80 backdrop-blur-md fixed top-0 left-0 right-0 z-30 text-customText">
        <Link href="/" className="flex items-center gap-2">
          <span className="font-pixel-square text-xs font-bold text-accent">▲ zizou</span>
          <span className="font-mono text-[9px] opacity-50">v0.1</span>
        </Link>
        <button
          onClick={toggleSidebar}
          aria-label="Toggle Sidebar"
          className="rounded border border-current border-opacity-15 p-1.5 text-neutral-400 hover:text-white transition-colors"
        >
          {isOpen ? <X size={18} /> : <Menu size={18} />}
        </button>
      </div>

      {/* Desktop Sidebar (Sticky side column) */}
      <aside className="hidden w-72 shrink-0 border-r border-current border-opacity-15 px-4 py-8 md:block sticky top-0 h-screen overflow-y-auto bg-customBg text-customText">
        {renderNavList()}
      </aside>

      {/* Mobile Drawer Backdrop */}
      {isOpen && (
        <div
          className="fixed inset-0 z-40 bg-black/60 backdrop-blur-sm md:hidden"
          onClick={closeSidebar}
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
            <span className="font-pixel-square text-sm font-bold text-accent">▲ zizou</span>
            <span className="font-mono text-[9px] opacity-50">v0.1</span>
          </Link>
          <button
            onClick={toggleSidebar}
            aria-label="Close Sidebar"
            className="rounded border border-current border-opacity-15 p-1.5 text-neutral-400 hover:text-white"
          >
            <X size={16} />
          </button>
        </div>
        {renderNavList()}
      </aside>
    </>
  );
}
