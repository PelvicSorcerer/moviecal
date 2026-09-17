// MOV-166's Testing Expectations call for unit tests of "the receiver's HMAC
// verification, replay/freshness rejection, and dedup-by-delivery-id." This
// route is deliberately signature-only (see route.ts's header): freshness
// (WEBHOOK_MAX_AGE_MS) and dedup-by-delivery-id both happen on the Mac, via
// the *existing, unmodified* agent-signals.mjs `handleAgentSignal`/
// `normalizeAgentSessionEvent` -- covered by
// tools/dispatcher/test/agent-signals.test.mjs (freshness, pre-existing) and
// tools/dispatcher/test/agent-stream-client.test.mjs (dedup across a
// simulated reconnect, retention ceiling, MOV-166). This file covers what the
// receiver actually does: HMAC verify, malformed-payload handling, the
// receiver's own 10-minute relay-buffer retention, and GET-side stream auth
// and SSE framing.

import { createHmac } from 'node:crypto';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const WEBHOOK_SECRET = 'fixture-webhook-secret-not-real';
const STREAM_CREDENTIAL = 'fixture-stream-credential-not-real';
const originalEnv = { ...process.env };

function sign(body: string, secret: string = WEBHOOK_SECRET): string {
  return createHmac('sha256', secret).update(body).digest('hex');
}

function webhookPayload(overrides: Record<string, unknown> = {}) {
  return {
    type: 'AgentSessionEvent',
    action: 'stop',
    webhookId: 'wh-1',
    agentSession: { id: 'session-1', issue: { id: 'uuid-1', identifier: 'MOV-1' } },
    ...overrides,
  };
}

async function readSseText(response: Response, ms = 20): Promise<string> {
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  let text = '';
  const timer = new Promise<void>((resolve) => setTimeout(resolve, ms));
  const pump = (async () => {
    while (true) {
      const { done, value } = await reader.read();
      if (done) return;
      text += decoder.decode(value, { stream: true });
    }
  })();
  await Promise.race([timer, pump]);
  try {
    await reader.cancel();
  } catch {
    // already done
  }
  return text;
}

