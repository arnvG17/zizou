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

  return (
    <div ref={containerRef} className="group relative my-6 overflow-hidden rounded-lg border border-neutral-800 bg-neutral-950">
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

      {/* Minimalist Copy Bar */}
      <div className="flex items-center justify-between px-4 py-2 bg-neutral-900/50 border-t border-neutral-800">
        <span className="text-[11px] text-neutral-500 font-mono">bash</span>
        <div className="flex items-center gap-1">
          <button
            className="p-1.5 rounded text-neutral-500 hover:text-neutral-300 hover:bg-neutral-800 transition-colors"
            title="Info"
          >
            <Info size={14} />
          </button>
          <button
            onClick={handleCopy}
            className="p-1.5 rounded text-neutral-500 hover:text-neutral-300 hover:bg-neutral-800 transition-colors"
            title="Copy"
          >
            {copied ? <Check size={14} className="text-green-400" /> : <Copy size={14} />}
          </button>
          <button
            className="p-1.5 rounded text-neutral-500 hover:text-neutral-300 hover:bg-neutral-800 transition-colors"
            title="Star"
          >
            <Star size={14} />
          </button>
        </div>
      </div>
    </div>
  );
}
