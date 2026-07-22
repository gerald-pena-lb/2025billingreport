import { NextRequest, NextResponse } from 'next/server';
import Anthropic from '@anthropic-ai/sdk';

export const runtime = 'nodejs';
export const maxDuration = 60;

type ExtractedReceipt = {
  date: string | null;
  amount: number | null;
  currency: string | null;
  item: string | null;
  description: string | null;
};

const SYSTEM_PROMPT = `You are a receipt-data extractor. You will receive an image of a receipt, invoice, or bill. Extract the following fields and respond with ONLY a single JSON object — no prose, no markdown fences.

Fields:
- "date": the date the payment was made / receipt was issued, in ISO format "YYYY-MM-DD". If only a month/year is visible, use the 1st of the month. If missing, null.
- "amount": the total amount paid, as a number (no currency symbol, no thousands separator). Use the grand total including tax, not a subtotal.
- "currency": the ISO 4217 currency code if determinable (e.g. "AED", "USD", "EUR"), else null.
- "item": a short label naming the merchant or main purchase (e.g. "Carrefour", "Uber ride", "Etisalat bill"). Max 40 chars.
- "description": a one-line human-readable summary of what was bought (e.g. "Groceries — 12 items", "Monthly mobile plan"). Max 120 chars.

Respond ONLY with the JSON object.`;

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

export async function POST(req: NextRequest) {
  const apiKey =
    req.headers.get('x-anthropic-api-key') || process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return NextResponse.json(
      { error: 'No Anthropic API key configured. Add one in Settings.' },
      { status: 400 },
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
          max_tokens: 512,
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
                  text: 'Extract the receipt fields as JSON per the schema.',
                },
              ],
            },
          ],
        });

        const textBlock = message.content.find(
          (b): b is Anthropic.TextBlock => b.type === 'text',
        );
        if (!textBlock) throw new Error('No text in model response');

        const parsed = parseJsonLoose(textBlock.text) as ExtractedReceipt;
        return {
          fileName: file.name,
          ok: true,
          data: {
            date: parsed.date ?? null,
            amount:
              typeof parsed.amount === 'number' && Number.isFinite(parsed.amount)
                ? parsed.amount
                : null,
            currency: parsed.currency ?? null,
            item: parsed.item ?? null,
            description: parsed.description ?? null,
          },
        };
      } catch (err) {
        return {
          fileName: file.name,
          ok: false,
          error: err instanceof Error ? err.message : 'Unknown error',
        };
      }
    }),
  );

  return NextResponse.json({ results });
}
