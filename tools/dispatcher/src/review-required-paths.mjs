// Changes to these paths may be published as draft PRs, but require human
// sign-off before merge and are never eligible for PR autonomy.
export const REVIEW_REQUIRED_PATH_PATTERNS = [
  /^supabase\/migrations\//,
  /^src\/app\/auth\//,
  /^src\/lib\/auth\//,
  /^src\/app\/settings\/calendar\//,
  /^src\/app\/api\/calendar\//,
  /^src\/app\/api\/v1\/calendar-token\//,
  /^src\/lib\/(?:supabase\/)?calendar-tokens\./,
];

export function reviewRequiredPaths(paths) {
  return [...new Set(paths)].filter((file) =>
    REVIEW_REQUIRED_PATH_PATTERNS.some((pattern) => pattern.test(file)));
}
