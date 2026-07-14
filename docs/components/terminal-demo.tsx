"use client";

import React, { useState, useEffect, useRef } from "react";

// ─── Demo script ──────────────────────────────────────────────────────────────
// Each frame is either:
//   { type: "prompt", delay }  → shows a blinking cursor waiting to type
//   { type: "line", text, color, delay, indent } → appends a line
//   { type: "pause", delay }   → silent hold

type Color = "default" | "accent" | "green" | "red" | "dim" | "cyan" | "yellow" | "white";

interface ScriptLine {
  type: "line" | "pause" | "divider";
  text?: string;
  color?: Color;
  indent?: boolean;
  delay: number;
}

const SCRIPT: ScriptLine[] = [
  // ── prompt input ────────────────────────────────────────────────────────────
  { type: "line", text: "$ zizou", color: "white", delay: 400 },
  { type: "pause", delay: 600 },

  // ── splash info bar ─────────────────────────────────────────────────────────
  { type: "line", text: "◆ zizou v1.2.9 · phase 1 · connected to anthropic (claude-3-5-sonnet)", color: "accent", delay: 800 },
  { type: "pause", delay: 500 },

  // ── user prompt ─────────────────────────────────────────────────────────────
  { type: "line", text: "you > Add JWT authentication — middleware for protected routes, POST /auth/login, and refresh tokens.", color: "cyan", delay: 600 },
  { type: "pause", delay: 1200 },

  // ── clarification ───────────────────────────────────────────────────────────
  { type: "line", text: "ai  > Before I start, a quick question:", color: "accent", delay: 400 },
  { type: "line", text: "     1. Use the existing User model in models/user.js?", color: "dim", delay: 200 },
  { type: "line", text: "     2. In-memory refresh token store, or Redis?", color: "dim", delay: 200 },
  { type: "pause", delay: 1000 },

  { type: "line", text: "you > Yes to the User model. In-memory is fine for now.", color: "cyan", delay: 600 },
  { type: "pause", delay: 1400 },

  // ── repo scan ───────────────────────────────────────────────────────────────
  { type: "line", text: "ai  > scanning repository …", color: "accent", delay: 500 },
  { type: "line", text: "   ▸ tool:glob       ✓  src/**/*.js  (14 files)", color: "dim", indent: true, delay: 400 },
  { type: "line", text: "   ▸ tool:readFile   ✓  src/server.js  (3.1 kb)", color: "dim", indent: true, delay: 500 },
  { type: "line", text: "   ▸ tool:readFile   ✓  src/routes/users.js  (1.2 kb)", color: "dim", indent: true, delay: 500 },
  { type: "line", text: "   ▸ tool:readFile   ✓  src/models/user.js  (0.9 kb)", color: "dim", indent: true, delay: 500 },
  { type: "pause", delay: 800 },

  // ── plan display ─────────────────────────────────────────────────────────────
  { type: "line", text: "ai  > Here's my plan — approve to proceed:", color: "accent", delay: 400 },
  { type: "line", text: "     Step 1/4  install jsonwebtoken bcryptjs", color: "dim", delay: 200 },
  { type: "line", text: "     Step 2/4  write src/middleware/auth.js", color: "dim", delay: 200 },
  { type: "line", text: "     Step 3/4  write src/routes/auth.js  (login + refresh)", color: "dim", delay: 200 },
  { type: "line", text: "     Step 4/4  patch src/server.js to wire middleware", color: "dim", delay: 200 },
  { type: "line", text: "ai  > proceed? [y/N]", color: "accent", delay: 500 },
  { type: "pause", delay: 1000 },

  { type: "line", text: "you > y", color: "cyan", delay: 300 },
  { type: "pause", delay: 600 },

  // ── execution ───────────────────────────────────────────────────────────────
  { type: "line", text: "ai  > ● Step 1/4  installing dependencies …", color: "accent", delay: 500 },
  { type: "line", text: "   ▸ tool:runBash    ?  approve: npm install jsonwebtoken bcryptjs  [y/N]", color: "yellow", indent: true, delay: 400 },
  { type: "line", text: "you > y", color: "cyan", delay: 300 },
  { type: "line", text: "   ▸ tool:runBash    ✓  added 2 packages in 3.8s", color: "dim", indent: true, delay: 1200 },
  { type: "pause", delay: 400 },

  { type: "line", text: "ai  > ● Step 2/4  writing auth middleware …", color: "accent", delay: 400 },
  { type: "line", text: "   ▸ tool:writeFile  ?  approve: src/middleware/auth.js  [y/N]", color: "yellow", indent: true, delay: 400 },
  { type: "line", text: "you > y", color: "cyan", delay: 300 },
  { type: "line", text: "   ▸ tool:writeFile  ✓  src/middleware/auth.js  (+68 lines)", color: "green", indent: true, delay: 500 },
  { type: "pause", delay: 300 },

  { type: "line", text: "ai  > ● Step 3/4  writing auth routes …", color: "accent", delay: 400 },
  { type: "line", text: "   ▸ tool:writeFile  ?  approve: src/routes/auth.js  [y/N]", color: "yellow", indent: true, delay: 400 },
  { type: "line", text: "you > y", color: "cyan", delay: 300 },
  { type: "line", text: "   ▸ tool:writeFile  ✓  src/routes/auth.js  (+91 lines)", color: "green", indent: true, delay: 500 },
  { type: "pause", delay: 300 },

  { type: "line", text: "ai  > ● Step 4/4  patching server.js …", color: "accent", delay: 400 },
  { type: "line", text: "   ▸ tool:editFile   ?  approve: src/server.js  (+4 -0)  [y/N]", color: "yellow", indent: true, delay: 400 },
  { type: "line", text: "you > y", color: "cyan", delay: 300 },
  { type: "line", text: "   ▸ tool:editFile   ✓  src/server.js  patched", color: "green", indent: true, delay: 500 },
  { type: "pause", delay: 500 },

  // ── verification ─────────────────────────────────────────────────────────────
  { type: "line", text: "ai  > verifying — running test suite …", color: "accent", delay: 500 },
  { type: "line", text: "   ▸ tool:runBash    ?  approve: npm test  [y/N]", color: "yellow", indent: true, delay: 400 },
  { type: "line", text: "you > y", color: "cyan", delay: 300 },
  { type: "line", text: "   ▸ tool:runBash    ✓  9 tests passed  (2.1s)", color: "green", indent: true, delay: 1400 },
  { type: "pause", delay: 600 },

  // ── summary ──────────────────────────────────────────────────────────────────
  { type: "line", text: "ai  > ✓ all 4 steps verified. JWT auth is live.", color: "green", delay: 500 },
  { type: "line", text: "     checkpoint saved  ·  /checkpoint diff to review changes", color: "dim", delay: 200 },
  { type: "pause", delay: 2000 },
];

