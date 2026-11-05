import { createClient, SupabaseClient } from '@supabase/supabase-js';

const SUPABASE_URL: string = import.meta.env.VITE_SUPABASE_URL || '';
const SUPABASE_KEY: string =
  import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY ||
  import.meta.env.VITE_SUPABASE_ANON_KEY ||
  '';

export const isSupabaseConfigured = Boolean(
  SUPABASE_URL &&
  SUPABASE_KEY &&
  !SUPABASE_URL.includes('placeholder') &&
  !SUPABASE_URL.includes('example.supabase.co')
);

// Safe Supabase client initialized with production or local configuration
export const supabase: SupabaseClient = createClient(
  isSupabaseConfigured ? SUPABASE_URL : (SUPABASE_URL || 'https://placeholder.supabase.co'),
  isSupabaseConfigured ? SUPABASE_KEY : (SUPABASE_KEY || 'placeholder-anon-key'),
  {
    auth: {
      persistSession: true,
      autoRefreshToken: true,
      storage: localStorage,
    },
  }
);

export function getSupabaseEdgeFunctionUrl(functionName: string): string {
  if (isSupabaseConfigured && SUPABASE_URL) {
    const base = SUPABASE_URL.replace(/\/+$/, '');
    return `${base}/functions/v1/${functionName}`;
  }
  // Local server fallback hosting the same edge function contract
  return `/functions/v1/${functionName}`;
}
