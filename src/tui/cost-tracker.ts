// src/tui/cost-tracker.ts
//
// LAYER: tui/
//
// Cost tracking and display for AI model usage.
// Accumulates token counts and calculates cost based on provider rates.

interface UsageEntry {
  model: string;
  inputTokens: number;
  outputTokens: number;
}

/**
 * Per-1M-token rates in USD.
 * Updated manually as pricing changes.
 */
const RATE_TABLE: Record<string, { input: number; output: number }> = {
  // Anthropic
  "claude-3-5-sonnet-latest": { input: 3.0, output: 15.0 },
  "claude-3-5-haiku-latest": { input: 0.8, output: 4.0 },
  "claude-3-opus-20240229": { input: 15.0, output: 75.0 },
  
  // OpenAI
  "gpt-4o": { input: 2.5, output: 10.0 },
  "gpt-4o-mini": { input: 0.15, output: 0.6 },
  "o1-mini": { input: 1.1, output: 4.4 },
  
  // Google
  "gemini-2.0-flash": { input: 0.075, output: 0.3 },
  "gemini-2.5-flash": { input: 0.075, output: 0.3 },
  "gemini-1.5-pro": { input: 1.25, output: 5.0 },
  "gemini-1.5-flash": { input: 0.075, output: 0.3 },
  
  // Groq
  "llama-3.3-70b-versatile": { input: 0.59, output: 0.79 },
  "mixtral-8x7b-32768": { input: 0.27, output: 0.27 },
  "llama-3.1-8b-instant": { input: 0.05, output: 0.05 },
  "gemma2-9b-it": { input: 0.1, output: 0.1 },
  
  // Default fallback for unknown models
  "default": { input: 1.0, output: 5.0 },
};

/**
 * Estimates the total cost for a list of usage entries.
 * 
 * @param entries - Array of usage entries with model and token counts
 * @returns Total estimated cost in USD
 */
export function estimateCost(entries: UsageEntry[]): number {
  return entries.reduce((total, entry) => {
    const rate = RATE_TABLE[entry.model] || RATE_TABLE["default"];
    if (!rate) return total; // Unknown model — skip rather than guess
    
    const inputCost = (entry.inputTokens / 1_000_000) * rate.input;
    const outputCost = (entry.outputTokens / 1_000_000) * rate.output;
    
    return total + inputCost + outputCost;
  }, 0);
}

/**
 * Formats a cost value for display.
 * 
 * @param cost - Cost in USD
 * @returns Formatted string (e.g., "$0.0123")
 */
export function formatCost(cost: number): string {
  return `$${cost.toFixed(4)}`;
}

/**
 * Gets the rate for a specific model.
 * 
 * @param model - Model identifier
 * @returns Rate object or null if model not found
 */
export function getModelRate(model: string): { input: number; output: number } | null {
  return RATE_TABLE[model] || null;
}