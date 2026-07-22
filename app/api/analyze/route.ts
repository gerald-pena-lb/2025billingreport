import { NextRequest, NextResponse } from 'next/server';
import Anthropic from '@anthropic-ai/sdk';

export const runtime = 'nodejs';
export const maxDuration = 120;

type ExtractedItem = {
  date: string | null;
  amount: number | null;
  currency: string | null;
  item: string | null;
  description: string | null;
};

const SYSTEM_PROMPT = `You are a receipt / statement analyzer. You will receive a receipt, invoice, or a financial statement (bank statement, credit-card statement, PayPal statement, etc.).

Your job:
1. Identify every actual PAYMENT / EXPENSE / OUTGOING CHARGE in the document. Each becomes one line item.
2. EXCLUDE the following — never emit rows for these:
   - Incoming money: deposits, transfers in, refunds received, salary, interest received, cashback, credits
   - Cashflow-only movements: ATM withdrawals, cash withdrawals, transfers between the user's own accounts, currency conversions, "money in" / "money out" of a PayPal balance that is just moving funds around
   - Opening / closing / running balances
   - Section headings and subtotals
3. For a simple single-purchase receipt (one shop, one purchase), emit exactly one item.
4. For a statement with many charges, emit one item per charge.

Return ONLY a JSON object of this shape — no prose, no markdown fences:

{
  "items": [
    {
      "date": "YYYY-MM-DD" | null,          // date the payment was made
      "amount": number | null,               // positive number, no currency symbol, no thousands separator
      "currency": "AED" | "USD" | "EUR" | ... | null,  // ISO 4217, if determinable
      "item": string,                        // short label — merchant or main purchase, max 40 chars
      "description": string                  // one-line human summary, max 120 chars
    }
  ]
}

If the document is unreadable or contains no actual payments, return { "items": [] }.`;

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
  return {
    date: raw.date ?? null,
    amount: amt,
    currency: raw.currency ?? null,
    item: raw.item ?? null,
    description: raw.description ?? null,
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
                  text: 'Extract every actual payment/expense line item as JSON per the schema. Exclude withdrawals and incoming money.',
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
