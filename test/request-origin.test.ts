import { describe, expect, it } from 'vitest';

import { readRequestOrigin } from '../src/lib/request-origin';

describe('request origin helper', () => {
  it('prefers forwarded host and protocol when present', () => {
    const origin = readRequestOrigin({
      get(name: string) {
        if (name === 'x-forwarded-host') {
          return 'moviecal.example.com';
        }

        if (name === 'x-forwarded-proto') {
          return 'https';
        }

        return null;
      },
    });

    expect(origin).toBe('https://moviecal.example.com');
  });

  it('falls back to the host header with http when needed', () => {
    const origin = readRequestOrigin({
      get(name: string) {
        if (name === 'host') {
          return 'localhost:3000';
        }

        return null;
      },
    });

    expect(origin).toBe('http://localhost:3000');
  });

  it('rejects missing hosts', () => {
    expect(() =>
      readRequestOrigin({
        get() {
          return null;
        },
      }),
    ).toThrowError(/request host/);
  });
});
