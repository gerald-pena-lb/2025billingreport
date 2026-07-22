import { NextRequest, NextResponse } from 'next/server';
import Anthropic from '@anthropic-ai/sdk';

export const runtime = 'nodejs';
export const maxDuration = 120;

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

const SYSTEM_PROMPT = `You are a receipt / statement analyzer. You will receive a receipt, invoice, or a financial statement (bank statement, credit-card statement, PayPal statement, Wise statement, etc.).

Your job: emit ONE JSON item per real line in the document. Do NOT drop rows silently — the user wants to see everything and decide themselves. Classify each line with a "kind" field so the user can filter or bulk-delete.

Emit an item for every transaction line. DO NOT emit items for opening/closing balances, running-balance rows, section headings, subtotals, or the "balance at end of period" summary — those are display artifacts, not transactions.

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

For a simple single-purchase receipt (one shop, one purchase), emit exactly one item of kind "payment". If the document is unreadable or contains no transaction lines, return { "items": [] }.`;

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
        const buf = Buffer.from(await file.arrayBuffer());
        const b64 = buf.toString('base64');
        const mediaType = (file.type || 'image/jpeg') as
          | 'image/jpeg'
          | 'image/png'
          | 'image/gif'
          | 'image/webp'
          | 'application/pdf';

        const isPdf = mediaType === 'application/pdf';

        const message = await client.messages.create({
          model: 'claude-sonnet-5',
          max_tokens: 8192,
          system: SYSTEM_PROMPT,
          messages: [
            {
              role: 'user',
              content: [
                {
                  type: isPdf ? 'document' : 'image',
                  source: {
                    type: 'base64',
                    media_type: mediaType,
                    data: b64,
                  },
                } as unknown as Anthropic.ImageBlockParam,
                {
                  type: 'text',
                  text: 'Extract every transaction line as JSON per the schema. Include incoming / conversions / cashback too, and classify each with "kind" — the user will filter and delete.',
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
        };
        const items = Array.isArray(parsed.items)
          ? parsed.items.map(normalizeItem).filter((i) => i.amount != null)
          : [];

        return { fileName: file.name, ok: true as const, items };
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
