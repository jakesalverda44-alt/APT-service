import { useEffect, useState } from 'react';
import { api, fmtDate } from '../api';

interface AgreementRow {
  id: string; esc_agreement_no: string | null; type_code: string | null; plan_name: string | null;
  status: string; original_contract_date: string | null; last_renewal_date: string | null;
  expires_on: string | null; visits_major_remaining: number | null; visits_minor_remaining: number | null;
  customer_name: string; esc_account_no: string | null; location_name: string | null; address1: string | null;
}

export default function Agreements() {
  const [q, setQ] = useState('');
  const [rows, setRows] = useState<AgreementRow[]>([]);

  useEffect(() => {
    const t = setTimeout(() => {
      api<AgreementRow[]>(`/api/agreements?q=${encodeURIComponent(q)}`).then(setRows).catch(() => setRows([]));
    }, 250);
    return () => clearTimeout(t);
  }, [q]);

  return (
    <div className="page">
      <div className="toolbar">
        <h1>Agreement List</h1>
        <input type="search" placeholder="Search customer, agreement #, type…"
               value={q} onChange={(e) => setQ(e.target.value)} />
        <span className="muted">{rows.length} agreements</span>
      </div>
      <div className="panel scroll" style={{ flex: 1 }}>
        <table className="grid">
          <thead>
            <tr>
              <th>Customer</th><th>Agreement #</th><th>Type</th><th>Status</th>
              <th>Original Contract</th><th>Last Renewal</th><th>Expires</th>
              <th>Visits Left</th><th>Location</th><th>Address</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((a) => (
              <tr key={a.id}>
                <td>{a.customer_name} <span className="muted">{a.esc_account_no}</span></td>
                <td>{a.esc_agreement_no || '—'}</td>
                <td><span className="chip gold">{a.type_code || a.plan_name || '—'}</span></td>
                <td><span className={`chip ${a.status}`}>{a.status}</span></td>
                <td>{fmtDate(a.original_contract_date)}</td>
                <td>{fmtDate(a.last_renewal_date)}</td>
                <td>{fmtDate(a.expires_on)}</td>
                <td>
                  {a.visits_major_remaining != null ? `${a.visits_major_remaining} major` : ''}
                  {a.visits_major_remaining != null && a.visits_minor_remaining != null ? ' / ' : ''}
                  {a.visits_minor_remaining != null ? `${a.visits_minor_remaining} minor` : ''}
                  {a.visits_major_remaining == null && a.visits_minor_remaining == null ? '—' : ''}
                </td>
                <td>{a.location_name}</td>
                <td>{a.address1}</td>
              </tr>
            ))}
            {!rows.length && (
              <tr><td colSpan={10}><div className="empty">No agreements yet — they arrive with the ESC agreement import.</div></td></tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