describe('agent-session receiver route', () => {
  beforeEach(() => {
    vi.resetModules();
    process.env = {
      ...originalEnv,
      LINEAR_WEBHOOK_SIGNING_SECRET: WEBHOOK_SECRET,
      AGENT_SESSION_STREAM_CREDENTIAL: STREAM_CREDENTIAL,
    };
  });

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  describe('POST (Linear webhook)', () => {
    it('accepts a correctly signed delivery', async () => {
      const { POST } = await import('../src/app/api/agent-session/route');
      const body = JSON.stringify(webhookPayload());

      const response = await POST(
        new Request('https://moviecal.test/api/agent-session', {
          method: 'POST',
          headers: { 'linear-signature': sign(body) },
          body,
        }) as never,
      );

      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toEqual({ ok: true });
    });

    it('rejects a delivery with no signature header', async () => {
      const { POST } = await import('../src/app/api/agent-session/route');
      const body = JSON.stringify(webhookPayload());

      const response = await POST(
        new Request('https://moviecal.test/api/agent-session', { method: 'POST', body }) as never,
      );

      expect(response.status).toBe(401);
    });

    it('rejects a tampered body even with a validly-formatted signature', async () => {
      const { POST } = await import('../src/app/api/agent-session/route');
      const body = JSON.stringify(webhookPayload());
      const signature = sign(body);

      const response = await POST(
        new Request('https://moviecal.test/api/agent-session', {
          method: 'POST',
          headers: { 'linear-signature': signature },
          body: `${body} `,
        }) as never,
      );

      expect(response.status).toBe(401);
    });

    it('fails closed when no webhook secret is configured', async () => {
      process.env.LINEAR_WEBHOOK_SIGNING_SECRET = '';
      const { POST } = await import('../src/app/api/agent-session/route');
      const body = JSON.stringify(webhookPayload());

      const response = await POST(
        new Request('https://moviecal.test/api/agent-session', {
          method: 'POST',
          headers: { 'linear-signature': sign(body) },
          body,
        }) as never,
      );

      expect(response.status).toBe(401);
    });

    it('rejects a signed but non-JSON body as malformed', async () => {
      const { POST } = await import('../src/app/api/agent-session/route');
      const body = 'not json';

      const response = await POST(
        new Request('https://moviecal.test/api/agent-session', {
          method: 'POST',
          headers: { 'linear-signature': sign(body) },
          body,
        }) as never,
      );

      expect(response.status).toBe(400);
    });

    it('rejects a correctly signed delivery outside WEBHOOK_MAX_AGE_MS', async () => {
      const { POST } = await import('../src/app/api/agent-session/route');
      const body = JSON.stringify(webhookPayload({ createdAt: '2000-01-01T00:00:00.000Z' }));

      const response = await POST(
        new Request('https://moviecal.test/api/agent-session', {
          method: 'POST', headers: { 'linear-signature': sign(body) }, body,
        }) as never,
      );

      expect(response.status).toBe(400);
    });

    it('acknowledges an authenticated duplicate without relaying it twice', async () => {
      const { POST } = await import('../src/app/api/agent-session/route');
      const body = JSON.stringify(webhookPayload());
      const request = () => new Request('https://moviecal.test/api/agent-session', {
        method: 'POST', headers: { 'linear-signature': sign(body) }, body,
      }) as never;

      expect((await POST(request())).status).toBe(200);
      await expect((await POST(request())).json()).resolves.toEqual({ ok: true, duplicate: true });
    });
  });

  describe("GET (the Mac's outbound stream)", () => {
    it('rejects a missing or wrong bearer credential', async () => {
      const { GET } = await import('../src/app/api/agent-session/route');

      const noAuth = await GET(new Request('https://moviecal.test/api/agent-session') as never);
      expect(noAuth.status).toBe(401);

      const wrongAuth = await GET(
        new Request('https://moviecal.test/api/agent-session', {
          headers: { authorization: 'Bearer wrong-credential' },
        }) as never,
      );
      expect(wrongAuth.status).toBe(401);
    });

    it('fails closed when no stream credential is configured', async () => {
      process.env.AGENT_SESSION_STREAM_CREDENTIAL = '';
      const { GET } = await import('../src/app/api/agent-session/route');

      const response = await GET(
        new Request('https://moviecal.test/api/agent-session', {
          headers: { authorization: `Bearer ${STREAM_CREDENTIAL}` },
        }) as never,
      );
      expect(response.status).toBe(401);
    });

    it('streams a POSTed event to an already-connected subscriber as an SSE frame', async () => {
      const { GET, POST } = await import('../src/app/api/agent-session/route');

      const streamResponse = await GET(
        new Request('https://moviecal.test/api/agent-session', {
          headers: { authorization: `Bearer ${STREAM_CREDENTIAL}` },
        }) as never,
      );
      expect(streamResponse.status).toBe(200);
      expect(streamResponse.headers.get('content-type')).toContain('text/event-stream');

      const body = JSON.stringify(webhookPayload({ action: 'prompted' }));
      await POST(
        new Request('https://moviecal.test/api/agent-session', {
          method: 'POST',
          headers: { 'linear-signature': sign(body) },
          body,
        }) as never,
      );

      const text = await readSseText(streamResponse);
      expect(text).toContain('data: ');
      const parsed = JSON.parse(text.split('data: ')[1].split('\n')[0]);
      expect(parsed.payload).toEqual(webhookPayload({ action: 'prompted' }));
      expect(typeof parsed.receivedAt).toBe('number');
    });

    it('flushes buffered events to a subscriber that connects after they arrived', async () => {
      const { GET, POST } = await import('../src/app/api/agent-session/route');

      const body = JSON.stringify(webhookPayload());
      await POST(
        new Request('https://moviecal.test/api/agent-session', {
          method: 'POST',
          headers: { 'linear-signature': sign(body) },
          body,
        }) as never,
      );

      const streamResponse = await GET(
        new Request('https://moviecal.test/api/agent-session', {
          headers: { authorization: `Bearer ${STREAM_CREDENTIAL}` },
        }) as never,
      );
      const text = await readSseText(streamResponse);
      expect(text).toContain('data: ');
    });

    it("prunes an event past the receiver's own 10-minute retention ceiling before a later subscriber can see it", async () => {
      vi.useFakeTimers();
      try {
        const { GET, POST } = await import('../src/app/api/agent-session/route');
        const body = JSON.stringify(webhookPayload());
        await POST(
          new Request('https://moviecal.test/api/agent-session', {
            method: 'POST',
            headers: { 'linear-signature': sign(body) },
            body,
          }) as never,
        );

        vi.advanceTimersByTime(10 * 60 * 1000 + 1000);

        const streamResponse = await GET(
          new Request('https://moviecal.test/api/agent-session', {
            headers: { authorization: `Bearer ${STREAM_CREDENTIAL}` },
          }) as never,
        );
        vi.useRealTimers();
        const text = await readSseText(streamResponse);
        expect(text).not.toContain('"action":"stop"');
      } finally {
        vi.useRealTimers();
      }
    });
  });
});
