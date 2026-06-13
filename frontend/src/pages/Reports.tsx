import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api, fmtDate } from '../api';

interface Summary {
  ar: { id: string; name: string; esc_account_no: string | null; balance: string;
    current: string | null; over30: string | null; over60: string | null; over90: string | null }[];
  ar_totals: { history_open: string; app_open: string };
  renewals: { id: string; plan_name: string | null; type_code: string | null; expires_on: string;
    price: string | null; customer_name: string; customer_phones: Record<string, string> | null }[];
  renewal_counts: { d30: string; d60: string; d90: string };
  pm_due: { task: string; kind: string; next_due_on: string; plan_name: string | null;
    type_code: string | null; customer_name: string; location_name: string | null }[];
  techs_30d: { tech: string; visits: string; completed: string }[];
  job_status: { status: string; count: string }[];
}

const money = (v: unknown) => `$${Number(v || 0).toLocaleString(undefined, { minimumFractionDigits: 2 })}`;

export default function Reports() {
  const [data, setData] = useState<Summary | null>(null);
  const navigate = useNavigate();
  useEffect(() => { api<Summary>('/api/reports/summary').then(setData).catch(() => setData(null)); }, []);

  if (!data) return <div className="page"><div className="panel empty">Loading reports…</div></div>;
  const arTotal = Number(data.ar_totals.history_open) + Number(data.ar_totals.app_open);

  return (
    <div className="page" style={{ overflowY: 'auto', display: 'block' }}>
      <div className="toolbar"><h1>Reports</h1>
        <span className="muted">Live from the database — print any section with Ctrl+P.</span>
      </div>

      <div className="report-grid">
        <div className="panel" style={{ padding: 14 }}>
          <h3 style={{ marginTop: 0 }}>Receivables — total open {money(arTotal)}</h3>
          <table className="grid">
            <thead><tr><th>Customer</th><th>Balance</th><th>Current</th><th>30+</th><th>60+</th><th>90+</th></tr></thead>
            <tbody>
              {data.ar.map((r) => (
                <tr key={r.id}>
                  <td>{r.name} <span className="muted">{r.esc_account_no}</span></td>
                  <td><strong>{money(r.balance)}</strong></td>
                  <td>{money(r.current)}</td><td>{money(r.over30)}</td>
                  <td>{money(r.over60)}</td><td>{money(r.over90)}</td>
                </tr>
              ))}
              {!data.ar.length && <tr><td colSpan={6} className="muted">Nothing open.</td></tr>}
            </tbody>
          </table>
        </div>

        <div className="panel" style={{ padding: 14 }}>
          <h3 style={{ marginTop: 0 }}>
            Agreement renewals — {data.renewal_counts.d30} due in 30d · {data.renewal_counts.d60} in 60d · {data.renewal_counts.d90} in 90d{' '}
            <button className="ghost" style={{ marginLeft: 8 }} onClick={() => navigate('/agreements')}>Work the list →</button>
          </h3>
          <table className="grid">
            <thead><tr><th>Customer</th><th>Plan</th><th>Expires</th><th>Price</th><th>Phone</th></tr></thead>
            <tbody>
              {data.renewals.map((r) => (
                <tr key={r.id}>
                  <td>{r.customer_name}</td>
                  <td><span className="chip gold">{r.plan_name || r.type_code || '—'}</span></td>
                  <td>{fmtDate(r.expires_on)}</td>
                  <td>{r.price ? money(r.price) : '—'}</td>
                  <td>{Object.values(r.customer_phones || {})[0] || '—'}</td>
                </tr>
              ))}
              {!data.renewals.length && <tr><td colSpan={5} className="muted">Nothing expiring in 90 days.</td></tr>}
            </tbody>
          </table>
        </div>

        <div className="panel" style={{ padding: 14 }}>
          <h3 style={{ marginTop: 0 }}>PM visits due in 30 days ({data.pm_due.length})</h3>
          <table className="grid">
            <thead><tr><th>Due</th><th>Customer</th><th>Location</th><th>Plan</th><th>Visit</th></tr></thead>
            <tbody>
              {data.pm_due.map((p, i) => (
                <tr key={i}>
                  <td>{fmtDate(p.next_due_on)}</td>
                  <td>{p.customer_name}</td>
                  <td>{p.location_name || '—'}</td>
                  <td>{p.plan_name || p.type_code || '—'}</td>
                  <td><span className={`chip ${p.kind === 'major' ? 'gold' : 'outline'}`}>{p.kind}</span> {p.task}</td>
                </tr>
              ))}
              {!data.pm_due.length && <tr><td colSpan={5} className="muted">Nothing due — the PM scheduler is ahead of it.</td></tr>}
            </tbody>
          </table>
        </div>

        <div className="panel" style={{ padding: 14 }}>
          <h3 style={{ marginTop: 0 }}>Technicians — last 30 days</h3>
          <table className="grid">
            <thead><tr><th>Tech</th><th>Visits</th><th>Completed</th></tr></thead>
            <tbody>
              {data.techs_30d.map((t) => (
                <tr key={t.tech}><td>{t.tech}</td><td>{t.visits}</td><td>{t.completed}</td></tr>
              ))}
              {!data.techs_30d.length && <tr><td colSpan={3} className="muted">No dispatches in the last 30 days yet.</td></tr>}
            </tbody>
          </table>
          <h3>Jobs by status</h3>
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
            {data.job_status.map((s) => (
              <span key={s.status} className={`chip ${s.status}`}>{s.status}: {s.count}</span>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
