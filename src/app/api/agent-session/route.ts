// MOV-166: the Agent Session receiver approved by MOV-159.
//
// This is the *only* thing this route is authorized to do: verify a Linear
// Agent Session webhook's HMAC signature (never parsing the body for meaning
// first), and relay an already-verified payload to the Mac's outbound stream
// connection. It performs no repository access, holds no GitHub or Linear API
// credential, and cannot cause a mutation on its own -- every consequential
// action still happens on the Mac, behind the dispatcher's own StopController
// and security-policy boundaries. See docs/governance/mov-159-agent-session-receiver-decision.md.
//
// The webhook (POST) and the Mac's stream (GET) are deliberately the same
// route module: Vercel's Fluid compute can serve concurrent requests from one
// warm instance, which is what lets a POST reach an already-open GET's
// module-scope subscriber set without a database or queue service (neither is
// permitted -- MOV-159 is explicit: no new vendor, no durable storage). If a
// POST lands on a different or cold instance than the one holding the Mac's
// connection, the event is buffered here for up to 10 minutes and lost if
// never picked up in that window -- which degrades to 30-second polling, the
// documented, permanent fallback. This is deliberately best-effort, not a
// guaranteed-delivery queue.
//
// HMAC verification and signal normalization are not reimplemented here --
// `verifyWebhookSignature` is imported straight from the dispatcher's own
// tools/dispatcher/src/agent-signals.mjs (typed via the sibling
// agent-signals.d.mts, since this is a TypeScript route and that module has
// no declarations of its own). Everything else -- kind, freshness, trust,
// dedup-by-delivery-id -- happens on the Mac, in `handleAgentSignal`, exactly
// as it already does for the fixture-replay `dispatcher agent-signal` path.
// This route relays the raw, HMAC-verified payload as-is; it never parses it
// for meaning beyond `JSON.parse` (required to store/relay it at all) and
// never logs its content -- only failure *reasons*, which never include
// payload content.

import { timingSafeEqual } from 'node:crypto';

import { NextResponse, type NextRequest } from 'next/server';

import {
  normalizeAgentSessionEvent,
  verifyWebhookSignature,
  WEBHOOK_SIGNATURE_HEADER,
} from '../../../../tools/dispatcher/src/agent-signals.mjs';
import { getServerAgentSessionEnv } from '../../../lib/agent-session/env';
import { apiError } from '../../../lib/api/response';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
// Vercel closes any function invocation at this ceiling regardless of
// streaming activity -- the GET handler's SSE connection is no exception.
// The Mac's stream client already reconnects with backoff on any drop, so a
// forced close here every 300s is just one more ordinary reconnect, not a
// special case to handle.
export const maxDuration = 300;

/** MOV-166's own retention ceiling: an event is held only until a subscriber picks it up, or this long, whichever is first. */
const RETENTION_MS = 10 * 60 * 1000;
const HEARTBEAT_MS = 15_000;

interface BufferedEvent {
  receivedAt: number;
  payload: unknown;
}

// Module-scope state, shared only across requests served by the same warm
// instance -- see the file header. Never written to disk, never logged.
const buffer: BufferedEvent[] = [];
const delivered = new Map<string, number>();
const subscribers = new Set<ReadableStreamDefaultController<Uint8Array>>();
const encoder = new TextEncoder();

function prune(now: number): void {
  while (buffer.length > 0 && now - buffer[0].receivedAt > RETENTION_MS) {
    buffer.shift();
  }
  for (const [key, receivedAt] of delivered) {
    if (now - receivedAt > RETENTION_MS) delivered.delete(key);
  }
}

function sseFrame(event: BufferedEvent): string {
  return `data: ${JSON.stringify(event)}\n\n`;
}

function broadcast(event: BufferedEvent): void {
  const frame = encoder.encode(sseFrame(event));
  for (const controller of subscribers) {
    try {
      controller.enqueue(frame);
    } catch {
      // A subscriber that can no longer accept data will be removed by its
      // own stream's cancel() callback; never let one bad subscriber break
      // the broadcast to the others.
    }
  }
}

function isAuthorizedStreamRequest(request: NextRequest, expected: string | null): boolean {
  if (!expected) return false; // fails closed with no credential configured, same as verifyWebhookSignature

  const authorization = request.headers.get('authorization')?.trim();
  const token = authorization?.startsWith('Bearer ') ? authorization.slice('Bearer '.length).trim() : null;
  if (!token) return false;

  const tokenBytes = Buffer.from(token);
  const expectedBytes = Buffer.from(expected);
  return tokenBytes.length === expectedBytes.length && timingSafeEqual(tokenBytes, expectedBytes);
}

/** Linear's Agent Session webhook delivery. */
export async function POST(request: NextRequest): Promise<NextResponse> {
  const rawBody = await request.text();
  const signature = request.headers.get(WEBHOOK_SIGNATURE_HEADER);
  const { webhookSigningSecret } = getServerAgentSessionEnv();

  const verdict = verifyWebhookSignature(rawBody, signature, webhookSigningSecret);
  if (!verdict.ok) {
    // The reason string never carries payload content (see agent-signals.mjs)
    // -- safe to log for operator visibility, never returned to the caller.
    console.error(`Agent Session webhook rejected: ${verdict.reason}`);
    return apiError('Unauthorized.', 401);
  }

  let payload: unknown;
  try {
    payload = JSON.parse(rawBody);
  } catch {
    return apiError('Malformed payload.', 400);
  }

  // HMAC verification above authenticates the raw bytes. Only then is it
  // safe to inspect the payload's semantics for freshness and delivery
  // identity. Keep those rules centralized in agent-signals.mjs.
  const normalized = normalizeAgentSessionEvent(payload);
  if (!normalized.ok) {
    return apiError('Invalid delivery.', 400);
  }

  const now = Date.now();
  prune(now);
  if (!normalized.key || delivered.has(normalized.key)) {
    return NextResponse.json({ ok: true, duplicate: true });
  }

  const event: BufferedEvent = { receivedAt: now, payload };
  delivered.set(normalized.key, now);
  buffer.push(event);
  broadcast(event);

  return NextResponse.json({ ok: true });
}

/** The Mac's outbound authenticated stream connection. */
export async function GET(request: NextRequest): Promise<Response> {
  const { streamCredential } = getServerAgentSessionEnv();
  if (!isAuthorizedStreamRequest(request, streamCredential)) {
    return apiError('Unauthorized.', 401);
  }

  let ownController: ReadableStreamDefaultController<Uint8Array> | null = null;
  let heartbeat: ReturnType<typeof setInterval> | null = null;

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      ownController = controller;
      subscribers.add(controller);

      const now = Date.now();
      prune(now);
      for (const event of buffer) controller.enqueue(encoder.encode(sseFrame(event)));

      // Keeps the connection alive through intermediary idle timeouts; the
      // Mac's stream client already ignores lines starting with ':'.
      heartbeat = setInterval(() => {
        try {
          controller.enqueue(encoder.encode(':heartbeat\n\n'));
        } catch {
          // controller already closed; cancel() below will have cleaned up
        }
      }, HEARTBEAT_MS);
    },
    cancel() {
      if (ownController) subscribers.delete(ownController);
      if (heartbeat) clearInterval(heartbeat);
    },
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
    },
  });
}
