import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api, fmtDate, fmtTime } from '../api';
import LineForm from '../components/LineForm';

interface JobRow {
  id: string; number: number; type: string; priority: string; status: string;
  summary: string | null; created_at: string; next_visit: string | null;
  customer_name: string | null; location_name: string | null; city: string | null;
}
interface JobLine { id: string; kind: string; description: string; qty: string; unit_price: string }
interface JobDetail extends JobRow {
  address1: string | null; state: string | null; zip: string | null; access_notes: string | null;
  notes: { id: string; author_name: string | null; body: string; created_at: string }[];
  dispatches: { id: string; tech_name: string | null; scheduled_start: string | null; status: string }[];
  lines: JobLine[];
}

export default function Jobs() {
  const [q, setQ] = useState('');
  const [status, setStatus] = useState('');
  const [rows, setRows] = useState<JobRow[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [detail, setDetail] = useState<JobDetail | null>(null);
  const [note, setNote] = useState('');

  function load() {
    const params = new URLSearchParams();
    if (q) params.set('q', q);
    if (status) params.set('status', status);
    api<JobRow[]>(`/api/jobs?${params}`).then(setRows).catch(() => setRows([]));
  }
  useEffect(() => {
    const t = setTimeout(load, 250);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [q, status]);

  useEffect(() => {
    if (!selected) return setDetail(null);
    api<JobDetail>(`/api/jobs/${selected}`).then(setDetail).catch(() => setDetail(null));
  }, [selected]);

  const navigate = useNavigate();
  const refreshDetail = () => detail && api<JobDetail>(`/api/jobs/${detail.id}`).then(setDetail);

  async function addNote(e: React.FormEvent) {
    e.preventDefault();
    if (!detail || !note.trim()) return;
    await api(`/api/jobs/${detail.id}/notes`, { method: 'POST', body: JSON.stringify({ body: note }) });
    setNote('');
    refreshDetail();
  }

  async function addLine(line: { kind: string; description: string; qty: number; unit_price: number }) {
    if (!detail) return;
    await api(`/api/jobs/${detail.id}/lines`, { method: 'POST', body: JSON.stringify(line) });
    refreshDetail();
  }

  async function removeLine(lineId: string) {
    await api(`/api/jobs/lines/${lineId}`, { method: 'DELETE' });
    refreshDetail();
  }

  async function markComplete() {
    if (!detail) return;
    await api(`/api/jobs/${detail.id}`, { method: 'PATCH', body: JSON.stringify({ status: 'complete' }) });
    refreshDetail(); load();
  }

  async function createInvoice() {
    if (!detail) return;
    const inv = await api<{ id: string }>(`/api/invoices/from-job/${detail.id}`, { method: 'POST', body: '{}' });
    navigate(`/invoices?open=${inv.id}`);
  }

  return (
    <div className="page">
      <div className="toolbar">
        <h1>Jobs</h1>
        <input type="search" placeholder="Search customer, location, summary, job #…"
               value={q} onChange={(e) => setQ(e.target.value)} />
        <select value={status} onChange={(e) => setStatus(e.target.value)}>
          <option value="">All statuses</option>
          {['intake', 'pending', 'scheduled', 'in_progress', 'complete', 'invoiced', 'cancelled'].map((s) => (
            <option key={s} value={s}>{s}</option>
          ))}
        </select>
        <span className="muted">{rows.length} jobs</span>
      </div>
      <div className="split">
        <div className="master panel scroll">
          <table className="grid">
            <thead>
              <tr><th>Job #</th><th>Status</th><th>Customer</th><th>Location</th><th>Type</th><th>Summary</th><th>Next Visit</th><th>Created</th></tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id} className={r.id === selected ? 'selected' : ''} onClick={() => setSelected(r.id)}>
                  <td>{r.number}</td>
                  <td><span className={`chip ${r.priority === 'emergency' ? 'emergency' : r.status}`}>{r.status}</span></td>
                  <td>{r.customer_name}</td>
                  <td>{r.location_name || r.city}</td>
                  <td>{r.type}</td>
                  <td>{r.summary}</td>
                  <td>{r.next_visit ? `${fmtDate(r.next_visit)} ${fmtTime(r.next_visit)}` : '—'}</td>
                  <td>{fmtDate(r.created_at)}</td>
                </tr>
              ))}
              {!rows.length && <tr><td colSpan={8}><div className="empty">No jobs match.</div></td></tr>}
            </tbody>
          </table>
        </div>
        <div className="detail panel">
          {!detail ? (
            <div className="empty">Select a job to see its timeline and visits.</div>
          ) : (
            <>
              <h2>#{detail.number} — {detail.customer_name}</h2>
              <div className="sub">
                {[detail.location_name, detail.address1, detail.city].filter(Boolean).join(', ')}
              </div>
              <div className="kv">
                <span className="k">Status</span><span><span className={`chip ${detail.status}`}>{detail.status}</span></span>
                <span className="k">Type</span><span>{detail.type}</span>
                <span className="k">Priority</span><span>{detail.priority}</span>
                {detail.access_notes && (<><span className="k">Access</span><span>{detail.access_notes}</span></>)}
              </div>

              <section>
                <h3>Visits</h3>
                {detail.dispatches.length === 0 && <div className="muted">Not scheduled yet.</div>}
                {detail.dispatches.map((d) => (
                  <div key={d.id} style={{ marginBottom: 4 }}>
                    <span className={`chip ${d.status}`}>{d.status}</span>{' '}
                    {d.scheduled_start ? `${fmtDate(d.scheduled_start)} ${fmtTime(d.scheduled_start)}` : 'unscheduled'}
                    {d.tech_name ? ` — ${d.tech_name}` : ''}
                  </div>
                ))}
              </section>

              <div style={{ marginTop: 10, display: 'flex', gap: 6 }}>
                {detail.status !== 'complete' && detail.status !== 'invoiced' && detail.status !== 'cancelled' && (
                  <button className="ghost" onClick={markComplete}>Mark Complete</button>
                )}
                {(detail.status === 'complete' || detail.lines.length > 0) && detail.status !== 'invoiced' && (
                  <button className="primary" onClick={createInvoice}>Create Invoice</button>
                )}
              </div>

              <section>
                <h3>Parts & Labor</h3>
                {detail.lines.map((l) => (
                  <div key={l.id} style={{ display: 'flex', gap: 6, marginBottom: 3, alignItems: 'baseline' }}>
                    <span className="chip outline">{l.kind}</span>
                    <span style={{ flex: 1 }}>{l.description}</span>
                    <span className="muted">{Number(l.qty)} × ${Number(l.unit_price).toFixed(2)}</span>
                    <strong>${(Number(l.qty) * Number(l.unit_price)).toFixed(2)}</strong>
                    {detail.status !== 'invoiced' && (
                      <button className="ghost" style={{ padding: '0 6px' }} onClick={() => removeLine(l.id)}>×</button>
                    )}
                  </div>
                ))}
                {detail.lines.length > 0 && (
                  <div style={{ textAlign: 'right', fontWeight: 600 }}>
                    Subtotal: ${detail.lines.reduce((s, l) => s + Number(l.qty) * Number(l.unit_price), 0).toFixed(2)}
                  </div>
                )}
                {detail.status !== 'invoiced' && <LineForm onAdd={addLine} />}
              </section>

              <section>
                <h3>Notes timeline</h3>
                {detail.notes.map((n) => (
                  <div key={n.id} style={{ marginBottom: 6 }}>
                    <div className="muted" style={{ fontSize: 11 }}>
                      {fmtDate(n.created_at)} {fmtTime(n.created_at)} — {n.author_name || 'system'}
                    </div>
                    <div>{n.body}</div>
                  </div>
                ))}
                <form onSubmit={addNote} style={{ display: 'flex', gap: 6, marginTop: 8 }}>
                  <input style={{ flex: 1, border: '1px solid var(--border2)', borderRadius: 6, padding: '7px 10px', font: 'inherit' }}
                         placeholder="Add a note (append-only, like ESC)…"
                         value={note} onChange={(e) => setNote(e.target.value)} />
                  <button className="primary">Add</button>
                </form>
              </section>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
