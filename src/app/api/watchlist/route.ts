import { NextResponse, type NextRequest } from 'next/server';

import { authenticateApiRequest } from '../../../lib/auth/session';

export async function GET(request: NextRequest) {
  const auth = await authenticateApiRequest(request);

  if (auth instanceof NextResponse) {
    return auth;
  }

  const response = NextResponse.json({
    ok: true,
    message: 'watchlist GET placeholder',
    userId: auth.user.id,
  });

  auth.applyAuthCookies(response);

  return response;
}

export async function POST(request: NextRequest) {
  const auth = await authenticateApiRequest(request);

  if (auth instanceof NextResponse) {
    return auth;
  }

  const response = NextResponse.json({
    ok: true,
    message: 'watchlist POST placeholder',
    userId: auth.user.id,
  });

  auth.applyAuthCookies(response);

  return response;
}

export async function DELETE(request: NextRequest) {
  const auth = await authenticateApiRequest(request);

  if (auth instanceof NextResponse) {
    return auth;
  }

  const response = NextResponse.json({
    ok: true,
    message: 'watchlist DELETE placeholder',
    userId: auth.user.id,
  });

  auth.applyAuthCookies(response);

  return response;
}
