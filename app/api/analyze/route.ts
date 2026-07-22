import { NextRequest, NextResponse } from 'next/server';
import Anthropic from '@anthropic-ai/sdk';
import { PDFDocument } from 'pdf-lib';

export const runtime = 'nodejs';
export const maxDuration = 300;

export type ItemKind =
  | 'payment'
  | 'incoming'
  | 'conversion'
  | 'withdrawal'
  | 'cashback'
  | 'refund'
  | 'balance'
  | 'other';

type ExtractedItem = {
  date: string | null;
  amount: number | null;
  currency: string | null;
  item: string | null;
  description: string | null;
  kind: ItemKind;
};

const VALID_KINDS: ReadonlySet<ItemKind> = new Set([
  'payment',
  'incoming',
  'conversion',
  'withdrawal',
  'cashback',
  'refund',
  'balance',
  'other',
]);

const SYSTEM_PROMPT = `You are a receipt / statement analyzer. You will receive a receipt, invoice, or a financial statement (bank statement, credit-card statement, PayPal statement, Wise statement, etc.). It may be one page of a longer statement.

Your job: emit ONE JSON item per real transaction line visible in the document. Do NOT drop rows silently — the user wants to see everything and decide themselves. Classify each line with a "kind" field so the user can filter or bulk-delete.

BE EXHAUSTIVE. Scan the entire page top-to-bottom. Statements can have many similar rows (e.g. many "Received money from AMAZON …" lines with slightly different amounts and reference IDs) — emit an item for EACH one, not just the first few or a summarized set. If you see 20 Amazon incoming transfers, emit 20 items. Never merge, collapse, or "..." rows.

Do NOT emit items for: opening/closing balances, running-balance rows, section headings, subtotals, or the "balance at end of period" summary — those are display artifacts, not transactions.

"kind" must be exactly one of:
- "payment"    — an actual expense / charge / purchase from a third party (e.g. GoDaddy, Uber, Amazon). This is what the user actually cares about.
- "incoming"   — money received: salary, client payment, transfer in, deposit
- "refund"     — money back from a previous purchase
- "conversion" — currency conversion between the user's own balances (e.g. "Converted 100 USD to 92 EUR")
- "withdrawal" — ATM withdrawal or cash-out
- "cashback"   — cashback / rewards credit
- "balance"    — a balance / total / subtotal row that slipped through (rare — prefer to omit these)
- "other"      — anything you cannot confidently classify

Return ONLY a JSON object of this shape — no prose, no markdown fences:

{
  "expected_count": number,   // how many transaction rows you saw on this page (before emitting)
  "items": [
    {
      "date": "YYYY-MM-DD" | null,
      "amount": number | null,          // positive number, no currency symbol, no thousands separator
      "currency": "AED" | "USD" | "EUR" | ... | null,
      "item": string,                   // short label — merchant or counterparty, max 40 chars
      "description": string,            // one-line human summary, max 120 chars
      "kind": "payment" | "incoming" | "refund" | "conversion" | "withdrawal" | "cashback" | "balance" | "other"
    }
  ]
}

items.length MUST equal expected_count. If the document is unreadable or contains no transaction lines, return { "expected_count": 0, "items": [] }.`;

function parseJsonLoose(text: string): unknown {
  const trimmed = text.trim();
  try {
    return JSON.parse(trimmed);
  } catch {
    const match = trimmed.match(/\{[\s\S]*\}/);
    if (match) return JSON.parse(match[0]);
    throw new Error('Model did not return JSON');
  }
}

function normalizeItem(raw: Partial<ExtractedItem>): ExtractedItem {
  const amt =
    typeof raw.amount === 'number' && Number.isFinite(raw.amount)
      ? Math.abs(raw.amount)
      : null;
  const kind =
    raw.kind && VALID_KINDS.has(raw.kind as ItemKind)
      ? (raw.kind as ItemKind)
      : 'other';
  return {
    date: raw.date ?? null,
    amount: amt,
    currency: raw.currency ?? null,
    item: raw.item ?? null,
    description: raw.description ?? null,
    kind,
  };
}

type Chunk = {
  bytes: Uint8Array;
  mediaType:
    | 'image/jpeg'
    | 'image/png'
    | 'image/gif'
    | 'image/webp'
    | 'application/pdf';
  label: string; // e.g. "page 1/3" or "image"
};

