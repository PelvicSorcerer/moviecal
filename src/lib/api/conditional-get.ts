import { createHash } from 'node:crypto';
import { NextResponse } from 'next/server';

export function createConditionalJsonResponse(
  request: Request,
  value: unknown,
): NextResponse {
  const body = JSON.stringify(value);
  const etag = `"${createHash('sha256').update(body).digest('hex')}"`;
  const headers = {
    ETag: etag,
    'Cache-Control': 'private, no-cache',
  };
  const ifNoneMatch = request.headers.get('if-none-match');
  const matches = ifNoneMatch?.trim() === '*'
    || (ifNoneMatch ?? '').split(',').some((candidate) =>
      candidate.trim().replace(/^W\//, '') === etag,
    );

  if (matches) {
    return new NextResponse(null, { status: 304, headers });
  }

  return new NextResponse(body, {
    headers: { ...headers, 'Content-Type': 'application/json' },
  });
}
