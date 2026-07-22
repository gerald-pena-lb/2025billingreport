export type ReceiptRow = {
  id: string;
  date: string | null;        // YYYY-MM-DD
  amount: number | null;
  currency: string | null;
  item: string;
  description: string;
  url: string;                 // user-fillable
  fileName?: string | null;
  createdAt: number;           // epoch ms, derived from created_at
};

export type ExtractedItem = {
  date: string | null;
  amount: number | null;
  currency: string | null;
  item: string | null;
  description: string | null;
};

export type AnalyzeResult = {
  fileName: string;
  ok: boolean;
  error?: string;
  items?: ExtractedItem[];
};

export type AnalyzeResponse = {
  results: AnalyzeResult[];
  error?: string;
};
