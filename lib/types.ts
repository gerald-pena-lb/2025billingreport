export type ItemKind =
  | 'payment'
  | 'incoming'
  | 'conversion'
  | 'withdrawal'
  | 'cashback'
  | 'refund'
  | 'balance'
  | 'other';

export type ReceiptRow = {
  id: string;
  date: string | null;        // YYYY-MM-DD
  amount: number | null;
  value: number | null;        // how much was actually paid (editable)
  currency: string | null;
  item: string;
  description: string;
  notes: string;               // user-fillable notes
  url: string;                 // user-fillable
  kind: ItemKind;
  owner: string | null;        // Alinka / Anette / Gerald / Glenda / null
  invoiceId: string | null;    // associated invoice ID
  fileName?: string | null;
  createdAt: number;           // epoch ms, derived from created_at
};

export type ExtractedItem = {
  date: string | null;
  amount: number | null;
  currency: string | null;
  item: string | null;
  description: string | null;
  kind: ItemKind;
};

export type AnalyzeResult = {
  fileName: string;
  ok: boolean;
  error?: string;
  items?: ExtractedItem[];
  pages?: number;
  pageNotes?: string[];
};

export type AnalyzeResponse = {
  results: AnalyzeResult[];
  error?: string;
};

export type InvoiceDb = {
  id: string;
  file_name: string;
  file_data: string;
  mime_type: string;
  created_at: string;
};

export type InvoiceMatch = {
  receiptId: string;
  invoiceId: string;
  confidence: number;
};
