"use client";

import React from "react";
import { Sidebar } from "./sidebar";
import { Header } from "./header";
import { Moon, Sun, Tv } from "lucide-react";
import { useTheme } from "./theme-context";
import { motion } from "framer-motion";

import { useState } from "react";

export function DocsLayout({
  children,
  currentSlug,
}: {
  children: React.ReactNode;
  currentSlug: string;
}) {
  const { isDarkMode, setIsDarkMode, hasScanlines, setHasScanlines } = useTheme();
  const [isSidebarOpen, setIsSidebarOpen] = useState(false);

  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      transition={{ duration: 0.35 }}
      className="min-h-screen flex flex-col bg-customBg text-customText transition-colors duration-500 relative paper-grain font-sans"
    >
      {/* Fractal Noise/Paper Grain Overlay */}
      <div className="pointer-events-none fixed inset-0 z-50 opacity-[0.05] dark:opacity-[0.03] mix-blend-overlay paper-grain-bg" />

      {/* Retro Scanline Overlay */}
      {hasScanlines && (
        <div className="pointer-events-none fixed inset-0 z-50 opacity-[0.03] bg-[linear-gradient(rgba(18,16,16,0)_50%,rgba(0,0,0,0.25)_50%)] bg-[size:100%_4px]" />
      )}

      {/* Shared Header */}
      <Header
        showMenuButton={true}
        onMenuClick={() => setIsSidebarOpen(!isSidebarOpen)}
      />

      {/* Main Container */}
      <div className="flex-1 flex flex-col md:flex-row min-w-0">
        {/* Sidebar */}
        <Sidebar
          isOpen={isSidebarOpen}
          onClose={() => setIsSidebarOpen(false)}
        />

        {/* Content Column */}
        <div className="flex-1 flex flex-col min-w-0 relative">
          
          {/* Float controls for docs pages (top right of content pane) */}
          <div className="absolute top-4 right-6 hidden md:flex items-center gap-3 z-20 font-mono text-[9px]">
            <button
              onClick={() => setHasScanlines(!hasScanlines)}
              title="Toggle CRT Scanlines"
              className={`rounded border border-current border-opacity-15 p-1.5 transition-all ${
                hasScanlines ? "bg-accent/20 text-accent" : "text-neutral-400 hover:text-white"
              }`}
            >
              <Tv size={12} />
            </button>
          </div>

          {/* Styled dynamically using custom variables */}
          <main className="flex-1 overflow-y-auto px-6 py-10 md:py-14 flex justify-center bg-customBg text-customText">
            <div className="w-full max-width-768 flex flex-col font-pixel-line">
              {children}
            </div>
          </main>
        </div>
      </div>
    </motion.div>
  );
}
