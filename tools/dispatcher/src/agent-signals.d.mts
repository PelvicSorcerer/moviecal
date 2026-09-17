// Minimal type declarations for the handful of agent-signals.mjs exports the
// Next.js Agent Session receiver route (src/app/api/agent-session/route.ts)
// imports directly, so it can reuse this module's HMAC verification and
// signal normalization without TypeScript's `allowJs: false` forcing a
// reimplementation. Kept intentionally narrow -- only what the receiver
// actually calls -- rather than a full re-declaration of every export;
// dispatcher-side callers are plain .mjs and never consult this file.

export declare const WEBHOOK_SIGNATURE_HEADER: string;
export declare const AGENT_SESSION_WEBHOOK_TYPE: string;
export declare const WEBHOOK_MAX_AGE_MS: number;

export declare function verifyWebhookSignature(
  rawBody: string | null | undefined,
  signature: string | null | undefined,
  secret: string | null | undefined,
): { ok: boolean; reason: string | null };
