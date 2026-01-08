import { createClient as createSupabaseClient, SupabaseClient } from '@supabase/supabase-js';
import type { Database } from './types';

export interface SupabaseConfig {
  url: string;
  key: string;
  options?: {
    auth?: {
      persistSession?: boolean;
    };
  };
}

/**
 * Create a type-safe Supabase client
 */
export function createClient(config: SupabaseConfig): SupabaseClient<Database> {
  return createSupabaseClient<Database>(
    config.url,
    config.key,
    config.options
  );
}

/**
 * Create a Supabase client from environment variables
 */
export function createClientFromEnv(): SupabaseClient<Database> {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_ANON_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!url || !key) {
    throw new Error('Missing SUPABASE_URL or SUPABASE_*_KEY environment variable');
  }

  return createClient({ url, key });
}
