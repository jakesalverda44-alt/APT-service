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

export default function Import() {
  const fileRef = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<ImportResult | null>(null);
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

  return (
    <div className="page">
      <div className="toolbar"><h1>Import from ESC</h1></div>
      <div className="panel" style={{ padding: 16 }}>
        <p style={{ marginTop: 0 }}>
          Upload an ESC <strong>Customer List Report</strong> PDF (run it from ESC's report menu —
          any ZIP range, active customers). Safe to re-upload or overlap reports: existing
          customers are updated by their ESC account number, never duplicated.
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
