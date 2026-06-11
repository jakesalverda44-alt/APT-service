import { useEffect, useState } from 'react';
import { api, fmtDate } from '../api';

interface Row {
  customer_id: string;
  customer_name: string;
  esc_account_no: string | null;
  location_id: string | null;
  location_name: string | null;
  address1: string | null;
  city: string | null;
  state: string | null;
  zip: string | null;
}

interface Detail {
  id: string;
  name: string;
  esc_account_no: string | null;
  billing_address1: string | null;
  billing_city: string | null;
  billing_state: string | null;
  billing_zip: string | null;
  phones: Record<string, string>;
  email: string | null;
  notes: string | null;
  locations: {
    id: string; name: string | null; address1: string | null; city: string | null;
    access_notes: string | null; phones: Record<string, string>;
    equipment: { id: string; kind: string; manufacturer: string | null; model: string | null; serial: string | null }[];
  }[];
  agreements: { id: string; type_code: string | null; plan_name: string | null; status: string; expires_on: string | null }[];
  recent_jobs: { id: string; number: number; type: string; status: string; summary: string | null; created_at: string }[];
  recent_invoices: { id: string; number: number; status: string; total: string; balance_due: string; issued_on: string | null }[];
}

const phoneList = (phones: Record<string, string>) =>
  Object.entries(phones || {}).map(([label, num]) => `${num} (${label.replace('_', ' ')})`).join('  ');

export default function CustomerCenter() {
  const [q, setQ] = useState('');
  const [rows, setRows] = useState<Row[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [detail, setDetail] = useState<Detail | null>(null);

  useEffect(() => {
    const t = setTimeout(() => {
      api<Row[]>(`/api/customers?q=${encodeURIComponent(q)}`).then(setRows).catch(() => setRows([]));
    }, 250);
    return () => clearTimeout(t);
  }, [q]);

  useEffect(() => {
    if (!selected) return setDetail(null);
    api<Detail>(`/api/customers/${selected}`).then(setDetail).catch(() => setDetail(null));
  }, [selected]);

  return (
    <div className="page">
      <div className="toolbar">
        <h1>Customer Center</h1>
        <input
          type="search"
          placeholder="Search name, account #, location, address…"
          value={q}
          onChange={(e) => setQ(e.target.value)}
        />
        <span className="muted">{rows.length} rows</span>
      </div>
      <div className="split">
        <div className="master panel scroll">
          <table className="grid">
            <thead>
              <tr><th>Full Name</th><th>Acct #</th><th>Location Name</th><th>Address</th><th>City</th></tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr
                  key={`${r.customer_id}-${r.location_id}`}
                  className={r.customer_id === selected ? 'selected' : ''}
                  onClick={() => setSelected(r.customer_id)}
                >
                  <td>{r.customer_name}</td>
                  <td className="muted">{r.esc_account_no}</td>
                  <td>{r.location_name}</td>
                  <td>{r.address1}</td>
                  <td>{r.city}</td>
                </tr>
              ))}
              {!rows.length && (
                <tr><td colSpan={5}><div className="empty">No customers match.</div></td></tr>
              )}
            </tbody>
          </table>
        </div>
        <div className="detail panel">
          {!detail ? (
            <div className="empty">Select a customer to see details, locations, agreements and history.</div>
          ) : (
            <>
              <h2>{detail.name}</h2>
              <div className="sub">Account {detail.esc_account_no || '—'}</div>
              <div className="kv">
                <span className="k">Billing</span>
                <span>{[detail.billing_address1, detail.billing_city, detail.billing_state, detail.billing_zip].filter(Boolean).join(', ') || '—'}</span>
                <span className="k">Phones</span><span>{phoneList(detail.phones) || '—'}</span>
                <span className="k">Email</span><span>{detail.email || '—'}</span>
              </div>
              {detail.notes && <div className="muted" style={{ marginTop: 8 }}>{detail.notes}</div>}

              <section>
                <h3>Locations ({detail.locations.length})</h3>
                {detail.locations.map((l) => (
                  <div key={l.id} style={{ marginBottom: 8 }}>
                    <strong>{l.name || '—'}</strong>
                    <div className="muted">{[l.address1, l.city].filter(Boolean).join(', ')}</div>
                    {l.access_notes && <div><span className="chip gold">access</span> {l.access_notes}</div>}
                    {l.equipment.length > 0 && (
                      <div className="muted">
                        {l.equipment.map((e) => `${e.kind}: ${[e.manufacturer, e.model, e.serial].filter(Boolean).join(' ')}`).join('; ')}
                      </div>
                    )}
                  </div>
                ))}
              </section>

              <section>
                <h3>Agreements</h3>
                {detail.agreements.length === 0 && <div className="muted">None on file.</div>}
                {detail.agreements.map((a) => (
                  <div key={a.id} style={{ marginBottom: 4 }}>
                    <span className={`chip ${a.status}`}>{a.status}</span>{' '}
                    {a.type_code || a.plan_name || 'Agreement'} — expires {fmtDate(a.expires_on)}
                  </div>
                ))}
              </section>

              <section>
                <h3>Recent Jobs</h3>
                {detail.recent_jobs.length === 0 && <div className="muted">No job history yet.</div>}
                {detail.recent_jobs.map((j) => (
                  <div key={j.id} style={{ marginBottom: 4 }}>
                    <span className={`chip ${j.status}`}>{j.status}</span>{' '}
                    #{j.number} {j.type} — {j.summary || '—'} <span className="muted">{fmtDate(j.created_at)}</span>
                  </div>
                ))}
              </section>

              <section>
                <h3>Recent Invoices</h3>
                {detail.recent_invoices.length === 0 && <div className="muted">No invoices yet.</div>}
                {detail.recent_invoices.map((i) => (
                  <div key={i.id} style={{ marginBottom: 4 }}>
                    <span className={`chip ${i.status === 'paid' ? 'complete' : 'pending'}`}>{i.status}</span>{' '}
                    #{i.number} ${Number(i.total).toLocaleString()} (due ${Number(i.balance_due).toLocaleString()}) {fmtDate(i.issued_on)}
                  </div>
                ))}
              </section>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