// ─── Color map ────────────────────────────────────────────────────────────────
const COLOR_CLASSES: Record<Color, string> = {
  default: "text-neutral-300",
  accent:  "text-orange-400",
  green:   "text-emerald-400",
  red:     "text-red-400",
  dim:     "text-neutral-500",
  cyan:    "text-sky-300",
  yellow:  "text-amber-300",
  white:   "text-white",
};

// ─── Component ────────────────────────────────────────────────────────────────
export function TerminalDemo() {
  const [visibleLines, setVisibleLines] = useState<ScriptLine[]>([]);
  const [isRunning, setIsRunning]       = useState(false);
  const [isDone, setIsDone]             = useState(false);
  const bottomRef = useRef<HTMLDivElement>(null);
  const timeoutsRef = useRef<ReturnType<typeof setTimeout>[]>([]);
  const containerRef = useRef<HTMLDivElement>(null);

  // Intersection Observer: start playback when visible
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;

    const obs = new IntersectionObserver(
      ([entry]) => {
        if (entry.isIntersecting && !isRunning && !isDone) {
          startPlayback();
        }
      },
      { threshold: 0.3 }
    );
    obs.observe(el);
    return () => obs.disconnect();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isRunning, isDone]);

  function clearAllTimeouts() {
    timeoutsRef.current.forEach(clearTimeout);
    timeoutsRef.current = [];
  }

  function startPlayback() {
    clearAllTimeouts();
    setVisibleLines([]);
    setIsRunning(true);
    setIsDone(false);

    let elapsed = 0;
    SCRIPT.forEach((frame) => {
      elapsed += frame.delay;
      const t = setTimeout(() => {
        if (frame.type !== "pause") {
          setVisibleLines((prev) => [...prev, frame]);
        }
      }, elapsed);
      timeoutsRef.current.push(t);
    });

    // mark done + restart loop
    const doneTimeout = setTimeout(() => {
      setIsRunning(false);
      setIsDone(true);
      // Auto-restart after 3 s hold
      const restartTimeout = setTimeout(() => {
        startPlayback();
      }, 3000);
      timeoutsRef.current.push(restartTimeout);
    }, elapsed + 200);
    timeoutsRef.current.push(doneTimeout);
  }

  // Smooth scroll to bottom as lines appear
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth", block: "nearest" });
  }, [visibleLines]);

  // Cleanup on unmount
  useEffect(() => () => clearAllTimeouts(), []);

  return (
    <div
      ref={containerRef}
      className="relative w-full rounded-xl border border-neutral-800 shadow-2xl overflow-hidden group hover:border-orange-500/30 transition-colors duration-500"
      style={{ background: "#0d0d0d" }}
    >
      {/* ── Title bar ───────────────────────────────────────────────────────── */}
      <div
        className="flex items-center justify-between px-4 py-3 border-b border-neutral-800"
        style={{ background: "#161616" }}
      >
        <div className="flex items-center gap-2">
          <span className="h-3 w-3 rounded-full bg-red-500/80" />
          <span className="h-3 w-3 rounded-full bg-amber-400/80" />
          <span className="h-3 w-3 rounded-full bg-emerald-500/80" />
        </div>
        <span className="font-mono text-[11px] text-neutral-500 tracking-wider select-none">
          ~/projects/taskflow-api — zizou
        </span>
        {/* Replay button */}
        <button
          onClick={() => startPlayback()}
          className="font-mono text-[10px] text-neutral-600 hover:text-orange-400 transition-colors select-none px-1"
          title="Replay demo"
        >
          ↺
        </button>
      </div>

      {/* ── Terminal body ────────────────────────────────────────────────────── */}
      <div
        className="relative overflow-y-auto font-mono text-[11.5px] leading-[1.75] p-5"
        style={{ height: 420, scrollbarWidth: "none" }}
      >
        {visibleLines.map((line, i) => (
          <div
            key={i}
            className={`${COLOR_CLASSES[line.color ?? "default"]} ${
              line.indent ? "pl-2" : ""
            } animate-fadeIn`}
          >
            {line.text}
          </div>
        ))}

        {/* Blinking cursor */}
        {!isDone && (
          <span className="inline-block w-[7px] h-[14px] bg-orange-400 animate-blink align-middle ml-0.5" />
        )}

        <div ref={bottomRef} />
      </div>

      {/* ── Bottom status bar ────────────────────────────────────────────────── */}
      <div
        className="flex items-center justify-between px-5 py-2 border-t border-neutral-800 font-mono text-[10px] text-neutral-600"
        style={{ background: "#111" }}
      >
        <span>
          <span className="text-orange-400">●</span>{" "}
          {isDone ? "session complete" : isRunning ? "agent thinking…" : "ready"}
        </span>
        <span className="flex items-center gap-3">
          <span>anthropic</span>
          <span className="text-neutral-700">·</span>
          <span>claude-3-5-sonnet</span>
          <span className="text-neutral-700">·</span>
          <span>build mode</span>
        </span>
      </div>

      {/* ── Subtle vignette ─────────────────────────────────────────────────── */}
      <div
        className="pointer-events-none absolute inset-0"
        style={{
          background:
            "linear-gradient(to bottom, rgba(13,13,13,0.15) 0%, transparent 10%, transparent 85%, rgba(13,13,13,0.5) 100%)",
        }}
      />
    </div>
  );
}
