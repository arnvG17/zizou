/**
 * check-url.ts — Does the server actually serve?
 *
 * Layer: tools
 * Allowed imports: ./service-registry.js
 *
 * WHY THIS IS NOT managePorts:
 *   managePorts proves a process is BOUND to a port. That is a much weaker
 *   claim than it looks: a Vite server that boots, binds, and then dies on a
 *   bad import can still show as bound for a moment, and a stale process from
 *   a previous session binds the port without serving the current app at all.
 *   The only way to know a web app works is to ask it for a page and look at
 *   the answer.
 *
 *   Node 22 has global fetch, so this costs no dependency.
 */

import { z } from "zod";
import { tool } from "ai";
import { serviceLogTail } from "./service-registry.js";

const DEFAULT_TIMEOUT_MS = 30_000;

/**
 * How much of the body to return.
 *
 * Sized against a real Vite dev server, not guessed. Vite injects a React
 * refresh preamble into <head> that is itself ~700 characters, so a 500-char
 * window showed only the preamble and never reached the app's own markup —
 * which is the entire point of returning a body at all. 1500 clears it with
 * room for the opening of <body>, and is still only a few hundred tokens.
 */
const BODY_HEAD_CHARS = 1500;

export const checkUrl = tool({
  description:
    "Fetch a URL and report what came back — use this to PROVE a web app is actually serving, " +
    "not merely that a process is running. Retries with backoff until the timeout, so it is safe to call " +
    "right after starting a dev server. Returns the status code, content type and the first part of the body, " +
    "so you can confirm you got the app's HTML rather than an error page. " +
    "Pass 'service' to have the server's own log tail included automatically when the probe fails.",
  inputSchema: z.object({
    url: z.string().describe("The URL to fetch, e.g. 'http://localhost:5173'"),
    timeoutMs: z
      .number()
      .optional()
      .describe(`Total time to keep retrying before giving up. Default ${DEFAULT_TIMEOUT_MS}.`),
    expectStatus: z.number().optional().describe("Require this exact status code. Default: any 2xx or 3xx."),
    service: z
      .string()
      .optional()
      .describe("Name of the service serving this URL. On failure, its recent logs are included in the result."),
  }),
  execute: async ({ url, timeoutMs, expectStatus, service }) => {
    const deadline = Date.now() + (timeoutMs ?? DEFAULT_TIMEOUT_MS);
    const started = Date.now();
    let lastError = "";
    let attempts = 0;
    let delay = 250;

    while (Date.now() < deadline) {
      attempts++;
      try {
        const res = await fetch(url, {
          signal: AbortSignal.timeout(Math.min(5000, Math.max(1000, deadline - Date.now()))),
          redirect: "follow",
        });

        const body = await res.text();
        const statusOk = expectStatus ? res.status === expectStatus : res.status >= 200 && res.status < 400;

        if (statusOk) {
          return {
            success: true as const,
            ok: true as const,
            url,
            status: res.status,
            contentType: res.headers.get("content-type") ?? undefined,
            bodyHead: body.slice(0, BODY_HEAD_CHARS),
            elapsedMs: Date.now() - started,
            attempts,
          };
        }

        // A response with the wrong status is a real answer, not a connection
        // problem — report it immediately rather than retrying into the timeout.
        return {
          success: false as const,
          ok: false as const,
          url,
          status: res.status,
          contentType: res.headers.get("content-type") ?? undefined,
          bodyHead: body.slice(0, BODY_HEAD_CHARS),
          elapsedMs: Date.now() - started,
          attempts,
          error: expectStatus
            ? `Expected status ${expectStatus} but got ${res.status}.`
            : `Got status ${res.status}.`,
          ...(service ? { logTail: serviceLogTail(service) } : {}),
        };
      } catch (err) {
        // Connection refused / DNS / abort: the server may still be starting.
        lastError = err instanceof Error ? err.message : String(err);
        const remaining = deadline - Date.now();
        if (remaining <= 0) break;
        await new Promise((r) => setTimeout(r, Math.min(delay, remaining)));
        delay = Math.min(delay * 2, 2000);
      }
    }

    return {
      success: false as const,
      ok: false as const,
      url,
      status: null,
      elapsedMs: Date.now() - started,
      attempts,
      error: `Could not reach ${url} after ${attempts} attempts: ${lastError}`,
      ...(service
        ? { logTail: serviceLogTail(service) ?? "(no logs — is the service name right?)" }
        : {}),
    };
  },
});
