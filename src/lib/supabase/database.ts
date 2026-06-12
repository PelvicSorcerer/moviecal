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
      watchlist_items: {
        Row: {
          added_at: string;
          id: string;
          movie_id: number;
          user_id: string;
        };
        Insert: {
          added_at?: string;
          id?: string;
          movie_id: number;
          user_id: string;
        };
        Update: {
          added_at?: string;
          id?: string;
          movie_id?: number;
          user_id?: string;
        };
        Relationships: [
          {
            foreignKeyName: 'watchlist_items_movie_id_fkey';
            columns: ['movie_id'];
            isOneToOne: false;
            referencedRelation: 'movies';
            referencedColumns: ['id'];
          },
        ];
      };
    };
    Views: Record<string, never>;
    Functions: Record<string, never>;
    Enums: Record<string, never>;
    CompositeTypes: Record<string, never>;
  };
}
