'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import type { AnalyzeResponse, ItemKind, ReceiptRow } from '@/lib/types';
import {
  getSupabase,
  isSupabaseConfigured,
  type ReceiptDb,
} from '@/lib/supabase';

const KIND_LABEL: Record<ItemKind, string> = {
  payment: 'Payment',
  incoming: 'Incoming',
  refund: 'Refund',
  conversion: 'Conversion',
  withdrawal: 'Withdrawal',
  cashback: 'Cashback',
  balance: 'Balance',
  other: 'Other',
};

const KIND_STYLE: Record<ItemKind, string> = {
  payment: 'bg-emerald-100 text-emerald-800 border-emerald-200',
  incoming: 'bg-sky-100 text-sky-800 border-sky-200',
  refund: 'bg-sky-100 text-sky-800 border-sky-200',
  conversion: 'bg-amber-100 text-amber-800 border-amber-200',
  withdrawal: 'bg-amber-100 text-amber-800 border-amber-200',
  cashback: 'bg-sky-100 text-sky-800 border-sky-200',
  balance: 'bg-gray-100 text-gray-700 border-gray-200',
  other: 'bg-gray-100 text-gray-700 border-gray-200',
};

const ALL_KINDS: ItemKind[] = [
  'payment',
  'incoming',
  'refund',
  'conversion',
  'withdrawal',
  'cashback',
  'balance',
  'other',
];

