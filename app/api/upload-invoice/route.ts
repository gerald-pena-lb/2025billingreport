import { NextRequest, NextResponse } from 'next/server';
import Anthropic from '@anthropic-ai/sdk';
import { PDFDocument, PDFPage } from 'pdf-lib';
import { createClient } from '@supabase/supabase-js';
import * as XLSX from 'xlsx';

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

async function fileToChunks(
  file: File,
): Promise<
  Array<{
    type: 'image' | 'document' | 'text';
    bytes?: string;
    mediaType?: string;
    text?: string;
    label: string;
  }>
> {
  const bytes = await file.arrayBuffer();
  const uint8Array = new Uint8Array(bytes);

  if (file.type === 'application/pdf') {
    return [
      {
        type: 'document',
        bytes: Buffer.from(uint8Array).toString('base64'),
        mediaType: 'application/pdf',
        label: file.name,
      },
    ];
  }

  if (file.type === 'text/csv' || file.name.endsWith('.csv')) {
    const text = new TextDecoder().decode(uint8Array);
    return [
      {
        type: 'text',
        text: `CSV Invoice Data:\n${text}`,
        label: file.name,
      },
    ];
  }

  if (
    file.type === 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' ||
    file.type === 'application/vnd.ms-excel' ||
    file.name.endsWith('.xlsx') ||
    file.name.endsWith('.xls')
  ) {
    try {
      const workbook = XLSX.read(uint8Array, { type: 'array' });
      let csvText = '';
      for (const sheetName of workbook.SheetNames) {
        const sheet = workbook.Sheets[sheetName];
        csvText += `Sheet: ${sheetName}\n`;
        csvText += XLSX.utils.sheet_to_csv(sheet) + '\n\n';
      }
      return [
        {
          type: 'text',
          text: `Excel Invoice Data:\n${csvText}`,
          label: file.name,
        },
      ];
    } catch {
      return [
        {
          type: 'text',
          text: 'Failed to parse Excel file',
          label: file.name,
        },
      ];
    }
  }

  if (file.type.startsWith('image/')) {
    return [
      {
        type: 'image',
        bytes: Buffer.from(uint8Array).toString('base64'),
        mediaType: file.type as 'image/jpeg' | 'image/png' | 'image/gif' | 'image/webp',
        label: file.name,
      },
    ];
  }

  return [
    {
      type: 'text',
      text: 'Unsupported file format',
      label: file.name,
    },
  ];
}

async function extractInvoiceItems(
  chunks: Array<{
    type: 'image' | 'document' | 'text';
    bytes?: string;
    mediaType?: string;
    text?: string;
    label: string;
  }>,
): Promise<InvoiceLineItem[]> {
  const items: InvoiceLineItem[] = [];

  for (const chunk of chunks) {
    const messageContent: Array<{
      type: 'text' | 'image' | 'document';
      text?: string;
      source?: {
        type: 'base64';
        media_type?: 'image/jpeg' | 'image/png' | 'image/gif' | 'image/webp' | 'application/pdf';
        data?: string;
      };
    }> = [];

    if (chunk.type === 'image' && chunk.bytes) {
      messageContent.push({
        type: 'image',
        source: {
          type: 'base64',
          media_type: chunk.mediaType as 'image/jpeg' | 'image/png' | 'image/gif' | 'image/webp',
          data: chunk.bytes,
        },
      });
    } else if (chunk.type === 'document' && chunk.bytes) {
      messageContent.push({
        type: 'document',
        source: {
          type: 'base64',
          media_type: 'application/pdf',
          data: chunk.bytes,
        },
      } as any);
    } else if (chunk.type === 'text' && chunk.text) {
      messageContent.push({
        type: 'text',
        text: chunk.text,
      });
    }

    messageContent.push({
      type: 'text',
      text: `Extract all line items from this invoice (${chunk.label}). Return JSON in this format: {"items": [{"date": "YYYY-MM-DD" or null, "amount": number, "currency": "USD" etc, "description": string}]}. Return ONLY valid JSON.`,
    });

    try {
      const response = await anthropic.messages.create({
        model: 'claude-sonnet-5',
        max_tokens: 4000,
        system: INVOICE_SYSTEM_PROMPT,
        messages: [
          {
            role: 'user',
            content: messageContent as any,
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
          console.error('Failed to parse invoice extraction:', content.text);
        }
      }
    } catch (error) {
      console.error('Claude API error:', error);
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
