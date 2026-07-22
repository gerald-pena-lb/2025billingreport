# Receipt Analyzer Dashboard

Upload receipt images or PDFs — Claude extracts amount, item, description, and
date and adds them as rows to a spreadsheet-style dashboard. Rows auto-sort by
date. A blank, fillable **URL / location** column lets you record where the
original receipt lives. Everything persists to Supabase.

**Stack:** Next.js on Vercel · Supabase (Postgres) · Claude vision.

---

## Setup — all done in the browser, no CLI

### 1. Create the Supabase project

1. Go to <https://supabase.com/dashboard> and click **New project**.
2. Give it a name and password, pick a region, wait for it to provision.
3. Left sidebar → **SQL Editor** → **New query**.
4. Open [`supabase/schema.sql`](./supabase/schema.sql) in this repo, copy
   its contents, paste into the SQL editor, click **Run**.
5. Left sidebar → **Project Settings** → **API**. Copy these two values —
   you'll paste them into Vercel in a minute:
   - **Project URL** (`https://xxxx.supabase.co`)
   - **anon public** key (the long `eyJ…` one)

### 2. Get an Anthropic API key

1. Go to <https://console.anthropic.com/> → **API Keys** → **Create Key**.
2. Copy the key (starts with `sk-ant-…`).

### 3. Deploy to Vercel

1. Push this repo to GitHub if it isn't already.
2. Go to <https://vercel.com/new>, import the repo.
3. Framework preset auto-detects as **Next.js**. Leave defaults.
4. Expand **Environment Variables** and add three:
   | Name | Value |
   | --- | --- |
   | `NEXT_PUBLIC_SUPABASE_URL` | Supabase Project URL from step 1 |
   | `NEXT_PUBLIC_SUPABASE_ANON_KEY` | Supabase anon key from step 1 |
   | `ANTHROPIC_API_KEY` | Anthropic key from step 2 |
5. Click **Deploy**. When it finishes, open the URL Vercel gives you.

That's it. Upload receipts and they'll appear in the spreadsheet.

---

## How it works

- **Upload** — Multi-file picker sends images / PDFs to `/api/analyze`.
- **Extract** — The route calls Claude (`claude-sonnet-5`) with each file and
  a schema-constrained prompt, returning `{date, amount, currency, item,
  description}` as JSON.
- **Store** — The client inserts a row per receipt into the `receipts` table
  via the Supabase JS client (anon key).
- **Sort** — Rows are always displayed sorted by `date` ascending (nulls
  last, then insertion order).
- **Edit** — Every cell is editable. Changes save back to Supabase on blur /
  change. The **URL / location** column is always blank on insert and only
  ever set by you.

## Security note

The included SQL uses permissive RLS policies (anyone with the anon key can
read/write `receipts`). That's fine for a personal tool but not for
anything shared. To lock it down, add Supabase Auth (email / magic link),
add a `user_id uuid references auth.users` column, and change each policy
to `using (auth.uid() = user_id)`.

## Local dev (optional)

You don't need this if you're deploying via Vercel, but if you want to run
locally: create `.env.local` from `.env.example`, fill in the same three
env vars, then `npm install && npm run dev`.
