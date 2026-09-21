const CANONICAL_DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;

export function formatReleaseDate(releaseDate: string | null): string {
  if (!releaseDate) {
    return 'Release date TBD';
  }

  const match = CANONICAL_DATE_PATTERN.exec(releaseDate);

  if (!match) {
    return 'Release date TBD';
  }

  const [, yearText, monthText, dayText] = match;
  const year = Number(yearText);
  const month = Number(monthText);
  const day = Number(dayText);

  const parsedDate = new Date(Date.UTC(year, month - 1, day));

  const isCalendarMatch =
    parsedDate.getUTCFullYear() === year &&
    parsedDate.getUTCMonth() === month - 1 &&
    parsedDate.getUTCDate() === day;

  if (!isCalendarMatch) {
    return 'Release date TBD';
  }

  return new Intl.DateTimeFormat('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    timeZone: 'UTC',
  }).format(parsedDate);
}
