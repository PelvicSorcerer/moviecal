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
- `watchlists` is the durable ownership boundary. Personal and shared watchlists use the same table so later shared-watchlist work can stay app-layer unless a schema gap is discovered.
- Every user can own exactly one `personal` watchlist. Shared watchlists use the same owner field, but they do not inherit any friend or contact model assumptions.
- `watchlist_memberships` is the authorization primitive for access. Accepted membership rows unlock read/write access through RLS; this is intentionally separate from any future social graph.
- `watchlist_invite_links` stores hashed invite tokens, not raw tokens. Invite links are bearer credentials and must not expose broader user or watchlist discovery.
- `watchlist_items.watchlist_id` is the real ownership link. `watchlist_items.user_id` remains as a temporary compatibility bridge for the current personal-watchlist app path and is null for shared rows.
- Existing personal watchlist rows migrate by creating one owned personal watchlist per current user row set, then backfilling `watchlist_items.watchlist_id` without changing saved movies.
- Store `release_date` on `movies` to make feed generation fast.
- Use an index on `movies.tmdb_id`, `watchlist_items.watchlist_id`, `watchlist_memberships.user_id`, and `watchlist_invite_links.watchlist_id` for efficient joins.
