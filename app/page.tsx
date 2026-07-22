'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import type { AnalyzeResponse, ReceiptRow } from '@/lib/types';
import {
  getSupabase,
  isSupabaseConfigured,
  type ReceiptDb,
} from '@/lib/supabase';

function sortRows(rows: ReceiptRow[]): ReceiptRow[] {
  return [...rows].sort((a, b) => {
    const da = a.date ?? '';
    const db = b.date ?? '';
    if (da === db) return a.createdAt - b.createdAt;
    if (!da) return 1;
    if (!db) return -1;
    return da.localeCompare(db);
  });
}

function toRow(r: ReceiptDb): ReceiptRow {
  return {
    id: r.id,
    date: r.date,
    amount: r.amount == null ? null : Number(r.amount),
    currency: r.currency,
    item: r.item ?? '',
    description: r.description ?? '',
    url: r.url ?? '',
    fileName: r.file_name,
    createdAt: new Date(r.created_at).getTime(),
  };
}

function formatAmount(n: number | null, currency: string | null): string {
  if (n === null || Number.isNaN(n)) return '';
  const s = n.toLocaleString(undefined, {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
  return currency ? `${currency} ${s}` : s;
}

export default function Page() {
  const [rows, setRows] = useState<ReceiptRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [uploading, setUploading] = useState(false);
  const [uploadMsg, setUploadMsg] = useState<string | null>(null);
  const [dbError, setDbError] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  const configured = isSupabaseConfigured();

  useEffect(() => {
    if (!configured) {
      setLoading(false);
      return;
    }
    (async () => {
      const supabase = getSupabase();
      if (!supabase) return;
      const { data, error } = await supabase
        .from('receipts')
        .select('*')
        .order('date', { ascending: true, nullsFirst: false })
        .order('created_at', { ascending: true });
      if (error) {
        setDbError(error.message);
      } else if (data) {
        setRows(data.map((d) => toRow(d as ReceiptDb)));
      }
      setLoading(false);
    })();
  }, [configured]);

  const sorted = useMemo(() => sortRows(rows), [rows]);

  const total = useMemo(() => {
    const byCcy = new Map<string, number>();
    for (const r of rows) {
      if (r.amount == null) continue;
      const ccy = r.currency || '';
      byCcy.set(ccy, (byCcy.get(ccy) || 0) + r.amount);
    }
    return Array.from(byCcy.entries()).map(([ccy, sum]) => ({ ccy, sum }));
  }, [rows]);

  async function persistUpdate(id: string, patch: Partial<ReceiptRow>) {
    const supabase = getSupabase();
    if (!supabase) return;
    const dbPatch: Partial<ReceiptDb> = {};
    if ('date' in patch) dbPatch.date = patch.date ?? null;
    if ('amount' in patch) dbPatch.amount = patch.amount ?? null;
    if ('currency' in patch) dbPatch.currency = patch.currency ?? null;
    if ('item' in patch) dbPatch.item = patch.item ?? '';
    if ('description' in patch) dbPatch.description = patch.description ?? '';
    if ('url' in patch) dbPatch.url = patch.url ?? '';
    const { error } = await supabase
      .from('receipts')
      .update(dbPatch)
      .eq('id', id);
    if (error) setDbError(error.message);
  }

  function updateRow(id: string, patch: Partial<ReceiptRow>) {
    setRows((prev) => prev.map((r) => (r.id === id ? { ...r, ...patch } : r)));
    void persistUpdate(id, patch);
  }

  async function deleteRow(id: string) {
    setRows((prev) => prev.filter((r) => r.id !== id));
    const supabase = getSupabase();
    if (!supabase) return;
    const { error } = await supabase.from('receipts').delete().eq('id', id);
    if (error) setDbError(error.message);
  }

  async function addBlankRow() {
    const supabase = getSupabase();
    if (!supabase) return;
    const { data, error } = await supabase
      .from('receipts')
      .insert({
        date: null,
        amount: null,
        currency: null,
        item: '',
        description: '',
        url: '',
        file_name: null,
      })
      .select('*')
      .single();
    if (error) {
      setDbError(error.message);
      return;
    }
    if (data) setRows((prev) => [...prev, toRow(data as ReceiptDb)]);
  }

  async function handleFiles(files: FileList | null) {
    if (!files || files.length === 0) return;
    setUploading(true);
    setUploadMsg(`Analyzing ${files.length} file(s)…`);
    try {
      const fd = new FormData();
      Array.from(files).forEach((f) => fd.append('files', f));
      const res = await fetch('/api/analyze', { method: 'POST', body: fd });
      const json = (await res.json()) as AnalyzeResponse;
      if (!res.ok) {
        setUploadMsg(json.error || 'Analysis failed');
        return;
      }
      const supabase = getSupabase();
      if (!supabase) {
        setUploadMsg('Supabase is not configured — cannot save rows.');
        return;
      }
      const toInsert: Omit<ReceiptDb, 'id' | 'created_at'>[] = [];
      const errors: string[] = [];
      const perFile: string[] = [];
      for (const r of json.results) {
        if (r.ok && r.items) {
          for (const it of r.items) {
            toInsert.push({
              date: it.date,
              amount: it.amount,
              currency: it.currency,
              item: it.item ?? '',
              description: it.description ?? '',
              url: '',
              file_name: r.fileName,
            });
          }
          perFile.push(`${r.fileName}: ${r.items.length}`);
        } else {
          errors.push(`${r.fileName}: ${r.error ?? 'failed'}`);
        }
      }
      if (toInsert.length > 0) {
        const { data, error } = await supabase
          .from('receipts')
          .insert(toInsert)
          .select('*');
        if (error) {
          setDbError(error.message);
          setUploadMsg(`Extracted ${toInsert.length} but DB insert failed.`);
          return;
        }
        if (data) {
          setRows((prev) =>
            sortRows([...prev, ...data.map((d) => toRow(d as ReceiptDb))]),
          );
        }
      }
      const summary = perFile.length ? ` (${perFile.join(', ')})` : '';
      setUploadMsg(
        errors.length === 0
          ? `Added ${toInsert.length} row(s)${summary}.`
          : `Added ${toInsert.length}${summary}. ${errors.length} file(s) failed: ${errors.join('; ')}`,
      );
    } catch (err) {
      setUploadMsg(err instanceof Error ? err.message : 'Something went wrong');
    } finally {
      setUploading(false);
      if (fileInputRef.current) fileInputRef.current.value = '';
      setTimeout(() => setUploadMsg(null), 6000);
    }
  }

  function exportCsv() {
    const header = ['Date', 'Amount', 'Currency', 'Item', 'Description', 'URL'];
    const escape = (v: string) =>
      /[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
    const lines = [header.join(',')];
    for (const r of sorted) {
      lines.push(
        [
          r.date ?? '',
          r.amount == null ? '' : String(r.amount),
          r.currency ?? '',
          r.item,
          r.description,
          r.url,
        ]
          .map((v) => escape(v))
          .join(','),
      );
    }
    const blob = new Blob([lines.join('\n')], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'receipts.csv';
    a.click();
    URL.revokeObjectURL(url);
  }

  async function clearAll() {
    if (
      rows.length > 0 &&
      !confirm(`Delete all ${rows.length} rows? This cannot be undone.`)
    ) {
      return;
    }
    const supabase = getSupabase();
    if (!supabase) return;
    const { error } = await supabase
      .from('receipts')
      .delete()
      .gte('created_at', '1900-01-01');
    if (error) {
      setDbError(error.message);
      return;
    }
    setRows([]);
  }

  function dbErrorHint(msg: string): string | null {
    if (/invalid path/i.test(msg)) {
      return 'Check NEXT_PUBLIC_SUPABASE_URL in Vercel — it should look like https://xxxx.supabase.co with no trailing slash and no /rest/v1 suffix. After fixing, redeploy.';
    }
    if (/relation .* does not exist/i.test(msg) || /receipts.*not found/i.test(msg)) {
      return 'The `receipts` table is missing. Open Supabase → SQL Editor and run supabase/schema.sql.';
    }
    if (/jwt|apikey|invalid api key/i.test(msg)) {
      return 'Check NEXT_PUBLIC_SUPABASE_ANON_KEY in Vercel — it should be the anon (public) key from Supabase → Project Settings → API. Redeploy after changing.';
    }
    if (/row-level security|rls/i.test(msg)) {
      return 'RLS is blocking the request. Re-run supabase/schema.sql to install the anon policies.';
    }
    return null;
  }

  if (!configured) {
    return (
      <main className="min-h-screen p-8">
        <div className="mx-auto max-w-2xl bg-white border border-gray-300 rounded-md p-6 shadow-sm">
          <h1 className="text-xl font-semibold mb-2">Setup required</h1>
          <p className="text-sm text-gray-700 mb-3">
            Supabase environment variables are not set. In Vercel → Project →
            Settings → Environment Variables, add:
          </p>
          <ul className="text-sm font-mono bg-gray-50 border border-gray-200 rounded p-3 mb-3">
            <li>NEXT_PUBLIC_SUPABASE_URL</li>
            <li>NEXT_PUBLIC_SUPABASE_ANON_KEY</li>
            <li>ANTHROPIC_API_KEY</li>
          </ul>
          <p className="text-sm text-gray-600">
            Then redeploy. See <code>README.md</code> for the full setup
            walk-through.
          </p>
        </div>
      </main>
    );
  }

  return (
    <main className="min-h-screen p-4 md:p-8">
      <div className="mx-auto max-w-7xl">
        <header className="flex flex-wrap items-center justify-between gap-3 mb-4">
          <div>
            <h1 className="text-2xl font-semibold">Receipt Analyzer</h1>
            <p className="text-sm text-gray-600">
              Upload receipts — Claude extracts amount, item, description, and
              date. Rows auto-sort by date and persist to Supabase. Fill the
              URL column with wherever the receipt lives.
            </p>
          </div>
          <div className="flex flex-wrap gap-2">
            <button
              onClick={() => fileInputRef.current?.click()}
              disabled={uploading}
              className="bg-blue-600 hover:bg-blue-700 disabled:bg-blue-300 text-white px-4 py-2 rounded-md text-sm font-medium"
            >
              {uploading ? 'Analyzing…' : 'Upload receipts'}
            </button>
            <input
              ref={fileInputRef}
              type="file"
              multiple
              accept="image/*,application/pdf"
              className="hidden"
              onChange={(e) => handleFiles(e.target.files)}
            />
            <button
              onClick={addBlankRow}
              className="bg-white border border-gray-300 hover:bg-gray-50 px-3 py-2 rounded-md text-sm"
            >
              + Blank row
            </button>
            <button
              onClick={exportCsv}
              className="bg-white border border-gray-300 hover:bg-gray-50 px-3 py-2 rounded-md text-sm"
            >
              Export CSV
            </button>
            <button
              onClick={clearAll}
              className="bg-white border border-red-300 text-red-700 hover:bg-red-50 px-3 py-2 rounded-md text-sm"
            >
              Clear
            </button>
          </div>
        </header>

        {uploadMsg && (
          <div className="mb-3 text-sm bg-blue-50 border border-blue-200 text-blue-900 rounded px-3 py-2">
            {uploadMsg}
          </div>
        )}
        {dbError && (
          <div className="mb-3 text-sm bg-red-50 border border-red-200 text-red-900 rounded px-3 py-2">
            <div>Database error: {dbError}</div>
            {dbErrorHint(dbError) && (
              <div className="mt-1 text-red-800">
                Likely fix — {dbErrorHint(dbError)}
              </div>
            )}
            <button
              onClick={() => setDbError(null)}
              className="mt-2 text-xs underline"
            >
              dismiss
            </button>
          </div>
        )}

        <div className="bg-white border border-gray-300 rounded-md shadow-sm overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-sm border-collapse">
              <thead className="bg-gray-100 text-left text-xs uppercase tracking-wide text-gray-600">
                <tr>
                  <th className="border-b border-gray-300 px-2 py-2 w-32">
                    Date of payment
                  </th>
                  <th className="border-b border-gray-300 px-2 py-2 w-32">
                    Amount
                  </th>
                  <th className="border-b border-gray-300 px-2 py-2 w-48">
                    Item
                  </th>
                  <th className="border-b border-gray-300 px-2 py-2">
                    Description
                  </th>
                  <th className="border-b border-gray-300 px-2 py-2 w-72">
                    URL / location
                  </th>
                  <th className="border-b border-gray-300 px-2 py-2 w-10"></th>
                </tr>
              </thead>
              <tbody>
                {loading && (
                  <tr>
                    <td colSpan={6} className="text-center text-gray-500 py-16">
                      Loading…
                    </td>
                  </tr>
                )}
                {!loading && sorted.length === 0 && (
                  <tr>
                    <td colSpan={6} className="text-center text-gray-500 py-16">
                      No receipts yet. Click{' '}
                      <span className="font-medium">Upload receipts</span> to
                      get started.
                    </td>
                  </tr>
                )}
                {sorted.map((r) => (
                  <tr
                    key={r.id}
                    className="odd:bg-white even:bg-gray-50 hover:bg-yellow-50/40"
                  >
                    <td className="border-b border-gray-200 p-0">
                      <input
                        type="date"
                        value={r.date ?? ''}
                        onChange={(e) =>
                          updateRow(r.id, { date: e.target.value || null })
                        }
                        className="cell-input font-mono"
                      />
                    </td>
                    <td className="border-b border-gray-200 p-0">
                      <div className="flex items-center">
                        <input
                          type="text"
                          value={r.currency ?? ''}
                          onChange={(e) =>
                            updateRow(r.id, {
                              currency: e.target.value.toUpperCase() || null,
                            })
                          }
                          placeholder="CCY"
                          className="cell-input w-14 text-gray-500 font-mono"
                          maxLength={4}
                        />
                        <input
                          type="number"
                          step="0.01"
                          value={r.amount ?? ''}
                          onChange={(e) => {
                            const v = e.target.value;
                            updateRow(r.id, {
                              amount: v === '' ? null : Number(v),
                            });
                          }}
                          placeholder="0.00"
                          className="cell-input flex-1 text-right font-mono"
                        />
                      </div>
                    </td>
                    <td className="border-b border-gray-200 p-0">
                      <input
                        type="text"
                        value={r.item}
                        onChange={(e) =>
                          updateRow(r.id, { item: e.target.value })
                        }
                        className="cell-input"
                        placeholder="Merchant / item"
                      />
                    </td>
                    <td className="border-b border-gray-200 p-0">
                      <input
                        type="text"
                        value={r.description}
                        onChange={(e) =>
                          updateRow(r.id, { description: e.target.value })
                        }
                        className="cell-input"
                        placeholder="Description"
                      />
                    </td>
                    <td className="border-b border-gray-200 p-0">
                      <input
                        type="url"
                        value={r.url}
                        onChange={(e) =>
                          updateRow(r.id, { url: e.target.value })
                        }
                        className="cell-input"
                        placeholder="https://…"
                      />
                    </td>
                    <td className="border-b border-gray-200 text-center">
                      <button
                        onClick={() => deleteRow(r.id)}
                        title="Delete row"
                        className="text-gray-400 hover:text-red-600 px-2"
                      >
                        ×
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
              {total.length > 0 && (
                <tfoot className="bg-gray-50">
                  <tr>
                    <td className="px-2 py-2 text-right text-xs uppercase tracking-wide text-gray-500 font-medium">
                      Total
                    </td>
                    <td className="px-2 py-2 font-mono text-right" colSpan={5}>
                      {total.map((t) => (
                        <span key={t.ccy} className="mr-4">
                          {formatAmount(t.sum, t.ccy || null)}
                        </span>
                      ))}
                    </td>
                  </tr>
                </tfoot>
              )}
            </table>
          </div>
        </div>

        <p className="text-xs text-gray-500 mt-3">
          Rows are stored in your Supabase project. Edits save automatically.
        </p>
      </div>
    </main>
  );
}
