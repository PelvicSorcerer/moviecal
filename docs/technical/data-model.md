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

watchlist_items
- id UUID PRIMARY KEY DEFAULT gen_random_uuid()
- user_id UUID REFERENCES users(id)
- movie_id INTEGER REFERENCES movies(id)
- added_at TIMESTAMP WITH TIME ZONE DEFAULT now()
- UNIQUE(user_id, movie_id)

calendar_tokens
- id UUID PRIMARY KEY DEFAULT gen_random_uuid()
- user_id UUID REFERENCES users(id) UNIQUE
- token TEXT NOT NULL UNIQUE -- unguessable
- created_at TIMESTAMP WITH TIME ZONE DEFAULT now()

Notes
- Store release_date on movies table to make feed generation fast.
- Use RLS policies so users only see their watchlist rows.
- Token should be random and long enough (e.g., 32+ chars base62) and treated as secret.
- Use an index on movies.tmdb_id and watchlist_items.user_id for efficient queries.
