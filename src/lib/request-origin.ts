export interface HeaderReader {
  get(name: string): string | null | undefined;
}

function readForwardedValue(value: string | null | undefined): string | null {
  if (!value) {
    return null;
  }

  const firstValue = value.split(',')[0]?.trim();

  return firstValue || null;
}

export function readRequestOrigin(headers: HeaderReader): string {
  const host =
    readForwardedValue(headers.get('x-forwarded-host')) ??
    readForwardedValue(headers.get('host'));

  if (!host) {
    throw new Error('Could not determine request host.');
  }

  const protocol =
    readForwardedValue(headers.get('x-forwarded-proto')) ?? 'http';

  if (protocol !== 'http' && protocol !== 'https') {
    throw new Error('Could not determine request protocol.');
  }

  return `${protocol}://${host}`;
}
