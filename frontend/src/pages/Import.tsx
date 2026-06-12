import { useEffect, useRef, useState } from 'react';
import { api, auth, fmtDate } from '../api';

interface ImportResult {
  batch_id: string;
  filters: string[];
  warnings: string[];
  results: { kind: string; imported: number; errored: number }[];
  errors: { row_kind: string; name: string | null; error: string }[];
}
interface Batch {
  id: string; source: string; filename: string | null; filters: string | null;
  stats: Record<string, unknown>; created_at: string;
}

interface CsvOutcome { table: string; imported: number; errors: { row: number; key: string; error: string }[] }

// Dependency order for the SQL export — files are sorted this way before upload.
const CSV_ORDER = ['customers', 'locations', 'agreements', 'recurrence', 'tasks', 'equipment'];
const orderOf = (name: string) => {
  const i = CSV_ORDER.findIndex((k) => name.toLowerCase().includes(k));
  return i === -1 ? CSV_ORDER.length : i;
};

export default function Import() {
  const fileRef = useRef<HTMLInputElement>(null);
  const csvRef = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [csvBusy, setCsvBusy] = useState(false);
  const [result, setResult] = useState<ImportResult | null>(null);
  const [csvResults, setCsvResults] = useState<{ file: string; outcome?: CsvOutcome; error?: string }[]>([]);
  const [error, setError] = useState('');
  const [batches, setBatches] = useState<Batch[]>([]);

  const loadBatches = () => api<Batch[]>('/api/import/batches').then(setBatches).catch(() => setBatches([]));
  useEffect(() => { loadBatches(); }, []);

  async function upload() {
    const file = fileRef.current?.files?.[0];
    if (!file) return setError('Choose the ESC Customer List Report PDF first.');
    setBusy(true);
    setError('');
    setResult(null);
    try {
      const res = await fetch(`/api/import/esc-customers?filename=${encodeURIComponent(file.name)}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/pdf',
          Authorization: `Bearer ${auth.token}`,
        },
        body: file,
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error || 'Import failed');
      setResult(body as ImportResult);
      loadBatches();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Import failed');
    } finally {
      setBusy(false);
    }
  }

  async function uploadCsvs() {
    const files = Array.from(csvRef.current?.files || []);
    if (!files.length) return setError('Choose the ESC export CSV files first.');
    setCsvBusy(true);
    setError('');
    setCsvResults([]);
    const sorted = files.sort((a, b) => orderOf(a.name) - orderOf(b.name));
    const results: { file: string; outcome?: CsvOutcome; error?: string }[] = [];
    for (const file of sorted) {
      try {
        const res = await fetch(`/api/import/esc-csv?filename=${encodeURIComponent(file.name)}`, {
          method: 'POST',
          headers: { 'Content-Type': 'text/csv', Authorization: `Bearer ${auth.token}` },
          body: file,
        });
        const body = await res.json();
        if (!res.ok) throw new Error(body.error || 'Import failed');
        results.push({ file: file.name, outcome: body as CsvOutcome });
      } catch (err) {
        results.push({ file: file.name, error: err instanceof Error ? err.message : 'failed' });
      }
      setCsvResults([...results]);
    }
    setCsvBusy(false);
    loadBatches();
  }

  return (
    <div className="page">
      <div className="toolbar"><h1>Import from ESC</h1></div>

      <div className="panel" style={{ padding: 16 }}>
        <h3 style={{ margin: '0 0 6px' }}>ESC database export (CSV files)</h3>
        <p style={{ marginTop: 0 }}>
          Select the CSV files from the full ESC export (customers, locations, agreements,
          agreement_recurrence, agreement_tasks, equipment). The file type is detected
          automatically and uploads run in the right order. Safe to re-upload — records
          update by their ESC numbers, never duplicate.
        </p>
        <div className="toolbar">
          <input type="file" accept=".csv,text/csv" multiple ref={csvRef} />
          <button className="primary" disabled={csvBusy} onClick={uploadCsvs}>
            {csvBusy ? 'Importing…' : 'Upload & Import All'}
          </button>
        </div>
        {csvResults.length > 0 && (
          <div style={{ marginTop: 10 }}>
            {csvResults.map((r) => (
              <div key={r.file} style={{ marginBottom: 4 }}>
                {r.error ? (
                  <span className="error">{r.file}: {r.error}</span>
                ) : (
                  <>
                    <span className={`chip ${r.outcome!.errors.length ? 'pending' : 'complete'}`}>
                      {r.outcome!.table.replace('esc_', '')}: {r.outcome!.imported} imported
                      {r.outcome!.errors.length ? `, ${r.outcome!.errors.length}+ issues` : ''}
                    </span>{' '}
                    <span className="muted">{r.file}</span>
                    {r.outcome!.errors.slice(0, 3).map((e, i) => (
                      <div key={i} className="error" style={{ fontSize: 12 }}>
                        row {e.row} ({e.key}): {e.error}
                      </div>
                    ))}
                  </>
                )}
              </div>
            ))}
          </div>
        )}
      </div>

      <div className="panel" style={{ padding: 16 }}>
        <h3 style={{ margin: '0 0 6px' }}>Customer List Report (PDF)</h3>
        <p style={{ marginTop: 0 }}>
          Alternative path: upload an ESC <strong>Customer List Report</strong> PDF. Safe to
          re-upload or overlap reports: existing customers are updated by their ESC account
          number, never duplicated.
        </p>
        <div className="toolbar">
          <input type="file" accept="application/pdf,.pdf" ref={fileRef} />
          <button className="primary" disabled={busy} onClick={upload}>
            {busy ? 'Importing…' : 'Upload & Import'}
          </button>
        </div>
        {error && <div className="error" style={{ marginTop: 10 }}>{error}</div>}
        {result && (
          <div style={{ marginTop: 12 }}>
            {result.results.map((r) => (
              <div key={r.kind}>
                <span className={`chip ${r.errored ? 'pending' : 'complete'}`}>
                  {r.kind}s: {r.imported} imported{r.errored ? `, ${r.errored} errors` : ''}
                </span>
              </div>
            ))}
            {result.filters.length > 0 && (
              <div className="muted" style={{ marginTop: 6 }}>Report filters: {result.filters.join('; ')}</div>
            )}
            {result.errors.length > 0 && (
              <div style={{ marginTop: 6 }}>
                {result.errors.map((e, i) => (
                  <div key={i} className="error">{e.row_kind} "{e.name}": {e.error}</div>
                ))}
              </div>
            )}
          </div>
        )}
      </div>

      <div className="panel scroll" style={{ flex: 1 }}>
        <table className="grid">
          <thead><tr><th>Date</th><th>File</th><th>Report filters</th><th>Stats</th></tr></thead>
          <tbody>
            {batches.map((b) => (
              <tr key={b.id}>
                <td>{fmtDate(b.created_at)}</td>
                <td>{b.filename}</td>
                <td className="muted">{b.filters || '—'}</td>
                <td className="muted">
                  {['customers_imported', 'locations_imported'].map((k) =>
                    b.stats?.[k] != null ? `${String(b.stats[k])} ${k.replace('_imported', 's')} ` : ''
                  )}
                </td>
              </tr>
            ))}
            {!batches.length && <tr><td colSpan={4}><div className="empty">No imports yet.</div></td></tr>}
          </tbody>
        </table>
      </div>
    </div>
  );
}
