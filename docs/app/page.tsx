"use client";

import React from "react";
import Link from "next/link";
import { Header } from "@/components/header";
import { TerminalDemo } from "@/components/terminal-demo";
import { useTheme } from "@/components/theme-context";
import { motion } from "framer-motion";

const containerVariants = {
  hidden: { opacity: 0 },
  visible: {
    opacity: 1,
    transition: {
      staggerChildren: 0.12,
      delayChildren: 0.05,
    },
  },
};

const itemVariants = {
  hidden: { opacity: 0, y: 15 },
  visible: {
    opacity: 1,
    y: 0,
    transition: {
      type: "spring",
      damping: 20,
      stiffness: 100,
    },
  },
};

const rightPanelVariants = {
  hidden: { opacity: 0, x: 25 },
  visible: {
    opacity: 1,
    x: 0,
    transition: {
      type: "spring",
      damping: 25,
      stiffness: 80,
      delay: 0.35,
    },
  },
};

export default function Home() {
  const { hasScanlines } = useTheme();

  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      transition={{ duration: 0.35 }}
      className="min-h-screen flex flex-col bg-customBg text-customText transition-colors duration-500 relative paper-grain font-pixel-line"
    >
      {/* Fractal Noise/Paper Grain Overlay */}
      <div className="pointer-events-none fixed inset-0 z-50 opacity-[0.05] dark:opacity-[0.03] mix-blend-overlay paper-grain-bg" />

      {/* Retro Scanline Overlay */}
      {hasScanlines && (
        <div className="pointer-events-none fixed inset-0 z-50 opacity-[0.03] bg-[linear-gradient(rgba(18,16,16,0)_50%,rgba(0,0,0,0.25)_50%)] bg-[size:100%_4px]" />
      )}

      {/* Shared Header */}
      <Header />

      {/* Hero Section */}
      <main className="flex-1 flex items-center justify-center px-6 py-12 md:py-20 lg:py-24">
        <div className="max-w-6xl w-full grid grid-cols-1 lg:grid-cols-12 gap-12 items-center">
          
          {/* Left Hero Details */}
          <motion.div
            variants={containerVariants}
            initial="hidden"
            animate="visible"
            className="lg:col-span-6 space-y-6"
          >

            <motion.h1
              variants={itemVariants}
              className="font-pixel-line text-3xl md:text-5xl lg:text-6xl font-bold leading-[0.85] tracking-normal uppercase"
            >
              An <span className="font-instrument italic text-[#002395] normal-case tracking-normal font-normal">Ai coding</span><br />
              <span className="font-instrument italic text-[#002395] normal-case tracking-normal font-normal">agent</span> that<br />
              lives in your<br />
              <span className="font-instrument italic text-accent normal-case lowercase tracking-normal font-normal">terminal .</span>
            </motion.h1>

            <motion.p
              variants={itemVariants}
              className="font-mono text-xs md:text-sm leading-relaxed text-neutral-600 dark:text-neutral-450 max-w-lg"
            >
              Zizou is an open-source CLI that lets you chat with Claude, GPT-4o,
              Gemini, Llama or your local Ollama models — and gives them the power to
              read files, propose edits, and run sandboxed bash, all with your explicit
              approval.
            </motion.p>

            <motion.div
              variants={itemVariants}
              className="flex flex-wrap items-center gap-4 pt-4 font-pixel-square text-[10px]"
            >
              <Link
                href="/getting-started"
                className="bg-accent text-black hover:bg-neutral-900 hover:text-white dark:hover:bg-white dark:hover:text-black transition-colors px-6 py-3.5 rounded font-bold flex items-center gap-2"
              >
                Get Started →
              </Link>
              <Link
                href="/getting-started"
                className="border border-current border-opacity-25 hover:border-accent transition-colors px-6 py-3.5 rounded font-bold text-neutral-600 dark:text-neutral-350 hover:text-neutral-800 dark:hover:text-white"
              >
                Read the Docs
              </Link>
            </motion.div>
          </motion.div>

          {/* Right Hero — Animated Terminal Demo */}
          <motion.div
            variants={rightPanelVariants}
            initial="hidden"
            animate="visible"
            className="lg:col-span-6"
          >
            <TerminalDemo />
          </motion.div>

        </div>
      </main>
    </motion.div>
  );
}
