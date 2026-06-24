import { describe, expect, it } from 'vitest';

import vercelConfig from '../vercel.json';

describe('vercel cron configuration', () => {
  it('targets the release refresh route on a daily UTC schedule', () => {
    expect(vercelConfig).toEqual({
      $schema: 'https://openapi.vercel.sh/vercel.json',
      crons: [
        {
          path: '/api/cron/refresh-releases',
          schedule: '0 5 * * *',
        },
      ],
    });
  });
});