async function splitPdfIntoPages(buf: Buffer): Promise<Buffer[]> {
  const src = await PDFDocument.load(buf, { ignoreEncryption: true });
  const total = src.getPageCount();
  const out: Buffer[] = [];
  for (let i = 0; i < total; i++) {
    const doc = await PDFDocument.create();
    const [copied] = await doc.copyPages(src, [i]);
    doc.addPage(copied);
    const bytes = await doc.save();
    out.push(Buffer.from(bytes));
  }
  return out;
}

async function fileToChunks(file: File): Promise<Chunk[]> {
  const buf = Buffer.from(await file.arrayBuffer());
  const mediaType = (file.type || 'image/jpeg') as Chunk['mediaType'];
  if (mediaType !== 'application/pdf') {
    return [{ bytes: buf, mediaType, label: 'image' }];
  }
  try {
    const pages = await splitPdfIntoPages(buf);
    if (pages.length <= 1) {
      return [{ bytes: buf, mediaType, label: 'page 1/1' }];
    }
    return pages.map((b, i) => ({
      bytes: b,
      mediaType: 'application/pdf' as const,
      label: `page ${i + 1}/${pages.length}`,
    }));
  } catch {
    return [{ bytes: buf, mediaType, label: 'pdf' }];
  }
}

async function extractFromChunk(
  client: Anthropic,
  chunk: Chunk,
): Promise<{ items: ExtractedItem[]; expected: number | null; raw: string }> {
  const isPdf = chunk.mediaType === 'application/pdf';
  const message = await client.messages.create({
    model: 'claude-sonnet-5',
    max_tokens: 16000,
    system: SYSTEM_PROMPT,
    messages: [
      {
        role: 'user',
        content: [
          {
            type: isPdf ? 'document' : 'image',
            source: {
              type: 'base64',
              media_type: chunk.mediaType,
              data: Buffer.from(chunk.bytes).toString('base64'),
            },
          } as unknown as Anthropic.ImageBlockParam,
          {
            type: 'text',
            text: `This is ${chunk.label}. Extract EVERY transaction row visible. Do not skip, merge, or summarize similar-looking rows — emit one item per row.`,
          },
        ],
      },
    ],
  });

  const textBlock = message.content.find(
    (b): b is Anthropic.TextBlock => b.type === 'text',
  );
  if (!textBlock) throw new Error('No text in model response');

  const parsed = parseJsonLoose(textBlock.text) as {
    items?: Partial<ExtractedItem>[];
    expected_count?: number;
  };
  const items = Array.isArray(parsed.items)
    ? parsed.items.map(normalizeItem).filter((i) => i.amount != null)
    : [];
  const expected =
    typeof parsed.expected_count === 'number' ? parsed.expected_count : null;
  return { items, expected, raw: textBlock.text };
}

export async function POST(req: NextRequest) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return NextResponse.json(
      {
        error:
          'ANTHROPIC_API_KEY is not set. Add it in Vercel → Settings → Environment Variables and redeploy.',
      },
      { status: 500 },
    );
  }

  const form = await req.formData();
  const files = form.getAll('files').filter((f): f is File => f instanceof File);
  if (files.length === 0) {
    return NextResponse.json({ error: 'No files uploaded' }, { status: 400 });
  }

  const client = new Anthropic({ apiKey });

  const results = await Promise.all(
    files.map(async (file) => {
      try {
        const chunks = await fileToChunks(file);
        const pageResults = await Promise.all(
          chunks.map(async (c) => {
            const r = await extractFromChunk(client, c);
            return { ...r, label: c.label };
          }),
        );
        const items = pageResults.flatMap((p) => p.items);
        const pageNotes = pageResults.map((p) => {
          const got = p.items.length;
          const exp = p.expected;
          const mismatch =
            typeof exp === 'number' && exp !== got ? ` ⚠ expected ${exp}` : '';
          return `${p.label}: ${got}${mismatch}`;
        });
        return {
          fileName: file.name,
          ok: true as const,
          items,
          pages: chunks.length,
          pageNotes,
        };
      } catch (err) {
        return {
          fileName: file.name,
          ok: false as const,
          error: err instanceof Error ? err.message : 'Unknown error',
        };
      }
    }),
  );

  return NextResponse.json({ results });
}
