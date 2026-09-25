# Data model

Suggested tables (Postgres / Supabase)

users
- id UUID PRIMARY KEY (from Supabase auth)
- email (managed by Supabase)

movies (cached TMDb metadata)
- id SERIAL PRIMARY KEY
- tmdb_id INTEGER UNIQUE NOT NULL
- title TEXT NOT NULL
- release_date DATE NULL
- raw_json JSONB (full TMDb payload)
- updated_at TIMESTAMP WITH TIME ZONE DEFAULT now()

watchlists
- id UUID PRIMARY KEY DEFAULT gen_random_uuid()
- owner_user_id UUID NOT NULL REFERENCES users(id)
- kind TEXT NOT NULL CHECK kind IN ('personal', 'shared')
- name TEXT NOT NULL
- created_at TIMESTAMP WITH TIME ZONE DEFAULT now()
- updated_at TIMESTAMP WITH TIME ZONE DEFAULT now()
- UNIQUE(owner_user_id) WHERE kind = 'personal'

watchlist_memberships
- id UUID PRIMARY KEY DEFAULT gen_random_uuid()
- watchlist_id UUID NOT NULL REFERENCES watchlists(id)
- user_id UUID NOT NULL REFERENCES users(id)
- role TEXT NOT NULL CHECK role IN ('owner', 'editor')
- invited_by_user_id UUID NULL REFERENCES users(id)
- created_at TIMESTAMP WITH TIME ZONE DEFAULT now()
- accepted_at TIMESTAMP WITH TIME ZONE NULL
- UNIQUE(watchlist_id, user_id)

watchlist_invite_links
- id UUID PRIMARY KEY DEFAULT gen_random_uuid()
- watchlist_id UUID NOT NULL REFERENCES watchlists(id)
- created_by_user_id UUID NOT NULL REFERENCES users(id)
- token_hash TEXT NOT NULL UNIQUE
- created_at TIMESTAMP WITH TIME ZONE DEFAULT now()
- expires_at TIMESTAMP WITH TIME ZONE NULL
- revoked_at TIMESTAMP WITH TIME ZONE NULL

watchlist_items
- id UUID PRIMARY KEY DEFAULT gen_random_uuid()
- watchlist_id UUID NOT NULL REFERENCES watchlists(id)
- user_id UUID NULL REFERENCES users(id)
- movie_id INTEGER REFERENCES movies(id)
- added_at TIMESTAMP WITH TIME ZONE DEFAULT now()
- UNIQUE(watchlist_id, movie_id)

calendar_tokens
- id UUID PRIMARY KEY DEFAULT gen_random_uuid()
- user_id UUID REFERENCES users(id) UNIQUE
- token TEXT NOT NULL UNIQUE
- created_at TIMESTAMP WITH TIME ZONE DEFAULT now()

Notes
- `watchlists` is the durable ownership boundary. Personal and shared watchlists use the same table; current sharing uses memberships and hashed invite links, while further collaboration work may add schema constraints where needed.
- Every user can own exactly one `personal` watchlist. Shared watchlists use the same owner field, but they do not inherit any friend or contact model assumptions.
- `watchlist_memberships` is the authorization primitive for access. Accepted membership rows unlock read/write access through RLS; this is intentionally separate from any future social graph.

Ownership invariants (enforced in the database by `20260924000000_mov_330_watchlist_ownership_invariants.sql`, not only in application code):

- `watchlists.owner_user_id` and `watchlists.kind` are immutable after creation, for every role including `service_role`. Transferring a watchlist means creating a new one, not rewriting the ownership anchor.
- A personal watchlist cannot be deleted. It disappears only with its owner's account, which the delete trigger recognises because the `auth.users` row is already gone from the transaction's snapshot by the time the cascade fires. The `authenticated` DELETE policy is also narrowed to `kind = 'shared'`, so an interactive attempt is filtered rather than raised.
- The owner's own `watchlist_memberships` row is permanent, always `accepted`, always `role = 'owner'`, and cannot be moved to another user or another watchlist. It is also the only row for that watchlist permitted to hold `role = 'owner'`. This matters because `can_edit_watchlist()` reads memberships: deleting or demoting that row used to silently revoke the owner's own edit access.
- `authenticated` holds `UPDATE (name)` on `watchlists` and nothing more, so the only column any interactive caller can name in an update is `name`. `updated_at` is stamped by the update trigger, which is unaffected by column privileges. An accepted editor reaches that column through a rename-only RLS policy on shared watchlists; the trigger additionally compares whole rows, so a column added later stays closed until it is deliberately opened.
- `ensure_personal_watchlist_for_user()` refuses an authenticated caller that passes anyone else's id. A null `auth.uid()` — service role, cron, migrations, psql — remains the trusted server-only path.
- The authenticated RPC helpers `is_watchlist_owner()`, `is_active_watchlist_member()`, and `can_edit_watchlist()` bind their user argument to `auth.uid()`, so callers cannot probe another user's ownership or membership.
- `watchlist_invite_links` stores hashed invite tokens, not raw tokens. Invite links are bearer credentials and must not expose broader user or watchlist discovery.
- `watchlist_items.watchlist_id` is the real ownership link. `watchlist_items.user_id` remains as a temporary compatibility bridge for the current personal-watchlist app path and is null for shared rows.
- Existing personal watchlist rows migrate by creating one owned personal watchlist per current user row set, then backfilling `watchlist_items.watchlist_id` without changing saved movies.
- Store `release_date` on `movies` to make feed generation fast.
- Use an index on `movies.tmdb_id`, `watchlist_items.watchlist_id`, `watchlist_memberships.user_id`, and `watchlist_invite_links.watchlist_id` for efficient joins.
