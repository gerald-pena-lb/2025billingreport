# Receipt Analyzer Dashboard

Upload receipt images or PDFs — Claude extracts amount, item, description, and
date and adds them as rows to a spreadsheet-style dashboard. Rows are
auto-sorted by date. A blank, fillable **URL / location** column lets you
record where the original receipt lives.

## Run locally

```bash
npm install
npm run dev
# open http://localhost:3000
```

## API key

The `/api/analyze` route calls the Anthropic Claude API. Provide a key one of
two ways:

1. **Server-side** — copy `.env.example` to `.env.local` and set
   `ANTHROPIC_API_KEY`. Restart `npm run dev`.
2. **In the UI** — click **Settings**, paste your key. It's saved to your
   browser's localStorage and sent as a header to `/api/analyze`.

## Features

- Multi-file upload (images and PDFs)
- Structured extraction with `claude-sonnet-5` vision
- Editable cells — everything the model produced can be corrected
- Auto-sort by **Date of payment** on every change
- Editable **URL / location** column (never touched by the model)
- Per-currency totals in the footer
- CSV export
- LocalStorage persistence — no database required

## Build

```bash
npm run build
npm start
```
