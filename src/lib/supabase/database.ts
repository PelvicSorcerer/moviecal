export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[];

export interface Database {
  public: {
    Tables: {
      calendar_tokens: {
        Row: {
          created_at: string;
          id: string;
          token: string;
          user_id: string;
        };
        Insert: {
          created_at?: string;
          id?: string;
          token: string;
          user_id: string;
        };
        Update: {
          created_at?: string;
          id?: string;
          token?: string;
          user_id?: string;
        };
        Relationships: [];
      };
      movies: {
        Row: {
          id: number;
          raw_json: Json;
          release_date: string | null;
          title: string;
          tmdb_id: number;
          updated_at: string;
        };
        Insert: {
          id?: number;
          raw_json?: Json;
          release_date?: string | null;
          title: string;
          tmdb_id: number;
          updated_at?: string;
        };
        Update: {
          id?: number;
          raw_json?: Json;
          release_date?: string | null;
          title?: string;
          tmdb_id?: number;
          updated_at?: string;
        };
        Relationships: [];
      };
      watchlist_invite_links: {
        Row: {
          created_at: string;
          created_by_user_id: string;
          expires_at: string | null;
          id: string;
          revoked_at: string | null;
          token_hash: string;
          watchlist_id: string;
        };
        Insert: {
          created_at?: string;
          created_by_user_id: string;
          expires_at?: string | null;
          id?: string;
          revoked_at?: string | null;
          token_hash: string;
          watchlist_id: string;
        };
        Update: {
          created_at?: string;
          created_by_user_id?: string;
          expires_at?: string | null;
          id?: string;
          revoked_at?: string | null;
          token_hash?: string;
          watchlist_id?: string;
        };
        Relationships: [];
      };
      watchlist_items: {
        Row: {
          added_at: string;
          id: string;
          movie_id: number;
          user_id: string | null;
          watchlist_id: string;
        };
        Insert: {
          added_at?: string;
          id?: string;
          movie_id: number;
          user_id?: string | null;
          watchlist_id?: string | null;
        };
        Update: {
          added_at?: string;
          id?: string;
          movie_id?: number;
          user_id?: string | null;
          watchlist_id?: string | null;
        };
        Relationships: [
          {
            foreignKeyName: 'watchlist_items_movie_id_fkey';
            columns: ['movie_id'];
            isOneToOne: false;
            referencedRelation: 'movies';
            referencedColumns: ['id'];
          },
          {
            foreignKeyName: 'watchlist_items_watchlist_id_fkey';
            columns: ['watchlist_id'];
            isOneToOne: false;
            referencedRelation: 'watchlists';
            referencedColumns: ['id'];
          },
        ];
      };
      watchlist_memberships: {
        Row: {
          accepted_at: string | null;
          created_at: string;
          id: string;
          invited_by_user_id: string | null;
          role: string;
          user_id: string;
          watchlist_id: string;
        };
        Insert: {
          accepted_at?: string | null;
          created_at?: string;
          id?: string;
          invited_by_user_id?: string | null;
          role: string;
          user_id: string;
          watchlist_id: string;
        };
        Update: {
          accepted_at?: string | null;
          created_at?: string;
          id?: string;
          invited_by_user_id?: string | null;
          role?: string;
          user_id?: string;
          watchlist_id?: string;
        };
        Relationships: [];
      };
      watchlists: {
        Row: {
          created_at: string;
          id: string;
          kind: string;
          name: string;
          owner_user_id: string;
          updated_at: string;
        };
        Insert: {
          created_at?: string;
          id?: string;
          kind: string;
          name: string;
          owner_user_id: string;
          updated_at?: string;
        };
        Update: {
          created_at?: string;
          id?: string;
          kind?: string;
          name?: string;
          owner_user_id?: string;
          updated_at?: string;
        };
        Relationships: [];
      };
    };
    Views: Record<string, never>;
    Functions: {
      can_edit_watchlist: {
        Args: {
          target_watchlist_id: string;
          target_user_id: string;
        };
        Returns: boolean;
      };
      ensure_personal_watchlist_for_user: {
        Args: {
          target_user_id: string;
        };
        Returns: string;
      };
      is_active_watchlist_member: {
        Args: {
          target_watchlist_id: string;
          target_user_id: string;
        };
        Returns: boolean;
      };
      is_watchlist_owner: {
        Args: {
          target_watchlist_id: string;
          target_user_id: string;
        };
        Returns: boolean;
      };
    };
    Enums: Record<string, never>;
    CompositeTypes: Record<string, never>;
  };
}
