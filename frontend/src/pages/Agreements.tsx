import { useCallback, useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api, fmtDate } from '../api';

interface AgreementRow {
  id: string; esc_agreement_no: string | null; type_code: string | null; plan_name: string | null;
  status: string; price: string | null; original_contract_date: string | null; last_renewal_date: string | null;
  expires_on: string | null; visits_major_remaining: number | null; visits_minor_remaining: number | null;
  customer_name: string; esc_account_no: string | null; customer_phones: Record<string, string> | null;
  location_name: string | null; address1: string | null;
}
interface Task {
  id: string; name: string; kind: string; interval_months: number | null;
  next_due_on: string | null; checklist: string[];
}
interface AgreementDetail extends AgreementRow {
  customer_id: string; price: string | null; billing_freq: string | null; notes: string | null;
  visits_major_total: number | null; visits_minor_total: number | null;
  tasks: Task[];
  jobs: { id: string; number: number; status: string; summary: string | null; created_at: string }[];
}
interface CustomerHit { customer_id: string; customer_name: string; esc_account_no: string | null; location_id: string | null; location_name: string | null }

const MAJOR_CHECKLIST = [
  'Change Engine Oil', 'Replace Engine Oil Filter', 'Replace Air Filter (If Needed)',
  'Check Spark Plugs; clean, regap, or replace', 'Perform 5-min NO LOAD TEST',
];

