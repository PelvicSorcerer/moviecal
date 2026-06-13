import { NextResponse } from 'next/server';

import { clearAuthCookies } from '../../../lib/auth/session';

export async function POST(request: Request) {
  const response = NextResponse.redirect(new URL('/sign-in', request.url));

  clearAuthCookies(response);

  return response;
}
