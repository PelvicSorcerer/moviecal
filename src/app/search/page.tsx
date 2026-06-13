import type { Metadata } from 'next';

import { getOptionalUser } from '../../lib/auth/session';
import { SearchPageClient } from './search-page-client';

export const metadata: Metadata = {
  title: 'Search | moviecal',
  description: 'Search TMDb-backed movie results through the server-side moviecal API.',
};

function readQueryParam(
  value: string | string[] | undefined,
): string {
  if (Array.isArray(value)) {
    return value[0]?.trim() ?? '';
  }

  return value?.trim() ?? '';
}

export default async function SearchPage({
  searchParams,
}: {
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = (await searchParams) ?? {};
  const initialQuery = readQueryParam(params.q);
  const user = await getOptionalUser();

  return (
    <SearchPageClient
      initialQuery={initialQuery}
      isAuthenticated={Boolean(user)}
    />
  );
}