export default function Agreements() {
  const [q, setQ] = useState('');
  const [view, setView] = useState('all');
  const [rows, setRows] = useState<AgreementRow[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [detail, setDetail] = useState<AgreementDetail | null>(null);
  const [creating, setCreating] = useState(false);
  const [renewing, setRenewing] = useState(false);
  const [custQuery, setCustQuery] = useState('');
  const [custHits, setCustHits] = useState<CustomerHit[]>([]);
  const [pmMsg, setPmMsg] = useState('');
  const navigate = useNavigate();

  const load = useCallback(() => {
    api<AgreementRow[]>(`/api/agreements?q=${encodeURIComponent(q)}&view=${view}`).then(setRows).catch(() => setRows([]));
  }, [q, view]);
  useEffect(() => { const t = setTimeout(load, 250); return () => clearTimeout(t); }, [load]);

  const loadDetail = useCallback(() => {
    if (!selected) return setDetail(null);
    api<AgreementDetail>(`/api/agreements/${selected}`).then(setDetail).catch(() => setDetail(null));
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

  async function createAgreement(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    const customer = custHits.find((c) => c.customer_id === f.get('customer'));
    if (!customer) return;
    const visitsMajor = Number(f.get('visits_major')) || null;
    const visitsMinor = Number(f.get('visits_minor')) || null;
    const created = await api<AgreementDetail>('/api/agreements', {
      method: 'POST',
      body: JSON.stringify({
        customer_id: customer.customer_id,
        location_id: customer.location_id,
        type_code: f.get('type_code') || null,
        plan_name: f.get('plan_name') || null,
        billing_freq: f.get('billing_freq') || null,
        price: Number(f.get('price')) || null,
        original_contract_date: f.get('start') || null,
        expires_on: f.get('expires') || null,
        visits_major_total: visitsMajor,
        visits_minor_total: visitsMinor,
      }),
    });
    // Seed the standard tasks so PM jobs start generating.
    if (visitsMajor) {
      await api(`/api/agreements/${created.id}/tasks`, {
        method: 'POST',
        body: JSON.stringify({
          name: 'Major service', kind: 'major', interval_months: 12,
          next_due_on: f.get('first_due') || f.get('start'), checklist: MAJOR_CHECKLIST,
        }),
      });
    }
    if (visitsMinor) {
      await api(`/api/agreements/${created.id}/tasks`, {
        method: 'POST',
        body: JSON.stringify({
          name: 'Minor inspection', kind: 'minor', interval_months: 6,
          next_due_on: f.get('first_due') || f.get('start'),
          checklist: ['Visual inspection', 'Check battery & charger', 'Verify exercise cycle', 'Record hours'],
        }),
      });
    }
    setCreating(false);
    setSelected(created.id);
    load();
  }

  async function submitRenew(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!detail) return;
    const f = new FormData(e.currentTarget);
    const result = await api<{ invoice_id: string | null }>(`/api/agreements/${detail.id}/renew`, {
      method: 'POST',
      body: JSON.stringify({
        expires_on: f.get('expires_on'),
        price: Number(f.get('price')) || null,
        create_invoice: f.get('create_invoice') === 'on',
      }),
    });
    setRenewing(false);
    loadDetail(); load();
    if (result.invoice_id) navigate(`/invoices?open=${result.invoice_id}`);
  }

  async function runScheduler() {
    const { created } = await api<{ created: number }>('/api/agreements/generate-pms', { method: 'POST', body: '{}' });
    setPmMsg(`PM scheduler: created ${created} job(s) — see the Dispatch Board's "To Schedule" tray.`);
    loadDetail();
  }

  return (
    <div className="page">
      <div className="toolbar">
        <h1>Agreement List</h1>
        <input type="search" placeholder="Search customer, agreement #, type…"
               value={q} onChange={(e) => setQ(e.target.value)} />
        <select value={view} onChange={(e) => setView(e.target.value)}>
          <option value="all">All agreements</option>
          <option value="active">Active</option>
          <option value="expiring">Renewals due (60 days)</option>
          <option value="expired">Expired</option>
        </select>
        <button className="primary" onClick={() => setCreating(true)}>New Agreement</button>
        <button className="ghost" onClick={runScheduler}>Generate PM jobs</button>
        <span className="muted">{pmMsg || `${rows.length} agreements`}</span>
      </div>
      <div className="split">
        <div className="master panel scroll">
          <table className="grid">
            <thead>
              <tr>
                <th>Customer</th><th>Type</th><th>Status</th>
                {view === 'expiring' ? <th>Phone</th> : <th>Original</th>}
                <th>Expires</th>
                {view === 'expiring' ? <th>Price</th> : <th>Visits Left</th>}
                <th>Location</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((a) => (
                <tr key={a.id} className={a.id === selected ? 'selected' : ''} onClick={() => setSelected(a.id)}>
                  <td>{a.customer_name} <span className="muted">{a.esc_account_no}</span></td>
                  <td><span className="chip gold">{a.type_code || a.plan_name || '—'}</span></td>
                  <td><span className={`chip ${a.status}`}>{a.status}</span></td>
                  {view === 'expiring'
                    ? <td>{Object.values(a.customer_phones || {})[0] || '—'}</td>
                    : <td>{fmtDate(a.original_contract_date)}</td>}
                  <td>{fmtDate(a.expires_on)}</td>
                  {view === 'expiring'
                    ? <td>{a.price ? `$${Number(a.price).toLocaleString()}` : '—'}</td>
                    : <td>
                        {a.visits_major_remaining != null && `${a.visits_major_remaining} major`}
                        {a.visits_major_remaining != null && a.visits_minor_remaining != null && ' / '}
                        {a.visits_minor_remaining != null && `${a.visits_minor_remaining} minor`}
                      </td>}
                  <td>{a.location_name || a.address1}</td>
                </tr>
              ))}
              {!rows.length && (
                <tr><td colSpan={7}><div className="empty">No agreements yet — create one or import from ESC.</div></td></tr>
              )}
            </tbody>
          </table>
        </div>
        <div className="detail panel">
          {!detail ? (
            <div className="empty">Select an agreement to see tasks, visit counters and history.</div>
          ) : (
            <>
              <h2>{detail.plan_name || detail.type_code || 'Agreement'} — {detail.customer_name}</h2>
              <div className="sub">
                {detail.esc_agreement_no ? `ESC # ${detail.esc_agreement_no} · ` : ''}
                {detail.location_name || ''}
              </div>
              <div className="kv">
                <span className="k">Status</span><span><span className={`chip ${detail.status}`}>{detail.status}</span></span>
                <span className="k">Original</span><span>{fmtDate(detail.original_contract_date)}</span>
                <span className="k">Last renewal</span><span>{fmtDate(detail.last_renewal_date)}</span>
                <span className="k">Expires</span><span>{fmtDate(detail.expires_on)}</span>
                <span className="k">Price</span><span>{detail.price ? `$${Number(detail.price).toLocaleString()}` : '—'} {detail.billing_freq || ''}</span>
                <span className="k">Major visits</span>
                <span>{detail.visits_major_remaining ?? '—'} of {detail.visits_major_total ?? '—'} remaining</span>
                <span className="k">Minor visits</span>
                <span>{detail.visits_minor_remaining ?? '—'} of {detail.visits_minor_total ?? '—'} remaining</span>
              </div>
              <div style={{ marginTop: 10 }}>
                <button className="primary" onClick={() => setRenewing(true)}>Renew…</button>
              </div>

              <section>
                <h3>Tasks (drive PM scheduling)</h3>
                {detail.tasks.length === 0 && <div className="muted">No tasks — PM jobs won't generate.</div>}
                {detail.tasks.map((t) => (
                  <div key={t.id} style={{ marginBottom: 6 }}>
                    <span className={`chip ${t.kind === 'major' ? 'gold' : 'outline'}`}>{t.kind}</span>{' '}
                    <strong>{t.name}</strong> — every {t.interval_months ?? '—'} mo, next due {fmtDate(t.next_due_on)}
                    {t.checklist?.length > 0 && (
                      <div className="muted" style={{ fontSize: 12 }}>{t.checklist.join(' · ')}</div>
                    )}
                  </div>
                ))}
              </section>

              <section>
                <h3>Job history</h3>
                {detail.jobs.length === 0 && <div className="muted">No jobs yet.</div>}
                {detail.jobs.map((j) => (
                  <div key={j.id} style={{ marginBottom: 4 }}>
                    <span className={`chip ${j.status}`}>{j.status}</span> #{j.number} {j.summary}
                    <span className="muted"> {fmtDate(j.created_at)}</span>
                  </div>
                ))}
              </section>
            </>
          )}
        </div>
      </div>

      {renewing && detail && (
        <dialog className="modal" open>
          <h2>Renew — {detail.plan_name || detail.type_code} for {detail.customer_name}</h2>
          <form onSubmit={submitRenew}>
            <label className="muted">New expiration
              <input name="expires_on" type="date" required
                     defaultValue={new Date(Date.now() + 365 * 864e5).toISOString().slice(0, 10)} />
            </label>
            <label className="muted">Price $
              <input name="price" type="number" step="0.01"
                     defaultValue={detail.price ? Number(detail.price) : undefined} />
            </label>
            <label style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
              <input type="checkbox" name="create_invoice" defaultChecked style={{ width: 'auto' }} />
              Create the renewal invoice now
            </label>
            <div className="muted" style={{ fontSize: 12 }}>
              Renewing resets the visit counters and reactivates PM scheduling.
            </div>
            <div className="actions">
              <button type="button" className="ghost" onClick={() => setRenewing(false)}>Cancel</button>
              <button className="primary">Renew</button>
            </div>
          </form>
        </dialog>
      )}

      {creating && (
        <dialog className="modal" open>
          <h2>New Agreement</h2>
          <form onSubmit={createAgreement}>
            <input placeholder="Search customer…" value={custQuery} onChange={(e) => setCustQuery(e.target.value)} />
            <select name="customer" required size={Math.min(custHits.length || 1, 5)}>
              {custHits.map((c) => (
                <option key={`${c.customer_id}-${c.location_id}`} value={c.customer_id}>
                  {c.customer_name} {c.esc_account_no ? `(${c.esc_account_no})` : ''} — {c.location_name || 'no location'}
                </option>
              ))}
            </select>
            <div className="row">
              <input name="type_code" placeholder="Type code (SAR…)" style={{ flex: 1 }} />
              <select name="plan_name" style={{ flex: 1 }}>
                {['Silver', 'Gold', 'Platinum', ''].map((p) => <option key={p} value={p}>{p || 'No plan tier'}</option>)}
              </select>
            </div>
            <div className="row">
              <input name="price" type="number" step="0.01" placeholder="Price $" style={{ flex: 1 }} />
              <select name="billing_freq" style={{ flex: 1 }}>
                {['annual', 'semiannual', 'quarterly', 'monthly'].map((b) => <option key={b} value={b}>{b}</option>)}
              </select>
            </div>
            <div className="row">
              <label className="muted" style={{ flex: 1 }}>Start<input name="start" type="date" required /></label>
              <label className="muted" style={{ flex: 1 }}>Expires<input name="expires" type="date" required /></label>
            </div>
            <div className="row">
              <label className="muted" style={{ flex: 1 }}>Major visits/term<input name="visits_major" type="number" defaultValue={1} /></label>
              <label className="muted" style={{ flex: 1 }}>Minor visits/term<input name="visits_minor" type="number" defaultValue={1} /></label>
            </div>
            <label className="muted">First service due<input name="first_due" type="date" /></label>
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
