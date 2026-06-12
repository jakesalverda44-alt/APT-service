import { useCallback, useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { api, fmtDate } from '../api';

interface InvoiceRow {
  id: string; number: number; status: string; total: string; balance_due: string;
  issued_on: string | null; due_on: string | null; terms: string | null;
  customer_name: string; location_name: string | null; job_number: number | null;
}
interface InvoiceDetail extends InvoiceRow {
  subtotal: string; tax: string; customer_po: string | null;
  esc_account_no: string | null;
  billing_address1: string | null; billing_city: string | null; billing_state: string | null; billing_zip: string | null;
  location_address: string | null; location_city: string | null; location_state: string | null; location_zip: string | null;
  job_summary: string | null;
  lines: { id: string; kind: string; description: string; qty: string; unit_price: string }[];
  payments: { id: string; method: string; amount: string; reference: string | null; received_on: string }[];
}

export default function Invoices() {
  const [params, setParams] = useSearchParams();
  const [q, setQ] = useState('');
  const [status, setStatus] = useState('');
  const [rows, setRows] = useState<InvoiceRow[]>([]);
  const [selected, setSelected] = useState<string | null>(params.get('open'));
  const [detail, setDetail] = useState<InvoiceDetail | null>(null);

  const load = useCallback(() => {
    const p = new URLSearchParams();
    if (q) p.set('q', q);
    if (status) p.set('status', status);
    api<InvoiceRow[]>(`/api/invoices?${p}`).then(setRows).catch(() => setRows([]));
  }, [q, status]);
  useEffect(() => { const t = setTimeout(load, 250); return () => clearTimeout(t); }, [load]);

  const loadDetail = useCallback(() => {
    if (!selected) return setDetail(null);
    api<InvoiceDetail>(`/api/invoices/${selected}`).then(setDetail).catch(() => setDetail(null));
  }, [selected]);
  useEffect(loadDetail, [loadDetail]);

  async function patch(body: Record<string, unknown>) {
    if (!detail) return;
    await api(`/api/invoices/${detail.id}`, { method: 'PATCH', body: JSON.stringify(body) });
    loadDetail(); load();
  }

  async function recordPayment(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!detail) return;
    const f = new FormData(e.currentTarget);
    await api(`/api/invoices/${detail.id}/payments`, {
      method: 'POST',
      body: JSON.stringify({
        method: f.get('method'), amount: Number(f.get('amount')), reference: f.get('reference') || null,
      }),
    });
    loadDetail(); load();
  }

  function select(id: string) {
    setSelected(id);
    setParams(id ? { open: id } : {});
  }

  const money = (v: string | number) => `$${Number(v).toLocaleString(undefined, { minimumFractionDigits: 2 })}`;

  return (
    <div className="page">
      <div className="toolbar no-print">
        <h1>Invoices</h1>
        <input type="search" placeholder="Search customer or invoice #…" value={q} onChange={(e) => setQ(e.target.value)} />
        <select value={status} onChange={(e) => setStatus(e.target.value)}>
          <option value="">All statuses</option>
          {['draft', 'sent', 'partial', 'paid', 'void'].map((s) => <option key={s} value={s}>{s}</option>)}
        </select>
        <span className="muted">{rows.length} invoices</span>
      </div>
      <div className="split">
        <div className="master panel scroll no-print">
          <table className="grid">
            <thead>
              <tr><th>Invoice #</th><th>Status</th><th>Customer</th><th>Job</th><th>Total</th><th>Balance</th><th>Issued</th><th>Terms</th></tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id} className={r.id === selected ? 'selected' : ''} onClick={() => select(r.id)}>
                  <td>{r.number}</td>
                  <td><span className={`chip ${r.status === 'paid' ? 'complete' : r.status === 'void' ? 'cancelled' : 'pending'}`}>{r.status}</span></td>
                  <td>{r.customer_name}</td>
                  <td>{r.job_number ? `#${r.job_number}` : '—'}</td>
                  <td>{money(r.total)}</td>
                  <td>{money(r.balance_due)}</td>
                  <td>{fmtDate(r.issued_on)}</td>
                  <td className="muted">{r.terms}</td>
                </tr>
              ))}
              {!rows.length && <tr><td colSpan={8}><div className="empty">No invoices yet — create one from a completed job.</div></td></tr>}
            </tbody>
          </table>
        </div>
        <div className="detail panel print-area">
          {!detail ? (
            <div className="empty">Select an invoice.</div>
          ) : (
            <>
              <div className="invoice-head">
                <div>
                  <h2>Invoice #{detail.number}</h2>
                  <div className="sub">Accurate Power &amp; Technology — Service</div>
                </div>
                <span className={`chip ${detail.status === 'paid' ? 'complete' : 'pending'}`}>{detail.status}</span>
              </div>
              <div className="kv">
                <span className="k">Bill To</span>
                <span>{detail.customer_name}<br />
                  {[detail.billing_address1, detail.billing_city, detail.billing_state, detail.billing_zip].filter(Boolean).join(', ')}</span>
                <span className="k">Service At</span>
                <span>{detail.location_name || '—'}<br />
                  {[detail.location_address, detail.location_city, detail.location_state, detail.location_zip].filter(Boolean).join(', ')}</span>
                <span className="k">Job</span><span>{detail.job_number ? `#${detail.job_number} — ${detail.job_summary || ''}` : '—'}</span>
                <span className="k">Issued</span><span>{fmtDate(detail.issued_on)}</span>
                <span className="k">Terms</span><span>{detail.terms || '—'}</span>
              </div>

              <section>
                <h3>Lines</h3>
                {detail.lines.map((l) => (
                  <div key={l.id} style={{ display: 'flex', gap: 6, marginBottom: 3 }}>
                    <span className="chip outline">{l.kind}</span>
                    <span style={{ flex: 1 }}>{l.description}</span>
                    <span className="muted">{Number(l.qty)} × {money(l.unit_price)}</span>
                    <strong>{money(Number(l.qty) * Number(l.unit_price))}</strong>
                  </div>
                ))}
                <div className="totals">
                  <div><span>Subtotal</span><span>{money(detail.subtotal)}</span></div>
                  <div>
                    <span>Tax</span>
                    <span className="no-print">
                      <input type="number" step="0.01" defaultValue={Number(detail.tax)} style={{ width: 90 }}
                             onBlur={(e) => Number(e.target.value) !== Number(detail.tax) && patch({ tax: Number(e.target.value) })} />
                    </span>
                    <span className="print-only">{money(detail.tax)}</span>
                  </div>
                  <div className="grand"><span>Total</span><span>{money(detail.total)}</span></div>
                  <div><span>Balance Due</span><span>{money(detail.balance_due)}</span></div>
                </div>
              </section>

              <section>
                <h3>Payments</h3>
                {detail.payments.map((p) => (
                  <div key={p.id}>{fmtDate(p.received_on)} — {p.method} {money(p.amount)} {p.reference ? `(${p.reference})` : ''}</div>
                ))}
                {detail.status !== 'paid' && detail.status !== 'void' && (
                  <form onSubmit={recordPayment} className="no-print" style={{ display: 'flex', gap: 4, marginTop: 6 }}>
                    <select name="method" style={{ width: 90 }}>
                      {['check', 'card', 'cash', 'ach', 'other'].map((m) => <option key={m}>{m}</option>)}
                    </select>
                    <input name="amount" type="number" step="0.01" placeholder="Amount" required style={{ width: 100 }} />
                    <input name="reference" placeholder="Check # / ref" style={{ flex: 1 }} />
                    <button className="primary">Record</button>
                  </form>
                )}
              </section>

              <div className="no-print" style={{ marginTop: 12, display: 'flex', gap: 6 }}>
                {detail.status === 'draft' && <button className="primary" onClick={() => patch({ status: 'sent' })}>Mark Sent</button>}
                <button className="ghost" onClick={() => window.print()}>Print</button>
                {detail.status !== 'void' && <button className="ghost" onClick={() => confirm('Void this invoice?') && patch({ status: 'void' })}>Void</button>}
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
