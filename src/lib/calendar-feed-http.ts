import { createHash } from 'node:crypto';

export function buildCalendarFeedEtag(body: string): string {
  return `"${createHash('sha256').update(body).digest('hex')}"`;
}

export function matchesCalendarFeedEtag(
  ifNoneMatch: string | null,
  etag: string,
): boolean {
  if (ifNoneMatch?.trim() === '*') {
    return true;
  }

  return (ifNoneMatch ?? '').split(',').some((candidate) =>
    candidate.trim().replace(/^W\//, '') === etag,
  );
}

export function createCalendarFeedResponse(request: Request, body: string): Response {
  const etag = buildCalendarFeedEtag(body);
  const headers = {
    'Content-Type': 'text/calendar; charset=utf-8',
    'Cache-Control': 'private, max-age=0, must-revalidate',
    ETag: etag,
  };

  if (matchesCalendarFeedEtag(request.headers.get('if-none-match'), etag)) {
    return new Response(null, { status: 304, headers });
  }

  return new Response(body, { headers });
}
