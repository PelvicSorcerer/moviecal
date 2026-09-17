// MOV-166: the two Agent Session receiver secrets, read as *optional* values
// rather than required ones (unlike src/lib/cron/env.ts's getServerCronEnv,
// which throws when unset). Both consumers already fail closed on a missing
// value by design -- verifyWebhookSignature (tools/dispatcher/src/agent-signals.mjs)
// returns { ok: false, reason: "no webhook secret configured" } rather than
// throwing, and the stream endpoint's bearer check simply never matches an
// unset credential. Duplicating that as a thrown exception here would only
// add a second, differently-shaped "not configured" path for the route to
// handle.

const PLACEHOLDER_ENV_VALUES = new Set(['replace-with-a-long-random-secret']);

export interface ServerAgentSessionEnv {
  webhookSigningSecret: string | null;
  streamCredential: string | null;
}

function readOptionalEnv(name: string): string | null {
  const value = process.env[name]?.trim();

  if (!value || PLACEHOLDER_ENV_VALUES.has(value)) {
    return null;
  }

  return value;
}

export function getServerAgentSessionEnv(): ServerAgentSessionEnv {
  return {
    webhookSigningSecret: readOptionalEnv('LINEAR_WEBHOOK_SIGNING_SECRET'),
    streamCredential: readOptionalEnv('AGENT_SESSION_STREAM_CREDENTIAL'),
  };
}
