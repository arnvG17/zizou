"use client";

import React, { useState, useRef } from "react";
import { Check, Copy } from "lucide-react";

function getRawText(node: any): string {
  if (!node) return "";
  if (typeof node === "string") return node;
  if (typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(getRawText).join("");
  if (node.props && node.props.children) return getRawText(node.props.children);
  return "";
}

export function CodeBlock({ children }: { children: React.ReactNode }) {
  const [copied, setCopied] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  const handleCopy = async () => {
    const rawText = getRawText(children);
    try {
      await navigator.clipboard.writeText(rawText);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch (err) {
      console.error("Failed to copy!", err);
    }
  };

  return (
    <div ref={containerRef} className="group relative my-6 overflow-hidden rounded-lg border border-neutral-900 bg-neutral-950 shadow-md">
      {/* Code Header Bar mimicking console mockup */}
      <div className="flex items-center justify-between border-b border-neutral-900 px-4 py-3 bg-neutral-950 font-mono text-[9px]">
        {/* Grey window dot controls */}
        <div className="flex items-center gap-1.5">
          <span className="h-1.5 w-1.5 rounded-full bg-neutral-800" />
          <span className="h-1.5 w-1.5 rounded-full bg-neutral-800" />
          <span className="h-1.5 w-1.5 rounded-full bg-neutral-800" />
          <span className="text-neutral-500 font-bold ml-2 tracking-widest uppercase">BASH</span>
        </div>
        
        <button
          onClick={handleCopy}
          className="flex items-center gap-1.5 text-neutral-400 hover:text-white transition-colors font-mono text-[9px] uppercase tracking-wider bg-transparent border-none outline-none"
          title="Copy Code"
        >
          {copied ? (
            <>
              <Check size={10} className="text-accent" />
              <span className="text-accent font-bold">COPIED</span>
            </>
          ) : (
            <>
              <Copy size={10} />
              <span>COPY</span>
            </>
          )}
        </button>
      </div>
      
      {/* Code Display Area */}
      <div className="overflow-x-auto p-4 text-[11px] font-mono leading-relaxed text-neutral-200 bg-black">
        {children}
      </div>
    </div>
  );
}