function normKind(k: string | null | undefined): ItemKind {
  if (k && (ALL_KINDS as string[]).includes(k)) return k as ItemKind;
  return 'other';
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

function toRow(r: ReceiptDb): ReceiptRow {
  const amt = r.amount == null ? null : Number(r.amount);
  const val = r.value == null ? amt : Number(r.value);
  return {
    id: r.id,
    date: r.date,
    amount: amt,
    value: val,
    currency: r.currency,
    item: r.item ?? '',
    description: r.description ?? '',
    url: r.url ?? '',
    kind: normKind(r.kind),
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
  const [kindFilter, setKindFilter] = useState<'all' | ItemKind>('all');
  const [itemFilter, setItemFilter] = useState('');
  const [descFilter, setDescFilter] = useState('');
  const [hoverDesc, setHoverDesc] = useState<{
    text: string;
    x: number;
    y: number;
  } | null>(null);
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
  const visible = useMemo(() => {
    const it = itemFilter.trim().toLowerCase();
    const de = descFilter.trim().toLowerCase();
    return sorted.filter((r) => {
      if (kindFilter !== 'all' && r.kind !== kindFilter) return false;
      if (it && !r.item.toLowerCase().includes(it)) return false;
      if (de && !r.description.toLowerCase().includes(de)) return false;
      return true;
    });
  }, [sorted, kindFilter, itemFilter, descFilter]);

  const filterActive =
    kindFilter !== 'all' || itemFilter.trim() !== '' || descFilter.trim() !== '';

  const kindCounts = useMemo(() => {
    const m = new Map<ItemKind, number>();
    for (const r of rows) m.set(r.kind, (m.get(r.kind) ?? 0) + 1);
    return m;
  }, [rows]);

  const total = useMemo(() => {
    const byCcy = new Map<string, number>();
    for (const r of visible) {
      const v = r.value ?? r.amount;
      if (v == null) continue;
      const ccy = r.currency || '';
      byCcy.set(ccy, (byCcy.get(ccy) || 0) + v);
    }
    return Array.from(byCcy.entries()).map(([ccy, sum]) => ({ ccy, sum }));
  }, [visible]);

  async function persistUpdate(id: string, patch: Partial<ReceiptRow>) {
    const supabase = getSupabase();
    if (!supabase) return;
    const dbPatch: Partial<ReceiptDb> = {};
    if ('date' in patch) dbPatch.date = patch.date ?? null;
    if ('amount' in patch) dbPatch.amount = patch.amount ?? null;
    if ('value' in patch) dbPatch.value = patch.value ?? null;
    if ('currency' in patch) dbPatch.currency = patch.currency ?? null;
    if ('item' in patch) dbPatch.item = patch.item ?? '';
    if ('description' in patch) dbPatch.description = patch.description ?? '';
    if ('url' in patch) dbPatch.url = patch.url ?? '';
    if ('kind' in patch) dbPatch.kind = patch.kind ?? 'other';
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

  async function deleteNonPayments() {
    const nonPayIds = rows.filter((r) => r.kind !== 'payment').map((r) => r.id);
    if (nonPayIds.length === 0) return;
    if (
      !confirm(
        `Delete ${nonPayIds.length} non-payment row(s) (incoming, conversions, withdrawals, cashback, other)?`,
      )
    ) {
      return;
    }
    const supabase = getSupabase();
    if (!supabase) return;
    const { error } = await supabase
      .from('receipts')
      .delete()
      .in('id', nonPayIds);
    if (error) {
      setDbError(error.message);
      return;
    }
    setRows((prev) => prev.filter((r) => r.kind === 'payment'));
  }

  async function addBlankRow() {
    const supabase = getSupabase();
    if (!supabase) return;
    const { data, error } = await supabase
      .from('receipts')
      .insert({
        date: null,
        amount: null,
        value: null,
        currency: null,
        item: '',
        description: '',
        url: '',
        file_name: null,
        kind: 'payment',
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
          const kindCount = new Map<ItemKind, number>();
          for (const it of r.items) {
            const k = normKind(it.kind);
            kindCount.set(k, (kindCount.get(k) ?? 0) + 1);
            toInsert.push({
              date: it.date,
              amount: it.amount,
              value: it.amount,
              currency: it.currency,
              item: it.item ?? '',
              description: it.description ?? '',
              url: '',
              file_name: r.fileName,
              kind: k,
            });
          }
          const breakdown = Array.from(kindCount.entries())
            .map(([k, n]) => `${n} ${k}`)
            .join(', ');
          const pageInfo =
            r.pages && r.pages > 1 ? ` [${r.pageNotes?.join(', ')}]` : '';
          perFile.push(
            `${r.fileName}: ${r.items.length} (${breakdown})${pageInfo}`,
          );
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
      const summary = perFile.length ? ` — ${perFile.join(' · ')}` : '';
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
      setTimeout(() => setUploadMsg(null), 12000);
    }
  }

  function exportCsv() {
    const header = [
      'Date',
      'Amount',
      'Value',
      'Currency',
      'Item',
      'Description',
      'URL',
      'Kind',
    ];
    const escape = (v: string) =>
      /[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
    const lines = [header.join(',')];
    for (const r of visible) {
      lines.push(
        [
          r.date ?? '',
          r.amount == null ? '' : String(r.amount),
          r.value == null ? '' : String(r.value),
          r.currency ?? '',
          r.item,
          r.description,
          r.url,
          r.kind,
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
    if (
      /relation .* does not exist/i.test(msg) ||
      /receipts.*not found/i.test(msg) ||
      /column .* does not exist/i.test(msg)
    ) {
      return 'The `receipts` table is missing or out of date. Open Supabase → SQL Editor and re-run supabase/schema.sql (it is idempotent and safe to re-run).';
    }
    if (/jwt|apikey|invalid api key/i.test(msg)) {
      return 'Check NEXT_PUBLIC_SUPABASE_ANON_KEY in Vercel. Redeploy after changing.';
    }
    if (/row-level security|rls/i.test(msg)) {
      return 'RLS is blocking the request. Re-run supabase/schema.sql to install the anon policies.';
    }
    return null;
  }

  if (!configured) {
    return (
      <main className="min-h-screen p-4 md:p-8">
        <div className="mx-auto max-w-2xl bg-white border border-gray-300 rounded-md p-4 md:p-6 shadow-sm">
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

  const nonPaymentCount = rows.length - (kindCounts.get('payment') ?? 0);

  return (
    <main className="min-h-screen p-3 md:p-8">
      <div className="mx-auto max-w-7xl">
        <header className="mb-4">
          <div className="mb-3">
            <h1 className="text-xl md:text-2xl font-semibold">
              Receipt Analyzer
            </h1>
            <p className="text-xs md:text-sm text-gray-600 mt-1">
              Upload receipts or statements — Claude extracts every line and
              tags each as payment / incoming / conversion / etc. Scan the
              badges and delete anything that isn't a real expense.
            </p>
          </div>
          <div className="grid grid-cols-2 md:flex md:flex-wrap gap-2">
            <button
              onClick={() => fileInputRef.current?.click()}
              disabled={uploading}
              className="col-span-2 md:col-auto bg-blue-600 hover:bg-blue-700 disabled:bg-blue-300 text-white px-4 py-2.5 md:py-2 rounded-md text-sm font-medium"
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
              onClick={deleteNonPayments}
              disabled={nonPaymentCount === 0}
              className="bg-white border border-amber-300 text-amber-800 hover:bg-amber-50 disabled:opacity-40 px-3 py-2 rounded-md text-sm"
              title="Delete every row not tagged as 'payment'"
            >
              Delete non-payments{nonPaymentCount ? ` (${nonPaymentCount})` : ''}
            </button>
            <button
              onClick={clearAll}
              className="bg-white border border-red-300 text-red-700 hover:bg-red-50 px-3 py-2 rounded-md text-sm"
            >
              Clear all
            </button>
          </div>
        </header>

        {/* Mobile-only filter bar (headers are inside the table on desktop) */}
        <div className="md:hidden grid grid-cols-1 gap-2 mb-3">
          <select
            value={kindFilter}
            onChange={(e) => setKindFilter(e.target.value as 'all' | ItemKind)}
            className="w-full border border-gray-300 rounded px-2 py-2 text-sm bg-white"
          >
            <option value="all">All categories ({rows.length})</option>
            {ALL_KINDS.filter((k) => kindCounts.get(k)).map((k) => (
              <option key={k} value={k}>
                {KIND_LABEL[k]} ({kindCounts.get(k)})
              </option>
            ))}
          </select>
          <div className="grid grid-cols-2 gap-2">
            <input
              type="text"
              value={itemFilter}
              onChange={(e) => setItemFilter(e.target.value)}
              placeholder="Filter by item…"
              className="border border-gray-300 rounded px-2 py-2 text-sm"
            />
            <input
              type="text"
              value={descFilter}
              onChange={(e) => setDescFilter(e.target.value)}
              placeholder="Filter by description…"
              className="border border-gray-300 rounded px-2 py-2 text-sm"
            />
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-3 mb-3 text-sm">
          <span className="text-gray-500 text-xs">
            Showing {visible.length} of {rows.length}
          </span>
          {filterActive && (
            <button
              onClick={() => {
                setKindFilter('all');
                setItemFilter('');
                setDescFilter('');
              }}
              className="text-xs text-blue-600 underline"
            >
              clear all filters
            </button>
          )}
        </div>

        {uploadMsg && (
          <div className="mb-3 text-sm bg-blue-50 border border-blue-200 text-blue-900 rounded px-3 py-2 whitespace-pre-wrap">
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

        {/* Desktop / tablet: spreadsheet view */}
        <div className="hidden md:block bg-white border border-gray-300 rounded-md shadow-sm overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-sm border-collapse">
              <thead className="bg-gray-100 text-left text-xs uppercase tracking-wide text-gray-600 sticky top-0 z-10">
                <tr>
                  <th className="border-b border-gray-300 px-2 py-2 w-32 align-top">
                    <div>Date of payment</div>
                    <div className="h-6 mt-1" />
                  </th>
                  <th className="border-b border-gray-300 px-2 py-2 w-32 align-top">
                    <div>Amount</div>
                    <div className="h-6 mt-1" />
                  </th>
                  <th className="border-b border-gray-300 px-2 py-2 w-28 align-top">
                    <div>Value</div>
                    <div className="h-6 mt-1" />
                  </th>
                  <th className="border-b border-gray-300 px-2 py-2 w-36 align-top">
                    <div>Kind</div>
                    <select
                      value={kindFilter}
                      onChange={(e) =>
                        setKindFilter(e.target.value as 'all' | ItemKind)
                      }
                      title="Filter by kind"
                      className="mt-1 w-full text-[11px] font-normal normal-case border border-gray-300 bg-white rounded px-1 py-0.5"
                    >
                      <option value="all">All ({rows.length})</option>
                      {ALL_KINDS.filter((k) => kindCounts.get(k)).map((k) => (
                        <option key={k} value={k}>
                          {KIND_LABEL[k]} ({kindCounts.get(k)})
                        </option>
                      ))}
                    </select>
                  </th>
                  <th className="border-b border-gray-300 px-2 py-2 w-48 align-top">
                    <div>Item</div>
                    <input
                      type="text"
                      value={itemFilter}
                      onChange={(e) => setItemFilter(e.target.value)}
                      placeholder="filter…"
                      className="mt-1 w-full text-[11px] font-normal normal-case border border-gray-300 bg-white rounded px-1 py-0.5"
                    />
                  </th>
                  <th className="border-b border-gray-300 px-2 py-2 align-top">
                    <div>Description</div>
                    <input
                      type="text"
                      value={descFilter}
                      onChange={(e) => setDescFilter(e.target.value)}
                      placeholder="filter…"
                      className="mt-1 w-full text-[11px] font-normal normal-case border border-gray-300 bg-white rounded px-1 py-0.5"
                    />
                  </th>
                  <th className="border-b border-gray-300 px-2 py-2 w-72 align-top">
                    <div>URL / location</div>
                    <div className="h-6 mt-1" />
                  </th>
                  <th className="border-b border-gray-300 px-2 py-2 w-10 align-top"></th>
                </tr>
              </thead>
              <tbody>
                {loading && (
                  <tr>
                    <td colSpan={8} className="text-center text-gray-500 py-16">
                      Loading…
                    </td>
                  </tr>
                )}
                {!loading && visible.length === 0 && (
                  <tr>
                    <td colSpan={8} className="text-center text-gray-500 py-16">
                      {rows.length === 0
                        ? 'No receipts yet. Click Upload receipts to get started.'
                        : 'No rows match the current filter.'}
                    </td>
                  </tr>
                )}
                {visible.map((r) => (
                  <tr
                    key={r.id}
                    className={`odd:bg-white even:bg-gray-50 hover:bg-yellow-50/40 ${
                      r.kind !== 'payment' ? 'text-gray-500' : ''
                    }`}
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
                        type="number"
                        step="0.01"
                        value={r.value ?? ''}
                        onChange={(e) => {
                          const v = e.target.value;
                          updateRow(r.id, {
                            value: v === '' ? null : Number(v),
                          });
                        }}
                        placeholder="0.00"
                        className="cell-input text-right font-mono"
                      />
                    </td>
                    <td className="border-b border-gray-200 p-1">
                      <select
                        value={r.kind}
                        onChange={(e) =>
                          updateRow(r.id, { kind: e.target.value as ItemKind })
                        }
                        className={`w-full text-xs px-2 py-1 rounded border ${KIND_STYLE[r.kind]} outline-none`}
                      >
                        {ALL_KINDS.map((k) => (
                          <option key={k} value={k}>
                            {KIND_LABEL[k]}
                          </option>
                        ))}
                      </select>
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
                    <td
                      className="border-b border-gray-200 p-0"
                      onMouseEnter={(e) => {
                        if (!r.description) return;
                        const rect = (
                          e.currentTarget as HTMLTableCellElement
                        ).getBoundingClientRect();
                        setHoverDesc({
                          text: r.description,
                          x: rect.left,
                          y: rect.bottom,
                        });
                      }}
                      onMouseLeave={() => setHoverDesc(null)}
                    >
                      <input
                        type="text"
                        value={r.description}
                        onChange={(e) =>
                          updateRow(r.id, { description: e.target.value })
                        }
                        onFocus={() => setHoverDesc(null)}
                        title={r.description}
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
                      Total value{' '}
                      {kindFilter === 'all' ? '(shown)' : `(${kindFilter})`}
                    </td>
                    <td className="px-2 py-2 font-mono text-right" colSpan={7}>
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

        {/* Mobile: card view */}
        <div className="md:hidden space-y-2">
          {loading && (
            <div className="bg-white border border-gray-300 rounded-md p-6 text-center text-gray-500 text-sm">
              Loading…
            </div>
          )}
          {!loading && visible.length === 0 && (
            <div className="bg-white border border-gray-300 rounded-md p-6 text-center text-gray-500 text-sm">
              {rows.length === 0
                ? 'No receipts yet. Tap Upload receipts to get started.'
                : 'No rows match the current filter.'}
            </div>
          )}
          {visible.map((r) => (
            <div
              key={r.id}
              className={`bg-white border border-gray-300 rounded-md p-3 shadow-sm ${
                r.kind !== 'payment' ? 'opacity-70' : ''
              }`}
            >
              <div className="flex items-start justify-between gap-2 mb-2">
                <select
                  value={r.kind}
                  onChange={(e) =>
                    updateRow(r.id, { kind: e.target.value as ItemKind })
                  }
                  className={`text-xs px-2 py-1 rounded border ${KIND_STYLE[r.kind]} outline-none`}
                >
                  {ALL_KINDS.map((k) => (
                    <option key={k} value={k}>
                      {KIND_LABEL[k]}
                    </option>
                  ))}
                </select>
                <button
                  onClick={() => deleteRow(r.id)}
                  className="text-gray-400 hover:text-red-600 text-xl leading-none px-2 -mt-1"
                  aria-label="Delete row"
                >
                  ×
                </button>
              </div>

              <div className="grid grid-cols-2 gap-2 mb-2">
                <label className="block">
                  <span className="block text-[10px] uppercase tracking-wide text-gray-500 mb-0.5">
                    Date
                  </span>
                  <input
                    type="date"
                    value={r.date ?? ''}
                    onChange={(e) =>
                      updateRow(r.id, { date: e.target.value || null })
                    }
                    className="w-full border border-gray-300 rounded px-2 py-1.5 text-sm font-mono"
                  />
                </label>
                <label className="block">
                  <span className="block text-[10px] uppercase tracking-wide text-gray-500 mb-0.5">
                    Currency
                  </span>
                  <input
                    type="text"
                    value={r.currency ?? ''}
                    onChange={(e) =>
                      updateRow(r.id, {
                        currency: e.target.value.toUpperCase() || null,
                      })
                    }
                    placeholder="CCY"
                    className="w-full border border-gray-300 rounded px-2 py-1.5 text-sm font-mono uppercase"
                    maxLength={4}
                  />
                </label>
                <label className="block">
                  <span className="block text-[10px] uppercase tracking-wide text-gray-500 mb-0.5">
                    Amount
                  </span>
                  <input
                    type="number"
                    step="0.01"
                    inputMode="decimal"
                    value={r.amount ?? ''}
                    onChange={(e) => {
                      const v = e.target.value;
                      updateRow(r.id, {
                        amount: v === '' ? null : Number(v),
                      });
                    }}
                    placeholder="0.00"
                    className="w-full border border-gray-300 rounded px-2 py-1.5 text-sm font-mono text-right"
                  />
                </label>
                <label className="block">
                  <span className="block text-[10px] uppercase tracking-wide text-gray-500 mb-0.5">
                    Value paid
                  </span>
                  <input
                    type="number"
                    step="0.01"
                    inputMode="decimal"
                    value={r.value ?? ''}
                    onChange={(e) => {
                      const v = e.target.value;
                      updateRow(r.id, {
                        value: v === '' ? null : Number(v),
                      });
                    }}
                    placeholder="0.00"
                    className="w-full border border-gray-300 rounded px-2 py-1.5 text-sm font-mono text-right"
                  />
                </label>
              </div>

              <label className="block mb-2">
                <span className="block text-[10px] uppercase tracking-wide text-gray-500 mb-0.5">
                  Item
                </span>
                <input
                  type="text"
                  value={r.item}
                  onChange={(e) => updateRow(r.id, { item: e.target.value })}
                  placeholder="Merchant / item"
                  className="w-full border border-gray-300 rounded px-2 py-1.5 text-sm"
                />
              </label>

              <label className="block mb-2">
                <span className="block text-[10px] uppercase tracking-wide text-gray-500 mb-0.5">
                  Description
                </span>
                <textarea
                  value={r.description}
                  onChange={(e) =>
                    updateRow(r.id, { description: e.target.value })
                  }
                  placeholder="Description"
                  rows={2}
                  className="w-full border border-gray-300 rounded px-2 py-1.5 text-sm resize-y"
                />
              </label>

              <label className="block">
                <span className="block text-[10px] uppercase tracking-wide text-gray-500 mb-0.5">
                  URL / location
                </span>
                <input
                  type="url"
                  value={r.url}
                  onChange={(e) => updateRow(r.id, { url: e.target.value })}
                  placeholder="https://…"
                  inputMode="url"
                  className="w-full border border-gray-300 rounded px-2 py-1.5 text-sm"
                />
              </label>
            </div>
          ))}
          {total.length > 0 && (
            <div className="bg-gray-100 border border-gray-300 rounded-md p-3 flex flex-wrap justify-between items-center gap-2">
              <span className="text-xs uppercase tracking-wide text-gray-500 font-medium">
                Total value{' '}
                {kindFilter === 'all' ? '(shown)' : `(${kindFilter})`}
              </span>
              <span className="font-mono text-sm text-right">
                {total.map((t) => (
                  <span key={t.ccy} className="ml-3">
                    {formatAmount(t.sum, t.ccy || null)}
                  </span>
                ))}
              </span>
            </div>
          )}
        </div>

        <p className="text-xs text-gray-500 mt-3">
          Rows are stored in your Supabase project. Edits save automatically.
          Change a row's kind from the dropdown if the classifier got it wrong.
          <span className="hidden md:inline">
            {' '}
            Hover the description cell to see the full text.
          </span>
        </p>
      </div>

      {hoverDesc && (
        <div
          role="tooltip"
          style={{
            position: 'fixed',
            left: Math.min(hoverDesc.x, window.innerWidth - 460),
            top: hoverDesc.y + 6,
            maxWidth: 440,
            zIndex: 100,
          }}
          className="pointer-events-none bg-gray-900 text-white text-xs rounded-md px-3 py-2 shadow-lg whitespace-pre-wrap break-words"
        >
          {hoverDesc.text}
        </div>
      )}
    </main>
  );
}
