import { NextResponse } from 'next/server';

import { clearAuthCookies } from '../../../lib/auth/session';
import { clearE2ECalendarToken } from '../../../lib/e2e/calendar-token-state';

function readRequestCookies(request: Request) {
  const cookieHeader = request.headers.get('cookie') ?? '';
  const entries = cookieHeader
    .split(';')
    .map((value) => value.trim())
    .filter(Boolean)
    .map((value) => {
      const separatorIndex = value.indexOf('=');

      if (separatorIndex < 0) {
        return [value, ''] as const;
      }

      return [
        value.slice(0, separatorIndex),
        decodeURIComponent(value.slice(separatorIndex + 1)),
      ] as const;
    });
  const cookieMap = new Map(entries);

  return {
    get(name: string) {
      const value = cookieMap.get(name);

      return value === undefined ? undefined : { value };
    },
  };
}

export async function POST(request: Request) {
  const response = NextResponse.redirect(new URL('/sign-in', request.url));

  clearE2ECalendarToken(readRequestCookies(request));
  clearAuthCookies(response);

  return response;
}
