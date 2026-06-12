import { useCallback, useEffect, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { api, fmtDate } from '../api';

interface QuoteRow {
  id: string; number: number; status: string; summary: string | null;
  valid_until: string | null; created_at: string; total: string;
  customer_name: string; location_name: string | null;
}
interface QuoteDetail extends QuoteRow {
  tax: string; notes: string | null; job_number: number | null;
  esc_account_no: string | null;
  billing_address1: string | null; billing_city: string | null; billing_state: string | null; billing_zip: string | null;
  location_address: string | null; location_city: string | null;
  lines: { id: string; kind: string; description: string; qty: string; unit_price: string }[];
}
interface CustomerHit { customer_id: string; customer_name: string; esc_account_no: string | null; location_id: string | null; location_name: string | null }

const money = (v: string | number) => `$${Number(v).toLocaleString(undefined, { minimumFractionDigits: 2 })}`;

export default function Quotes() {
  const [params, setParams] = useSearchParams();
  const [q, setQ] = useState('');
  const [status, setStatus] = useState('');
  const [rows, setRows] = useState<QuoteRow[]>([]);
  const [selected, setSelected] = useState<string | null>(params.get('open'));
  const [detail, setDetail] = useState<QuoteDetail | null>(null);
  const [creating, setCreating] = useState(false);
  const [custQuery, setCustQuery] = useState('');
  const [custHits, setCustHits] = useState<CustomerHit[]>([]);
  const navigate = useNavigate();

  const load = useCallback(() => {
    const p = new URLSearchParams();
    if (q) p.set('q', q);
    if (status) p.set('status', status);
    api<QuoteRow[]>(`/api/quotes?${p}`).then(setRows).catch(() => setRows([]));
  }, [q, status]);
  useEffect(() => { const t = setTimeout(load, 250); return () => clearTimeout(t); }, [load]);

  const loadDetail = useCallback(() => {
    if (!selected) return setDetail(null);
    api<QuoteDetail>(`/api/quotes/${selected}`).then(setDetail).catch(() => setDetail(null));
  }, [selected]);
  useEffect(loadDetail, [loadDetail]);

  useEffect(() => {
    if (!creating || custQuery.length < 2) return setCustHits([]);
    const t = setTimeout(() => {
      api<{ rows: CustomerHit[] }>(`/api/customers?q=${encodeURIComponent(custQuery)}&limit=8&status=all`)
        .then((d) => setCustHits(d.rows)).catch(() => setCustHits([]));
    }, 250);
    return () => clearTimeout(t);
  }, [creating, custQuery]);

  function select(id: string) { setSelected(id); setParams(id ? { open: id } : {}); }

  async function createQuote(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    const hit = custHits.find((c) => c.customer_id === f.get('customer'));
    if (!hit) return;
    const created = await api<QuoteDetail>('/api/quotes', {
      method: 'POST',
      body: JSON.stringify({
        customer_id: hit.customer_id, location_id: hit.location_id,
        summary: f.get('summary'), valid_until: f.get('valid_until') || null,
      }),
    });
    setCreating(false);
    select(created.id);
    load();
  }

  async function addLine(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!detail) return;
    const f = new FormData(e.currentTarget);
    await api(`/api/quotes/${detail.id}/lines`, {
      method: 'POST',
      body: JSON.stringify({
        kind: f.get('kind'), description: f.get('description'),
        qty: Number(f.get('qty')) || 1, unit_price: Number(f.get('unit_price')) || 0,
      }),
    });
    e.currentTarget?.reset?.();
    loadDetail(); load();
  }

  async function removeLine(lineId: string) {
    await api(`/api/quotes/lines/${lineId}`, { method: 'DELETE' });
    loadDetail(); load();
  }

  async function patch(body: Record<string, unknown>) {
    if (!detail) return;
    await api(`/api/quotes/${detail.id}`, { method: 'PATCH', body: JSON.stringify(body) });
    loadDetail(); load();
  }

  async function accept() {
    if (!detail) return;
    await api(`/api/quotes/${detail.id}/accept`, { method: 'POST', body: '{}' });
    navigate('/board');
  }

  const editable = detail && (detail.status === 'pending' || detail.status === 'sent');
  const subtotal = detail ? detail.lines.reduce((s, l) => s + Number(l.qty) * Number(l.unit_price), 0) : 0;

  return (
    <div className="page">
      <div className="toolbar no-print">
        <h1>Quotes</h1>
        <input type="search" placeholder="Search customer, quote #, summary…" value={q} onChange={(e) => setQ(e.target.value)} />
        <select value={status} onChange={(e) => setStatus(e.target.value)}>
          <option value="">All statuses</option>
          {['pending', 'sent', 'accepted', 'declined', 'expired'].map((s) => <option key={s}>{s}</option>)}
        </select>
        <button className="primary" onClick={() => setCreating(true)}>New Quote</button>
        <span className="muted">{rows.length} quotes</span>
      </div>
      <div className="split">
        <div className="master panel scroll no-print">
          <table className="grid">
            <thead>
              <tr><th>Quote #</th><th>Status</th><th>Customer</th><th>Summary</th><th>Total</th><th>Valid Until</th><th>Created</th></tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id} className={r.id === selected ? 'selected' : ''} onClick={() => select(r.id)}>
                  <td>{r.number}</td>
                  <td><span className={`chip ${r.status === 'accepted' ? 'complete' : r.status === 'declined' || r.status === 'expired' ? 'cancelled' : 'pending'}`}>{r.status}</span></td>
                  <td>{r.customer_name}</td>
                  <td>{r.summary}</td>
                  <td>{money(r.total)}</td>
                  <td>{fmtDate(r.valid_until)}</td>
                  <td>{fmtDate(r.created_at)}</td>
                </tr>
              ))}
              {!rows.length && <tr><td colSpan={7}><div className="empty">No quotes yet.</div></td></tr>}
            </tbody>
          </table>
        </div>
        <div className="detail panel print-area">
          {!detail ? (
            <div className="empty">Select a quote, or create one for a repair.</div>
          ) : (
            <>
              <div className="invoice-head">
                <div>
                  <h2>Quote #{detail.number}</h2>
                  <div className="sub">Accurate Power &amp; Technology — Service</div>
                </div>
                <span className={`chip ${detail.status === 'accepted' ? 'complete' : 'pending'}`}>{detail.status}</span>
              </div>
              <div className="kv">
                <span className="k">Customer</span>
                <span>{detail.customer_name}<br />
                  {[detail.billing_address1, detail.billing_city, detail.billing_state, detail.billing_zip].filter(Boolean).join(', ')}</span>
                <span className="k">Service At</span>
                <span>{detail.location_name || '—'}<br />{[detail.location_address, detail.location_city].filter(Boolean).join(', ')}</span>
                <span className="k">Summary</span><span>{detail.summary || '—'}</span>
                <span className="k">Valid until</span><span>{fmtDate(detail.valid_until)}</span>
                {detail.job_number && (<><span className="k">Job</span><span>#{detail.job_number}</span></>)}
              </div>

              <section>
                <h3>Quoted work</h3>
                {detail.lines.map((l) => (
                  <div key={l.id} style={{ display: 'flex', gap: 6, marginBottom: 3 }}>
                    <span className="chip outline">{l.kind}</span>
                    <span style={{ flex: 1 }}>{l.description}</span>
                    <span className="muted">{Number(l.qty)} × {money(l.unit_price)}</span>
                    <strong>{money(Number(l.qty) * Number(l.unit_price))}</strong>
                    {editable && <button className="ghost no-print" style={{ padding: '0 6px' }} onClick={() => removeLine(l.id)}>×</button>}
                  </div>
                ))}
                <div className="totals">
                  <div><span>Subtotal</span><span>{money(subtotal)}</span></div>
                  <div>
                    <span>Tax</span>
                    <span className="no-print">
                      <input type="number" step="0.01" defaultValue={Number(detail.tax)} style={{ width: 90 }}
                             onBlur={(e) => Number(e.target.value) !== Number(detail.tax) && patch({ tax: Number(e.target.value) })} />
                    </span>
                    <span className="print-only">{money(detail.tax)}</span>
                  </div>
                  <div className="grand"><span>Total</span><span>{money(subtotal + Number(detail.tax))}</span></div>
                </div>
                {editable && (
                  <form onSubmit={addLine} className="no-print" style={{ display: 'flex', gap: 4, marginTop: 6 }}>
                    <select name="kind" style={{ width: 80 }}>
                      <option value="labor">labor</option>
                      <option value="part">part</option>
                      <option value="flat">flat</option>
                    </select>
                    <input name="description" placeholder="Description" required style={{ flex: 1 }} />
                    <input name="qty" type="number" step="0.25" defaultValue={1} style={{ width: 60 }} />
                    <input name="unit_price" type="number" step="0.01" placeholder="$" style={{ width: 80 }} />
                    <button className="ghost">Add</button>
                  </form>
                )}
              </section>

              <div className="no-print" style={{ marginTop: 12, display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                {detail.status === 'pending' && <button className="ghost" onClick={() => patch({ status: 'sent' })}>Mark Sent</button>}
                {editable && <button className="primary" onClick={accept}>Accept → Job</button>}
                {editable && <button className="ghost" onClick={() => patch({ status: 'declined' })}>Declined</button>}
                <button className="ghost" onClick={() => window.print()}>Print</button>
              </div>
            </>
          )}
        </div>
      </div>

      {creating && (
        <dialog className="modal" open>
          <h2>New Quote</h2>
          <form onSubmit={createQuote}>
            <input placeholder="Search customer…" value={custQuery} onChange={(e) => setCustQuery(e.target.value)} />
            <select name="customer" required size={Math.min(custHits.length || 1, 5)}>
              {custHits.map((c) => (
                <option key={`${c.customer_id}-${c.location_id}`} value={c.customer_id}>
                  {c.customer_name} {c.esc_account_no ? `(${c.esc_account_no})` : ''} — {c.location_name || 'no location'}
                </option>
              ))}
            </select>
            <textarea name="summary" placeholder="What needs repair?" rows={3} required />
            <label className="muted">Valid until<input name="valid_until" type="date" /></label>
            <div className="actions">
              <button type="button" className="ghost" onClick={() => setCreating(false)}>Cancel</button>
              <button className="primary">Create</button>
            </div>
          </form>
        </dialog>
      )}
    </div>
  );
}
