import { NextRequest, NextResponse } from 'next/server';
import Anthropic from '@anthropic-ai/sdk';
import { PDFDocument } from 'pdf-lib';
import { createClient } from '@supabase/supabase-js';

export const runtime = 'nodejs';
export const maxDuration = 300;

const anthropic = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY,
});

type InvoiceLineItem = {
  date: string | null;
  amount: number | null;
  currency: string | null;
  description: string;
};

const INVOICE_SYSTEM_PROMPT = `You are an invoice analyzer. Extract all line items from the invoice.

Return ONLY a JSON object:
{
  "items": [
    {
      "date": "YYYY-MM-DD" | null,
      "amount": number,
      "currency": "USD" | "EUR" | ... | null,
      "description": string
    }
  ]
}`;

async function fileToChunks(file: File): Promise<Array<{ bytes: string; mediaType: string; label: string }>> {
  const bytes = await file.arrayBuffer();
  const uint8Array = new Uint8Array(bytes);

  const mediaType = file.type.startsWith('image/') ? file.type : 'image/jpeg';

  return [
    {
      bytes: Buffer.from(uint8Array).toString('base64'),
      mediaType: mediaType as 'image/jpeg' | 'image/png' | 'image/gif' | 'image/webp',
      label: file.name,
    },
  ];
}

async function extractInvoiceItems(
  chunks: Array<{ bytes: string; mediaType: string; label: string }>,
): Promise<InvoiceLineItem[]> {
  const items: InvoiceLineItem[] = [];

  for (const chunk of chunks) {
    const response = await anthropic.messages.create({
      model: 'claude-sonnet-5',
      max_tokens: 4000,
      system: INVOICE_SYSTEM_PROMPT,
      messages: [
        {
          role: 'user',
          content: [
            {
              type: 'image',
              source: {
                type: 'base64',
                media_type: chunk.mediaType as 'image/jpeg' | 'image/png' | 'image/gif' | 'image/webp',
                data: chunk.bytes,
              },
            },
            {
              type: 'text',
              text: `Extract all line items from this invoice image (${chunk.label}). Return JSON only.`,
            },
          ],
        },
      ],
    });

    const content = response.content[0];
    if (content.type === 'text') {
      try {
        const parsed = JSON.parse(content.text);
        if (parsed.items && Array.isArray(parsed.items)) {
          items.push(...parsed.items);
        }
      } catch {
        console.error('Failed to parse invoice extraction');
      }
    }
  }

  return items;
}

export async function POST(request: NextRequest) {
  try {
    const formData = await request.formData();
    const files = formData.getAll('files') as File[];

    if (!files || files.length === 0) {
      return NextResponse.json({ error: 'No files provided' }, { status: 400 });
    }

    const supabase = createClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL || '',
      process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || '',
    );

    const uploadedInvoices = [];

    for (const file of files) {
      const chunks = await fileToChunks(file);
      const invoiceItems = await extractInvoiceItems(chunks);

      const fileBuffer = await file.arrayBuffer();
      const base64Data = Buffer.from(fileBuffer).toString('base64');

      const { data: invoice, error: insertError } = await supabase
        .from('invoices')
        .insert({
          file_name: file.name,
          file_data: base64Data,
          mime_type: file.type,
        })
        .select('id')
        .single();

      if (insertError || !invoice) {
        return NextResponse.json({ error: insertError?.message || 'Failed to upload invoice' }, { status: 500 });
      }

      uploadedInvoices.push({
        invoiceId: invoice.id,
        fileName: file.name,
        items: invoiceItems,
      });
    }

    return NextResponse.json({
      success: true,
      invoices: uploadedInvoices,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
