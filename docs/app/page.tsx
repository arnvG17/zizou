"use client";

import React, { useState, useEffect } from "react";
import Link from "next/link";
import { Header } from "@/components/header";
import { Moon, Sun, Tv } from "lucide-react";
import { TerminalDemo } from "@/components/terminal-demo";

export default function Home() {
  const [isDarkMode, setIsDarkMode] = useState(true);
  const [hasScanlines, setHasScanlines] = useState(false);

  useEffect(() => {
    const root = window.document.documentElement;
    if (isDarkMode) {
      root.classList.add("dark");
    } else {
      root.classList.remove("dark");
    }
  }, [isDarkMode]);

  return (
    <div className="min-h-screen flex flex-col bg-customBg text-customText transition-colors duration-300 relative paper-grain font-pixel-line">
      {/* Fractal Noise/Paper Grain Overlay */}

      <div className="pointer-events-none fixed inset-0 z-50 opacity-[0.05] dark:opacity-[0.03] mix-blend-overlay paper-grain-bg" />

      {/* Retro Scanline Overlay */}
      {hasScanlines && (
        <div className="pointer-events-none fixed inset-0 z-50 opacity-[0.03] bg-[linear-gradient(rgba(18,16,16,0)_50%,rgba(0,0,0,0.25)_50%)] bg-[size:100%_4px]" />
      )}

      {/* Shared Header */}
      <Header />

      {/* Extra floating bar for Home Page controls */}
      <div className="bg-black/40 border-b border-current border-opacity-10 px-6 py-2 flex items-center justify-between z-20 text-white font-mono text-[9px]">
        <div className="flex items-center gap-2">
          <span className="text-accent">●</span>
          <span>SYSTEM ONLINE</span>
        </div>
        <div className="flex items-center gap-3">
          <button
            onClick={() => setHasScanlines(!hasScanlines)}
            title="Toggle CRT Scanlines"
            className={`rounded border border-neutral-800 p-1 transition-all ${
              hasScanlines ? "bg-accent/20 text-accent" : "text-neutral-400 hover:text-white"
            }`}
          >
            <Tv size={10} />
          </button>
          <button
            onClick={() => setIsDarkMode(!isDarkMode)}
            title="Toggle Theme"
            className="rounded border border-neutral-800 p-1 text-neutral-400 hover:text-white transition-all"
          >
            {isDarkMode ? <Sun size={10} /> : <Moon size={10} />}
          </button>
        </div>
      </div>

      {/* Hero Section */}
      <main className="flex-1 flex items-center justify-center px-6 py-12 md:py-20 lg:py-24">
        <div className="max-w-6xl w-full grid grid-cols-1 lg:grid-cols-12 gap-12 items-center">
          
          {/* Left Hero Details */}
          <div className="lg:col-span-6 space-y-6">
            <div className="inline-flex items-center gap-2 rounded-full border border-accent/30 bg-accent/5 px-3 py-1 font-mono text-[9px] uppercase tracking-widest text-accent">
              <span className="h-1 w-1 rounded-full bg-accent animate-ping" />
              Phase 1 · Now Available
            </div>
            
            <h1 className="font-pixel-line text-3xl md:text-5xl lg:text-6xl font-bold leading-[1.1] tracking-normal uppercase">
              An AI coding<br />
              agent that<br />
              lives<br />
              in your<br />
              <span className="text-accent">terminal .</span>
            </h1>


            <p className="font-mono text-xs md:text-sm leading-relaxed text-neutral-600 dark:text-neutral-400 max-w-lg">
              Zizou is an open-source CLI that lets you chat with Claude, GPT-4o,
              Gemini, Llama or your local Ollama models — and gives them the power to
              read files, propose edits, and run sandboxed bash, all with your explicit
              approval.
            </p>

            <div className="flex flex-wrap items-center gap-4 pt-4 font-pixel-square text-[10px]">
              <Link
                href="/getting-started"
                className="bg-accent text-black hover:bg-white hover:text-black transition-colors px-6 py-3.5 rounded font-bold flex items-center gap-2"
              >
                Get Started →
              </Link>
              <Link
                href="/getting-started"
                className="border border-current border-opacity-25 hover:border-accent transition-colors px-6 py-3.5 rounded font-bold text-neutral-600 dark:text-neutral-300 hover:text-white"
              >
                Read the Docs
              </Link>
            </div>
          </div>

          {/* Right Hero — Animated Terminal Demo */}
          <div className="lg:col-span-6">
            <TerminalDemo />
          </div>

        </div>
      </main>
    </div>
  );
}
