// src/agent/fallback-tool-parse.ts
//
// LAYER: agent/
//
// Recovery parser for models that cannot reliably emit native tool calls.
//
// WHY THIS EXISTS: small and mid-size open models (observed with llama-3.3-70b
// via Groq, and most 3-4B Ollama models) frequently "describe" a tool call in
// prose instead of using the function-calling protocol. Without this the model
// appears to do nothing at all - it says it wrote the file and no file appears.
// run-turn.ts parses those responses, executes the intended tool, and morphs
// the message so the rest of the loop sees an ordinary native call.
//
// This lived inline in run-turn.ts, where ~200 lines of string wrangling sat
// between the reader and the ~80 lines that are the actual agent loop.
//
// DEPENDENCY DIRECTION: imports nothing from the project. Pure text -> intent.

// ─── JSON sanitisation for small-model fallback ──────────────────────────────
//
// Small LLMs (3B) often dump unescaped literal newlines inside JSON string
// values. This state machine escapes them so JSON.parse won't crash.

function sanitizeJsonString(jsonStr: string): string {
  let inString = false;
  let escaped = false;
  let out = "";

  for (const char of jsonStr) {
    if (char === '"' && !escaped) {
      inString = !inString;
      out += char;
    } else if (char === "\\" && !escaped) {
      escaped = true;
      out += char;
    } else if (char === "\n" && inString) {
      out += "\\n";
    } else if (char === "\r" && inString) {
      out += "\\r";
    } else {
      escaped = false;
      out += char;
    }
  }
  return out;
}

// ─── Raw tool-call extraction for models that can't do native tool use ───────
//
// Handles two classes of malformed output:
//
// CLASS 1 — <function/...> pseudo-tags (observed from llama-3.3-70b via Groq):
//   <function/runBash({"command": "npm install chess.js"})</function>
//   <function/writeFile>{"path": "index.html", "contents": "..."}</function>
//   <function/runBash{"command": "npm install chess.js"}></function>
//
// CLASS 2 — Raw JSON block with name+arguments keys (small-model fallback):
//   {"name": "writeFile", "arguments": {"path": "...", "contents": "..."}}

/**
 * Attempts to extract a tool call from raw assistant text when the model
 * failed to use native function-calling. Tries <function/...> tags first,
 * then raw JSON block parsing, and finally code blocks with file path hints.
 *
 * @returns { name, arguments } if a parseable pseudo-call was found, else null.
 */
export function extractRawToolCall(text: string): { name: string; arguments: any } | null {
  // ── Strategy 1: <function/NAME...> pseudo-tags ───────────────────────
  //
  // Regex captures:
  //   group 1 = function name (word chars)
  //   group 2 = the JSON-ish blob (everything between the outermost { and })
  //
  // The pattern tolerates the three observed delimiters between name and JSON:
  //   NAME(  NAME>  NAME{  (the last one has no delimiter, JSON starts immediately)
  const tagMatch = text.match(
    /<function\/(\w+)\s*[>(]?\s*(\{[\s\S]*\})\s*\)?\s*(?:<\/function>|>\s*(?:<\/function>)?)/
  );

  if (tagMatch) {
    const name = tagMatch[1];
    const parsed = tolerantJsonParse(tagMatch[2]);
    if (parsed !== null) {
      return { name, arguments: parsed };
    }
  }

  // ── Strategy 2: Raw JSON block with name + arguments keys ────────────
  const jsonMatch = text.match(/(?:```(?:json)?\s*)?(\{[\s\S]*?\})(?:\s*```)?/);
  if (jsonMatch) {
    const parsed = tolerantJsonParse(jsonMatch[1]);
    if (
      parsed !== null &&
      typeof parsed === "object" &&
      typeof parsed.name === "string" &&
      typeof parsed.arguments === "object"
    ) {
      return { name: parsed.name, arguments: parsed.arguments };
    }
  }

  // ── Strategy 3: Code block with explicit file path hint ──────────────
  // Catches cases where models dump code in a markdown block instead of making a writeFile call
  const codeBlockCall = extractCodeBlockToolCall(text);
  if (codeBlockCall) {
    return codeBlockCall;
  }

  return null;
}

