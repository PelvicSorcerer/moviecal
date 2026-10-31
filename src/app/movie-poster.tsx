interface MoviePosterProps {
  posterPath: string | null;
  title: string;
}

export function getMoviePosterUrl(posterPath: string | null): string | null {
  return posterPath ? `https://image.tmdb.org/t/p/w154${posterPath}` : null;
}

export function MoviePoster({ posterPath, title }: MoviePosterProps) {
  const source = getMoviePosterUrl(posterPath);
  const className = 'h-24 w-16 shrink-0 rounded-lg bg-slate-200 object-cover';

  return source ? (
    <img
      src={source}
      alt={title}
      width={64}
      height={96}
      loading="lazy"
      className={className}
    />
  ) : (
    <div
      role="img"
      aria-label={`No poster available for ${title}`}
      className={`${className} flex items-center justify-center p-2 text-center text-xs text-slate-500`}
    >
      No poster
    </div>
  );
}
