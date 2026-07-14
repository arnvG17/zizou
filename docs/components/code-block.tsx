"use client";

import React, { useState, useRef } from "react";
import { Check, Copy, Info, Star } from "lucide-react";

function getRawText(node: any): string {
  if (!node) return "";
  if (typeof node === "string") return node;
  if (typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(getRawText).join("");
  if (node.props && node.props.children) return getRawText(node.props.children);
  return "";
}

interface Tab {
  id: string;
  label: string;
  content: React.ReactNode;
}

interface CodeBlockProps {
  children: React.ReactNode;
  tabs?: Tab[];
  defaultTab?: string;
}

export function CodeBlock({ children, tabs, defaultTab }: CodeBlockProps) {
  const [copied, setCopied] = useState(false);
  const [activeTab, setActiveTab] = useState(defaultTab || tabs?.[0]?.id);
  const containerRef = useRef<HTMLDivElement>(null);

  const handleCopy = async () => {
    const rawText = getRawText(activeTab && tabs ? tabs.find(t => t.id === activeTab)?.content : children);
    try {
      await navigator.clipboard.writeText(rawText);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch (err) {
      console.error("Failed to copy!", err);
    }
  };

  // Helper to extract language name if available
  const getLanguage = () => {
    if (React.isValidElement(children)) {
      const codeProps = (children.props as any);
      const className = codeProps?.className || "";
      const match = className.match(/language-(\w+)/);
      if (match) return match[1].toUpperCase();

      const dataLanguage = codeProps?.["data-language"];
      if (dataLanguage) return dataLanguage.toUpperCase();
    }
    return "BASH";
  };
  const language = getLanguage();

  return (
    <div ref={containerRef} className="group relative mt-3 mb-6 overflow-hidden rounded border border-neutral-800 bg-[#080808]">
      {/* Top Copy Bar / Window Controls */}
      <div className="flex items-center justify-between px-4 py-2.5 bg-black/40 border-b border-neutral-900/60 select-none">
        <div className="flex items-center gap-4">
          {/* Retro Window Controls: Grey, Grey, Accent (Orange/Yellow) */}
          <div className="flex items-center gap-1.5">
            <span className="w-2 h-2 rounded-full bg-neutral-800" />
            <span className="w-2 h-2 rounded-full bg-neutral-700" />
            <span className="w-2 h-2 rounded-full bg-accent" />
          </div>
          <span className="text-[10px] text-neutral-500 font-mono tracking-widest uppercase">{language}</span>
        </div>
        <button
          onClick={handleCopy}
          className="flex items-center gap-1.5 text-[10px] font-mono text-neutral-500 hover:text-neutral-300 transition-colors uppercase tracking-widest"
          title="Copy"
        >
          {copied ? (
            <>
              <Check size={10} className="text-accent" />
              <span>COPIED</span>
            </>
          ) : (
            <>
              <Copy size={10} />
              <span>COPY</span>
            </>
          )}
        </button>
      </div>

      {/* Tab Navigation */}
      {tabs && tabs.length > 0 && (
        <div className="flex items-center gap-1 border-b border-neutral-800 px-2 pt-2">
          {tabs.map((tab) => (
            <button
              key={tab.id}
              onClick={() => setActiveTab(tab.id)}
              className={`px-4 py-2 text-sm font-medium transition-colors border-b-2 -mb-px ${
                activeTab === tab.id
                  ? "border-accent text-accent"
                  : "border-transparent text-neutral-400 hover:text-neutral-200"
              }`}
            >
              {tab.label}
            </button>
          ))}
        </div>
      )}

      {/* Code Display Area */}
      <div className="overflow-x-auto p-4 text-[13px] font-mono leading-relaxed text-neutral-300">
        {tabs && tabs.length > 0 ? tabs.find(t => t.id === activeTab)?.content : children}
      </div>
    </div>
  );
}