/**
 * Strategy 3 helper: extracts a synthetic writeFile tool call from a markdown
 * code block if a file path reference precedes it or is inside its header comments.
 */
function extractCodeBlockToolCall(text: string): { name: string; arguments: any } | null {
  const codeBlockRegex = /(?:([^\n]+\n){1,4})?```(?:[a-zA-Z0-9_-]+)?\r?\n([\s\S]+?)\r?\n```/g;
  let match: RegExpExecArray | null;

  const validExts = /\.(ts|tsx|js|jsx|json|html|css|txt|md|py|sh|yaml|yml|rs|go|c|cpp|h)$/i;

  while ((match = codeBlockRegex.exec(text)) !== null) {
    const precedingText = match[1] || "";
    const codeContent = match[2];

    if (!codeContent.trim()) continue;

    const filePatterns = [
      /(?:file|path|filename|create|write|editing|update|in)\s*:?\s*[`"']?([\w./\\-]+?\.[a-zA-Z0-9]+)[`"']?/i,
      /[`"']([\w./\\-]+?\.[a-zA-Z0-9]+)[`"']/,
      /([\w./\\-]+\.[a-zA-Z0-9]+):/
    ];

    let filePath: string | null = null;

    for (const pat of filePatterns) {
      const m = precedingText.match(pat);
      if (m && validExts.test(m[1])) {
        filePath = m[1];
        break;
      }
    }

    if (!filePath) {
      const firstLines = codeContent.split("\n").slice(0, 2).join("\n");
      const commentMatch = firstLines.match(/(?:\/\/\s*|#\s*|<!--\s*)([\w./\\-]+\.[a-zA-Z0-9]+)/);
      if (commentMatch && validExts.test(commentMatch[1])) {
        filePath = commentMatch[1];
      }
    }

    if (filePath) {
      return {
        name: "writeFile",
        arguments: {
          path: filePath,
          contents: codeContent,
        },
      };
    }
  }

  return null;
}

/**
 * Attempts JSON.parse with light repair for common LLM quirks:
 *   - Sanitizes unescaped newlines inside strings
 *   - Strips a stray trailing `)` outside the JSON
 *   - Attempts to close unclosed braces (one level only)
 */
function tolerantJsonParse(raw: string): any | null {
  // First attempt: direct parse after newline sanitization
  const sanitized = sanitizeJsonString(raw.trim());
  try {
    return JSON.parse(sanitized);
  } catch {
    // continue to repair attempts
  }

  // Repair 1: strip trailing `)` that leaks from the (JSON) wrapping
  let repaired = sanitized.replace(/\)\s*$/, "");
  try {
    return JSON.parse(repaired);
  } catch {
    // continue
  }

  // Repair 2: close one unclosed brace
  const opens = (repaired.match(/\{/g) || []).length;
  const closes = (repaired.match(/\}/g) || []).length;
  if (opens > closes) {
    repaired += "}".repeat(opens - closes);
    try {
      return JSON.parse(repaired);
    } catch {
      // give up
    }
  }

  return null;
}

function looksLikePseudoToolCall(text: string): boolean {
  return /<function\/\w+/.test(text) ||
    /"tool_name"\s*:/.test(text) ||
    /"name"\s*:\s*"[a-zA-Z0-9_-]+"/.test(text) ||
    /```[a-zA-Z0-9_-]*\r?\n[\s\S]+?\r?\n```/.test(text);
}

export interface ToolCallAudit {
  nativeCalls: number;
  pseudoCallDetected: boolean;
}

export function auditResponse(hasNativeCalls: boolean, text: string): ToolCallAudit {
  return {
    nativeCalls: hasNativeCalls ? 1 : 0,
    pseudoCallDetected: looksLikePseudoToolCall(text),
  };
}
