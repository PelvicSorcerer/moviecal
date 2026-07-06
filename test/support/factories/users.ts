import type { User } from '@supabase/supabase-js';

import { TEST_TIMESTAMPS, TEST_USER_IDS } from '../../../src/lib/test-data/catalog';

export function buildTestUser(
  overrides: Partial<User> & Pick<User, 'id'> = { id: TEST_USER_IDS.OWNER },
): User {
  return {
    app_metadata: {},
    aud: 'authenticated',
    created_at: TEST_TIMESTAMPS.USER_CREATED,
    email: `${overrides.id}@moviecal.test`,
    user_metadata: {},
    ...overrides,
  };
}

export const TEST_USERS = {
  owner: buildTestUser({ id: TEST_USER_IDS.OWNER, email: 'owner@moviecal.test' }),
  collaborator: buildTestUser({
    id: TEST_USER_IDS.COLLABORATOR,
    email: 'collaborator@moviecal.test',
  }),
  e2eOwner: buildTestUser({
    id: TEST_USER_IDS.E2E_OWNER,
    email: 'e2e@example.com',
    app_metadata: { provider: 'e2e' },
    user_metadata: { label: 'Playwright smoke user' },
  }),
  e2eCollaborator: buildTestUser({
    id: TEST_USER_IDS.E2E_COLLABORATOR,
    email: 'friend@example.com',
    app_metadata: { provider: 'e2e' },
    user_metadata: { label: 'Playwright collaborator user' },
  }),
} as const;
