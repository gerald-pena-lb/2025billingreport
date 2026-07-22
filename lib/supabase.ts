'use client';

import { createClient, SupabaseClient } from '@supabase/supabase-js';

let cached: SupabaseClient | null = null;

function sanitizeUrl(raw: string): string {
  // Strip whitespace, trailing slashes, and any accidental /rest/v1 suffix
  // pasted from the docs — createClient adds that itself.
  return raw
    .trim()
    .replace(/\/+$/, '')
    .replace(/\/rest\/v1$/i, '');
}

export function getSupabase(): SupabaseClient | null {
  if (cached) return cached;
  const rawUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY?.trim();
  if (!rawUrl || !key) return null;
  cached = createClient(sanitizeUrl(rawUrl), key, {
    auth: { persistSession: false },
  });
  return cached;
}

export function isSupabaseConfigured(): boolean {
  return Boolean(
    process.env.NEXT_PUBLIC_SUPABASE_URL &&
      process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY,
  );
}

export type ReceiptDb = {
  id: string;
  date: string | null;
  amount: number | null;
  currency: string | null;
  item: string;
  description: string;
  url: string;
  file_name: string | null;
  kind: string;
  value: number | null;
  created_at: string;
};
