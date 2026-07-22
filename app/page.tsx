'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import type { AnalyzeResponse, ReceiptRow } from '@/lib/types';

const STORAGE_ROWS = 'receipts.rows.v1';
const STORAGE_KEY = 'receipts.apikey.v1';

function uid() {
  return Math.random().toString(36).slice(2) + Date.now().toString(36);
}

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
  const [apiKey, setApiKey] = useState('');
  const [showSettings, setShowSettings] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [uploadMsg, setUploadMsg] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    try {
      const raw = localStorage.getItem(STORAGE_ROWS);
      if (raw) setRows(JSON.parse(raw));
      const key = localStorage.getItem(STORAGE_KEY);
      if (key) setApiKey(key);
    } catch {}
  }, []);

  useEffect(() => {
    try {
      localStorage.setItem(STORAGE_ROWS, JSON.stringify(rows));
    } catch {}
  }, [rows]);

  const sorted = useMemo(() => sortRows(rows), [rows]);

  const total = useMemo(() => {
    const byCcy = new Map<string, number>();
    for (const r of rows) {
      if (r.amount == null) continue;
      const ccy = r.currency || '';
      byCcy.set(ccy, (byCcy.get(ccy) || 0) + r.amount);
    }
    return Array.from(byCcy.entries()).map(([ccy, sum]) => ({
      ccy,
      sum,
    }));
  }, [rows]);

  function updateRow(id: string, patch: Partial<ReceiptRow>) {
    setRows((prev) => prev.map((r) => (r.id === id ? { ...r, ...patch } : r)));
  }

  function deleteRow(id: string) {
    setRows((prev) => prev.filter((r) => r.id !== id));
  }

  function addBlankRow() {
    setRows((prev) => [
      ...prev,
      {
        id: uid(),
        date: null,
        amount: null,
        currency: null,
        item: '',
        description: '',
        url: '',
        createdAt: Date.now(),
      },
    ]);
  }

  async function handleFiles(files: FileList | null) {
    if (!files || files.length === 0) return;
    if (!apiKey && !confirmServerKeyAvailable()) {
      setShowSettings(true);
      return;
    }
    setUploading(true);
    setUploadMsg(`Analyzing ${files.length} file(s)…`);
    try {
      const fd = new FormData();
      Array.from(files).forEach((f) => fd.append('files', f));
      const res = await fetch('/api/analyze', {
        method: 'POST',
        headers: apiKey ? { 'x-anthropic-api-key': apiKey } : undefined,
        body: fd,
      });
      const json = (await res.json()) as AnalyzeResponse;
      if (!res.ok) {
        setUploadMsg(json.error || 'Analysis failed');
        return;
      }
      const newRows: ReceiptRow[] = [];
      const errors: string[] = [];
      for (const r of json.results) {
        if (r.ok && r.data) {
          newRows.push({
            id: uid(),
            date: r.data.date,
            amount: r.data.amount,
            currency: r.data.currency,
            item: r.data.item ?? '',
            description: r.data.description ?? '',
            url: '',
            fileName: r.fileName,
            createdAt: Date.now(),
          });
        } else {
          errors.push(`${r.fileName}: ${r.error ?? 'failed'}`);
        }
      }
      setRows((prev) => sortRows([...prev, ...newRows]));
      setUploadMsg(
        errors.length === 0
          ? `Added ${newRows.length} row(s).`
          : `Added ${newRows.length}, ${errors.length} failed: ${errors.join('; ')}`,
      );
    } catch (err) {
      setUploadMsg(
        err instanceof Error ? err.message : 'Something went wrong',
      );
    } finally {
      setUploading(false);
      if (fileInputRef.current) fileInputRef.current.value = '';
      setTimeout(() => setUploadMsg(null), 6000);
    }
  }

  function confirmServerKeyAvailable() {
    // We can't check server env from the client without a call; the API will
    // 400 if neither header nor env has a key. Let the request go through and
    // rely on the error path.
    return true;
  }

  function saveKey() {
    try {
      localStorage.setItem(STORAGE_KEY, apiKey);
    } catch {}
    setShowSettings(false);
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

  function clearAll() {
    if (
      rows.length > 0 &&
      !confirm(`Delete all ${rows.length} rows? This cannot be undone.`)
    ) {
      return;
    }
    setRows([]);
  }

  return (
    <main className="min-h-screen p-4 md:p-8">
      <div className="mx-auto max-w-7xl">
        <header className="flex flex-wrap items-center justify-between gap-3 mb-4">
          <div>
            <h1 className="text-2xl font-semibold">Receipt Analyzer</h1>
            <p className="text-sm text-gray-600">
              Upload receipts — Claude extracts amount, item, description, and
              date. Rows auto-sort by date. Fill the URL column with wherever
              the receipt lives.
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
              onClick={() => setShowSettings((s) => !s)}
              className="bg-white border border-gray-300 hover:bg-gray-50 px-3 py-2 rounded-md text-sm"
            >
              Settings
            </button>
            <button
              onClick={clearAll}
              className="bg-white border border-red-300 text-red-700 hover:bg-red-50 px-3 py-2 rounded-md text-sm"
            >
              Clear
            </button>
          </div>
        </header>

        {showSettings && (
          <div className="bg-white border border-gray-200 rounded-md p-4 mb-4 shadow-sm">
            <label className="block text-sm font-medium mb-1">
              Anthropic API key
            </label>
            <p className="text-xs text-gray-500 mb-2">
              Stored in your browser only. Alternatively, set{' '}
              <code className="bg-gray-100 px-1">ANTHROPIC_API_KEY</code> in{' '}
              <code className="bg-gray-100 px-1">.env.local</code> on the
              server and leave this blank.
            </p>
            <div className="flex gap-2">
              <input
                type="password"
                value={apiKey}
                onChange={(e) => setApiKey(e.target.value)}
                placeholder="sk-ant-…"
                className="flex-1 border border-gray-300 rounded px-2 py-1 text-sm"
              />
              <button
                onClick={saveKey}
                className="bg-gray-900 text-white px-3 py-1 rounded text-sm"
              >
                Save
              </button>
            </div>
          </div>
        )}

        {uploadMsg && (
          <div className="mb-3 text-sm bg-blue-50 border border-blue-200 text-blue-900 rounded px-3 py-2">
            {uploadMsg}
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
                {sorted.length === 0 && (
                  <tr>
                    <td
                      colSpan={6}
                      className="text-center text-gray-500 py-16"
                    >
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
          Data is stored in your browser (localStorage). Export to CSV to keep
          a copy.
        </p>
      </div>
    </main>
  );
}
