# CI-dev Supabase secret recovery

This runbook restores the disposable Supabase credentials used by the
`lane-full-stack-runtime` GitHub Actions job. It is an operator procedure:
keep values in GitHub Actions secrets and never place a value, screenshot, or
connection string in this repository, a PR, an issue, a chat, or CI output.

## Scope and environment boundary

Use the **CI-dev** Supabase project for the four secrets consumed by pull
request runtime validation. Do not use the Production project for this job.

| GitHub Actions secret | Source in the CI-dev Supabase project |
| --- | --- |
| `SUPABASE_DB_URL` | Connect dialog → **Session pooler** connection string |
| `NEXT_PUBLIC_SUPABASE_URL` | Integrations → Data API → project URL |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | Settings → API Keys → Publishable and secret API keys → default Publishable key |
| `SUPABASE_SERVICE_ROLE_KEY` | Settings → API Keys → Publishable and secret API keys → default Secret key |

The repository keeps the two key secret names for backwards compatibility.
They may contain Supabase's current Publishable and Secret API-key values.
Older CI-dev projects that have not enabled the new key type may instead show
the legacy `anon` and `service_role` keys in the same API Keys area; use only
that project's matching values until a dedicated key-migration change is made.

`SUPABASE_DB_URL_PROD` is different: it remains a Production-only secret. The
`lane-migrate-prod` job uses it only for a `master` push or manual workflow
dispatch; PR runtime validation never receives it.

## Update procedure

1. Open the **CI-dev** project in the Supabase dashboard.
2. For `SUPABASE_DB_URL`, select **Connect** in the top bar, choose
   **Session pooler**, and copy its connection string. Replace
   `[YOUR-PASSWORD]` with the CI-dev database password. Percent-encode a
   reserved password character such as `&`, `#`, `?`, or a space. If the
   password is unavailable, reset it at **Database → Settings**; Supabase does
   not reveal the existing password.
3. For `NEXT_PUBLIC_SUPABASE_URL`, open **Integrations → Data API** and copy
   the project URL. It must be only the bare project origin, for example
   `https://<project-ref>.supabase.co` — **no trailing slash and no `/rest/v1`,
   `/auth/v1`, or other path**.
4. For the two API-key secrets, open **Settings → API Keys → Publishable and
   secret API keys**. Copy the default Publishable key and default Secret key
   into the corresponding secret names in the table above. If that tab offers
   **Create new API keys**, create the default pair before copying them.
5. In GitHub, open **moviecal → Settings → Secrets and variables → Actions →
   Repository secrets** and update those four secrets. Do not change
   `SUPABASE_DB_URL_PROD` as part of a CI-dev repair.
6. Re-run `lane-full-stack-runtime` (or push an intentionally empty commit to
   the PR branch). Confirm **Apply migrations** and the runtime lane both
   succeed.

## Troubleshooting

- A failure in **Apply migrations** points first to `SUPABASE_DB_URL`, the
  CI-dev database password, or the Session pooler connection string.
- If migrations pass but creating the disposable auth user fails with an
  invalid request path, re-check that `NEXT_PUBLIC_SUPABASE_URL` is the bare
  project origin, not a REST or Auth endpoint.
- Do not substitute Production credentials to make a PR lane pass. Escalate a
  CI-dev project outage or unavailable dashboard access to a human owner.

## Verification references

The authoritative secret consumers are
[`.github/workflows/supabase-verify.yml`](../../.github/workflows/supabase-verify.yml):
`lane-full-stack-runtime` consumes the four CI-dev secrets and
`lane-migrate-prod` consumes `SUPABASE_DB_URL_PROD` after merge. See
[the Supabase connection guide](https://supabase.com/docs/guides/database/connecting-to-postgres)
and [the API-key guide](https://supabase.com/docs/guides/getting-started/api-keys)
for current dashboard terminology.
