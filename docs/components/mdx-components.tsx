import React from "react";
import { CodeBlock } from "./code-block";
import { InstallTabs } from "./install-tabs";

function getRawText(node: any): string {
  if (!node) return "";
  if (typeof node === "string") return node;
  if (typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(getRawText).join("");
  if (node.props && node.props.children) return getRawText(node.props.children);
  return "";
}

export const mdxComponents = {
  pre: (props: any) => <CodeBlock {...props} />,
  InstallTabs: (props: any) => <InstallTabs {...props} />,
  blockquote: (props: any) => {
    const rawText = getRawText(props.children);
    let type: "note" | "important" | "warning" | "caution" | null = null;
    let cleanText = rawText;

    if (rawText.startsWith("[!NOTE]")) {
      type = "note";
      cleanText = rawText.replace("[!NOTE]", "").trim();
    } else if (rawText.startsWith("[!IMPORTANT]")) {
      type = "important";
      cleanText = rawText.replace("[!IMPORTANT]", "").trim();
    } else if (rawText.startsWith("[!WARNING]")) {
      type = "warning";
      cleanText = rawText.replace("[!WARNING]", "").trim();
    } else if (rawText.startsWith("[!CAUTION]")) {
      type = "caution";
      cleanText = rawText.replace("[!CAUTION]", "").trim();
    }

    if (!type) {
      return (
        <blockquote className="my-6 border-l-4 border-neutral-700 pl-4 italic text-neutral-400">
          {props.children}
        </blockquote>
      );
    }

    // Callout configs matching gold/yellow outline box mockup styles
    const typeConfig = {
      note: {
        border: "border-accent/40",
        bg: "bg-neutral-950",
        text: "text-accent",
        label: "NOTE",
      },
      important: {
        border: "border-accent/40",
        bg: "bg-neutral-950",
        text: "text-accent",
        label: "IMPORTANT",
      },
      warning: {
        border: "border-accent/40",
        bg: "bg-neutral-950",
        text: "text-accent",
        label: "ROADMAP",
      },
      caution: {
        border: "border-red-500/40",
        bg: "bg-neutral-950",
        text: "text-red-500",
        label: "CAUTION",
      },
    };

    const config = typeConfig[type];

    // Split paragraphs in the callout if there are multiple lines (like roadmaps)
    const lines = cleanText.split("\n").map((line) => line.trim()).filter(Boolean);

    return (
      <div className={`my-6 rounded border ${config.border} ${config.bg} p-5 font-mono`}>
        <div className={`text-[10px] font-bold tracking-widest ${config.text} mb-3 uppercase font-pixel-square`}>
          ⚠ {config.label}
        </div>
        <div className="space-y-2">
          {lines.map((line, idx) => {
            const isBullet = line.startsWith("-") || line.startsWith("*");
            const displayText = isBullet ? line.substring(1).trim() : line;
            return (
              <p
                key={idx}
                className={`m-0 text-xs text-neutral-300 leading-relaxed font-pixel-line ${
                  isBullet ? "pl-4 relative before:content-['→'] before:absolute before:left-0 before:text-accent-blue before:font-pixel-square" : ""
                }`}
              >
                {displayText}
              </p>
            );
          })}
        </div>
      </div>
    );
  },
};
