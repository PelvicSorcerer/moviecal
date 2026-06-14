export function formatReleaseDate(releaseDate: string | null): string {
  if (!releaseDate) {
    return 'Release date TBD';
  }

  const parsedDate = new Date(`${releaseDate}T00:00:00Z`);

  if (Number.isNaN(parsedDate.getTime())) {
    return 'Release date TBD';
  }

  return new Intl.DateTimeFormat('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    timeZone: 'UTC',
  }).format(parsedDate);
}
