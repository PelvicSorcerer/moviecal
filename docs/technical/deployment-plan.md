# Deployment plan

Environments
- Development: local Next.js + Supabase project
- Production: Vercel (Hobby)

Environment variables (set in Vercel and locally during development)
- NEXT_PUBLIC_SUPABASE_URL
- NEXT_PUBLIC_SUPABASE_ANON_KEY (client-safe)
- SUPABASE_SERVICE_ROLE_KEY (server-only)
- TMDB_API_KEY
- CRON_SECRET (for protected refresh endpoint)

Steps
1. Create Supabase project and apply DB schema (tables and RLS policies).
2. Create a Vercel project linked to the GitHub repo.
3. Add required environment variables in Vercel.
4. Deploy the Next.js app; verify public pages work.
5. Configure Vercel Cron to call `/api/cron/refresh-releases` on a schedule.
6. Monitor logs and add alerts for errors or TMDb rate-limit issues.

Notes
- Keep credentials out of the repository. Document how to create and add them in a future ops doc.
