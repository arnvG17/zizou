"use client";

import React, { useState } from "react";
import { Check, Copy } from "lucide-react";

export interface SnippetProps {
  text: string | string[];
  width?: string;
  dark?: boolean;
}

export function Snippet({ text, width = "auto", dark = false }: SnippetProps) {
  const [copied, setCopied] = useState(false);

  let displayLines: string[] = [];
  if (Array.isArray(text)) {
    displayLines = text;
  } else if (typeof text === "string") {
    displayLines = text.split(/\r?\n|\\n/);
  }

  const fullText = displayLines.join("\n");

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(fullText);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch (err) {
      console.error("Failed to copy", err);
    }
  };

  // Base background and text colors: always dark grey box.
  const containerClasses = "bg-[#2e2e2e] border-neutral-700 text-neutral-200";
  const buttonClasses = "text-neutral-400 hover:text-neutral-200 border-neutral-700 bg-[#3e3e3e] hover:bg-[#4a4a4a]";

  return (
    <div
      style={{ width }}
      className={`flex items-start justify-between gap-3 p-3 rounded-lg border font-mono text-[12px] leading-relaxed relative ${containerClasses}`}
    >
      <div className="flex-1 overflow-x-auto select-all whitespace-pre">
        {displayLines.map((line, idx) => (
          <div key={idx} className="flex items-center gap-2">
            <span className="text-neutral-400 select-none">$</span>
            <span>{line}</span>
          </div>
        ))}
      </div>
      <button
        onClick={handleCopy}
        className={`flex items-center justify-center p-1.5 rounded-md border transition-colors select-none ${buttonClasses}`}
        title={copied ? "Copied" : "Copy to clipboard"}
      >
        {copied ? (
          <Check size={12} className="text-accent" />
        ) : (
          <Copy size={12} />
        )}
      </button>
    </div>
  );
}
