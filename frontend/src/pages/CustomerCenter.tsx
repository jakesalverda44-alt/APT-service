import { useCallback, useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
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
    state: string | null; zip: string | null;
    access_notes: string | null; notes: string | null;
    contact_name: string | null; email: string | null; phones: Record<string, string>;
    equipment: { id: string; kind: string; manufacturer: string | null; model: string | null;
                 serial: string | null; kw: string | null }[];
  }[];
  agreements: { id: string; type_code: string | null; plan_name: string | null; status: string; expires_on: string | null }[];
  recent_jobs: { id: string; number: number; type: string; status: string; summary: string | null; created_at: string }[];
  recent_invoices: { id: string; number: number; status: string; total: string; balance_due: string; issued_on: string | null }[];
  recent_quotes: { id: string; number: number; status: string; summary: string | null; total: string; created_at: string }[];
  dispatch_history: {
    id: string; esc_dispatch_no: string; type: string; priority: string | null;
    received_date: string | null; completed_date: string | null;
    invoice_no: string | null; summary: string | null; location_name: string | null;
  }[];
  invoice_history: {
    id: string; esc_invoice_no: string; inv_date: string | null; amount: string;
    paid: string; balance: string; paid_off_date: string | null; location_name: string | null;
  }[];
  ar: { balance: string; current: string; over30: string; over60: string; over90: string };
}

interface LocDetail {
  location: LocationDetail & { state: string | null; zip: string | null; status: string };
  customer: { id: string; name: string; esc_account_no: string | null; billing_address1: string | null;
    billing_city: string | null; billing_state: string | null; billing_zip: string | null;
    phones: Record<string, string>; email: string | null; credit_terms: string | null; balance: string };
  equipment: { id: string; kind: string; manufacturer: string | null; model: string | null;
    serial: string | null; kw: string | null; notes: string | null }[];
  agreements: { id: string; type_code: string | null; plan_name: string | null; status: string;
    original_contract_date: string | null; expires_on: string | null;
    visits_major_remaining: number | null; visits_minor_remaining: number | null }[];
  dispatch_history: { id: string; esc_dispatch_no: string; type: string; received_date: string | null;
    completed_date: string | null; invoice_no: string | null; summary: string | null }[];
  invoice_history: { id: string; esc_invoice_no: string; inv_date: string | null; amount: string;
    paid: string; balance: string }[];
  quotes: { id: string; number: number; status: string; summary: string | null; created_at: string }[];
  active_jobs: { id: string; number: number; type: string; status: string; summary: string | null }[];
}

const money = (v: string | number) => `$${Number(v).toLocaleString(undefined, { minimumFractionDigits: 2 })}`;

interface DispatchRowData {
  id: string; esc_dispatch_no: string; type: string; received_date: string | null;
  invoice_no: string | null; summary: string | null; location_name?: string | null;
}

function DispatchRow({ d }: { d: DispatchRowData }) {
  const [open, setOpen] = useState(false);
  const [full, setFull] = useState<string | null>(null);
  async function toggle() {
    if (!open && full === null) {
      const r = await api<{ notes: string | null }>(`/api/customers/dispatch/${d.id}`).catch(() => ({ notes: null }));
      setFull(r.notes || '(no notes recorded)');
    }
    setOpen(!open);
  }
  return (
    <div className="dh-row" onClick={toggle}>
      <div>
        <span className="chip outline">{d.type}</span>{' '}
        <span className="muted">{fmtDate(d.received_date)}</span> {d.summary}
        {d.location_name && <span className="muted"> · {d.location_name}</span>}
        {d.invoice_no && <span className="muted"> · inv {d.invoice_no}</span>}
      </div>
      {open && <div className="dh-notes">{full}</div>}
    </div>
  );
}

const phoneList = (phones: Record<string, string>) =>
  Object.entries(phones || {}).map(([label, num]) => `${num} (${label.replace('_', ' ')})`).join('  ');

type LocationDetail = Detail['locations'][number];

function LocationCard({ loc }: { loc: LocationDetail }) {
  const [showNotes, setShowNotes] = useState(false);
  const addr = [loc.address1, loc.city, loc.state, loc.zip].filter(Boolean).join(', ');
  const phones = Object.entries(loc.phones || {});
  const long = !!loc.notes && loc.notes.length > 160;
  const notesText = long && !showNotes ? loc.notes!.slice(0, 160) + '…' : loc.notes;
  return (
    <div className="loc-card">
      <div className="loc-name">{loc.name || '—'}</div>
      {addr && <div className="muted">{addr}</div>}
      {loc.contact_name && <div><span className="muted">Contact:</span> {loc.contact_name}</div>}
      {phones.map(([label, num]) => (
        <div key={label}><a href={`tel:${num}`}>{num}</a> <span className="muted">({label.replace(/_/g, ' ')})</span></div>
      ))}
      {loc.email && <div><a href={`mailto:${loc.email}`}>{loc.email}</a></div>}
      {loc.access_notes && (
        <div className="access-flag"><span className="chip gold">⚠ access</span> {loc.access_notes}</div>
      )}
      {loc.equipment.length > 0 && (
        <div className="loc-equip">
          {loc.equipment.map((e) => (
            <div key={e.id}>🔧 {[e.kind, e.manufacturer, e.model, e.serial, e.kw ? `${e.kw}kW` : '']
              .filter(Boolean).join(' · ')}</div>
          ))}
        </div>
      )}
      {loc.notes && (
        <div className="loc-notes">
          <div className="notes-label">Location Notes</div>
          <div className="notes-body">{notesText}</div>
          {long && (
            <button className="link-sm" onClick={() => setShowNotes(!showNotes)}>
              {showNotes ? 'show less' : 'show all'}
            </button>
          )}
        </div>
      )}
    </div>
  );
}

export default function CustomerCenter() {
  const [q, setQ] = useState('');
  const [status, setStatus] = useState('active');
  const [rows, setRows] = useState<Row[]>([]);
  const [total, setTotal] = useState(0);
  const [selected, setSelected] = useState<string | null>(null);
  const [selectedLoc, setSelectedLoc] = useState<string | null>(null);
  const [detail, setDetail] = useState<Detail | null>(null);
  const [locDetail, setLocDetail] = useState<LocDetail | null>(null);
  const [modal, setModal] = useState<'job' | 'edit' | 'location' | 'equipment' | 'customer' | null>(null);
  const navigate = useNavigate();

  function selectRow(r: Row) {
    setSelected(r.customer_id);
    setSelectedLoc(r.location_id);
  }

  useEffect(() => {
    if (!selectedLoc) return setLocDetail(null);
    api<LocDetail>(`/api/customers/location/${selectedLoc}`).then(setLocDetail).catch(() => setLocDetail(null));
  }, [selectedLoc]);

  useEffect(() => {
    const t = setTimeout(() => {
      api<{ rows: Row[]; total: number }>(`/api/customers?q=${encodeURIComponent(q)}&status=${status}`)
        .then((d) => { setRows(d.rows); setTotal(d.total); })
        .catch(() => { setRows([]); setTotal(0); });
    }, 250);
    return () => clearTimeout(t);
  }, [q, status]);

  const refresh = useCallback(() => {
    if (!selected) return setDetail(null);
    api<Detail>(`/api/customers/${selected}`).then(setDetail).catch(() => setDetail(null));
  }, [selected]);
  useEffect(refresh, [refresh]);

  async function submitModal(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    const get = (k: string) => (f.get(k) as string) || null;
    if (modal === 'customer') {
      const created = await api<{ id: string }>('/api/customers', {
        method: 'POST',
        body: JSON.stringify({
          name: get('name'), billing_address1: get('address1'), billing_city: get('city'),
          billing_state: get('state'), billing_zip: get('zip'), email: get('email'),
          phones: get('phone') ? { phone: get('phone') } : {},
        }),
      });
      setSelected(created.id);
      setQ(get('name') || '');
    } else if (modal === 'job' && detail) {
      await api('/api/jobs', {
        method: 'POST',
        body: JSON.stringify({
          customer_id: detail.id, location_id: get('location_id'),
          type: get('type'), priority: get('priority'), summary: get('summary'),
        }),
      });
      navigate('/board');
    } else if (modal === 'edit' && detail) {
      await api(`/api/customers/${detail.id}`, {
        method: 'PATCH',
        body: JSON.stringify({
          name: get('name'), billing_address1: get('address1'), billing_city: get('city'),
          billing_state: get('state'), billing_zip: get('zip'), email: get('email'),
        }),
      });
    } else if (modal === 'location' && detail) {
      await api(`/api/customers/${detail.id}/locations`, {
        method: 'POST',
        body: JSON.stringify({
          name: get('name'), address1: get('address1'), city: get('city'),
          state: get('state'), zip: get('zip'), access_notes: get('access_notes'),
        }),
      });
    } else if (modal === 'equipment' && detail) {
      await api(`/api/customers/locations/${get('location_id')}/equipment`, {
        method: 'POST',
        body: JSON.stringify({
          kind: get('kind'), manufacturer: get('manufacturer'), model: get('model'),
          serial: get('serial'), kw: Number(get('kw')) || null, fuel: get('fuel') || null,
        }),
      });
    }
    setModal(null);
    refresh();
  }

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
        <select value={status} onChange={(e) => setStatus(e.target.value)}>
          <option value="active">Active customers</option>
          <option value="inactive">Inactive customers</option>
          <option value="all">All customers</option>
        </select>
        <button className="primary" onClick={() => setModal('customer')}>New Customer</button>
        <span className="muted">
          {total > rows.length ? `showing ${rows.length} of ${total.toLocaleString()}` : `${total.toLocaleString()} rows`}
        </span>
      </div>
      <div className="split">
        <div className="master panel scroll">
          <table className="grid">
            <thead>
              <tr><th>Full Name</th><th>Acct #</th><th>Location Name</th><th>Address</th><th>City</th></tr>
            </thead>
            <tbody>
              {rows.map((r, i) => {
                // ESC-style grouping: customer name shows on its first row only;
                // following rows are that customer's locations.
                const firstOfGroup = i === 0 || rows[i - 1].customer_id !== r.customer_id;
                return (
                  <tr
                    key={`${r.customer_id}-${r.location_id}`}
                    className={r.location_id === selectedLoc && r.customer_id === selected ? 'selected' : ''}
                    onClick={() => selectRow(r)}
                  >
                    <td className={firstOfGroup ? '' : 'group-cont'}>{firstOfGroup ? r.customer_name : ''}</td>
                    <td className="muted">{firstOfGroup ? r.esc_account_no : ''}</td>
                    <td>{r.location_name}</td>
                    <td>{r.address1}</td>
                    <td>{r.city}</td>
                  </tr>
                );
              })}
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
                {detail.ar && Number(detail.ar.balance) > 0 && (
                  <>
                    <span className="k">Balance</span>
                    <span>
                      <strong>{money(detail.ar.balance)}</strong>
                      <span className="muted">
                        {Number(detail.ar.over30) > 0 && ` · 30+: ${money(detail.ar.over30)}`}
                        {Number(detail.ar.over60) > 0 && ` · 60+: ${money(detail.ar.over60)}`}
                        {Number(detail.ar.over90) > 0 && ` · 90+: ${money(detail.ar.over90)}`}
                      </span>
                    </span>
                  </>
                )}
              </div>
              {detail.notes && <div className="muted" style={{ marginTop: 8 }}>{detail.notes}</div>}

              <div style={{ display: 'flex', gap: 6, marginTop: 10, flexWrap: 'wrap' }}>
                <button className="primary" onClick={() => setModal('job')}>New Job</button>
                <button className="ghost" onClick={() => setModal('edit')}>Edit</button>
                <button className="ghost" onClick={() => setModal('location')}>Add Location</button>
                <button className="ghost" onClick={() => setModal('equipment')}>Add Equipment</button>
              </div>

              {locDetail ? (
                <>
                  {/* ESC-style: the panel is about the SELECTED location */}
                  <section>
                    <h3>Location — {locDetail.location.name || locDetail.location.address1 || '—'}</h3>
                    <LocationCard loc={{ ...locDetail.location, equipment: locDetail.equipment }} />
                  </section>

                  <section>
                    <h3>Maintenance Schedule</h3>
                    {locDetail.agreements.length === 0 && <div className="muted">No agreement at this location.</div>}
                    {locDetail.agreements.map((a) => (
                      <div key={a.id} style={{ marginBottom: 4 }}>
                        <span className={`chip ${a.status}`}>{a.status}</span>{' '}
                        <strong>{a.plan_name || a.type_code || 'Plan'}</strong>
                        {a.expires_on && <> — expires {fmtDate(a.expires_on)}</>}
                        {(a.visits_major_remaining != null || a.visits_minor_remaining != null) && (
                          <span className="muted">
                            {' '}({[a.visits_major_remaining != null ? `${a.visits_major_remaining} major` : '',
                                   a.visits_minor_remaining != null ? `${a.visits_minor_remaining} minor` : '']
                                  .filter(Boolean).join(' / ')} left)
                          </span>
                        )}
                      </div>
                    ))}
                  </section>

                  {locDetail.active_jobs.length > 0 && (
                    <section>
                      <h3>Active Jobs</h3>
                      {locDetail.active_jobs.map((j) => (
                        <div key={j.id} style={{ marginBottom: 4 }}>
                          <span className={`chip ${j.status}`}>{j.status}</span> #{j.number} {j.type} — {j.summary || '—'}
                        </div>
                      ))}
                    </section>
                  )}

                  <section>
                    <h3>Recent Dispatches</h3>
                    {locDetail.dispatch_history.length === 0 && <div className="muted">No history at this location.</div>}
                    {locDetail.dispatch_history.map((d) => <DispatchRow key={d.id} d={d} />)}
                  </section>

                  <section>
                    <h3>Recent Invoices</h3>
                    {locDetail.invoice_history.length === 0 && <div className="muted">None at this location.</div>}
                    {locDetail.invoice_history.map((i) => (
                      <div key={i.id} style={{ marginBottom: 4 }}>
                        <span className={`chip ${Number(i.balance) <= 0 ? 'complete' : 'pending'}`}>
                          {Number(i.balance) <= 0 ? 'paid' : 'open'}
                        </span>{' '}
                        #{i.esc_invoice_no} {money(i.amount)}
                        {Number(i.balance) > 0 && <strong> (bal {money(i.balance)})</strong>}
                        <span className="muted"> {fmtDate(i.inv_date)}</span>
                      </div>
                    ))}
                  </section>

                  {locDetail.quotes.length > 0 && (
                    <section>
                      <h3>Recent Quotes</h3>
                      {locDetail.quotes.map((qt) => (
                        <div key={qt.id} style={{ marginBottom: 4, cursor: 'pointer' }}
                             onClick={() => navigate(`/quotes?open=${qt.id}`)}>
                          <span className={`chip ${qt.status === 'accepted' ? 'complete' : 'pending'}`}>{qt.status}</span>{' '}
                          #{qt.number} — {qt.summary || '—'} <span className="muted">{fmtDate(qt.created_at)}</span>
                        </div>
                      ))}
                    </section>
                  )}
                </>
              ) : (
                <>
              <section>
                <h3>Locations ({detail.locations.length})</h3>
                {detail.locations.map((l) => <LocationCard key={l.id} loc={l} />)}
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
                <h3>Service History {detail.dispatch_history.length > 0 && `(${detail.dispatch_history.length} most recent)`}</h3>
                {detail.dispatch_history.length === 0 && <div className="muted">No dispatch history imported yet.</div>}
                {detail.dispatch_history.map((d) => <DispatchRow key={d.id} d={d} />)}
              </section>

              <section>
                <h3>Recent Quotes</h3>
                {detail.recent_quotes.length === 0 && <div className="muted">No quotes yet.</div>}
                {detail.recent_quotes.map((qt) => (
                  <div key={qt.id} style={{ marginBottom: 4, cursor: 'pointer' }}
                       onClick={() => navigate(`/quotes?open=${qt.id}`)}>
                    <span className={`chip ${qt.status === 'accepted' ? 'complete' : 'pending'}`}>{qt.status}</span>{' '}
                    #{qt.number} ${Number(qt.total).toLocaleString()} — {qt.summary || '—'}
                    <span className="muted"> {fmtDate(qt.created_at)}</span>
                  </div>
                ))}
              </section>

              <section>
                <h3>Recent Invoices</h3>
                {detail.recent_invoices.length === 0 && detail.invoice_history.length === 0 && (
                  <div className="muted">No invoices yet.</div>
                )}
                {detail.recent_invoices.map((i) => (
                  <div key={i.id} style={{ marginBottom: 4 }}>
                    <span className={`chip ${i.status === 'paid' ? 'complete' : 'pending'}`}>{i.status}</span>{' '}
                    #{i.number} {money(i.total)} (due {money(i.balance_due)}) {fmtDate(i.issued_on)}
                  </div>
                ))}
                {detail.invoice_history.map((i) => (
                  <div key={i.id} style={{ marginBottom: 4 }}>
                    <span className={`chip ${Number(i.balance) <= 0 ? 'complete' : 'pending'}`}>
                      {Number(i.balance) <= 0 ? 'paid' : 'open'}
                    </span>{' '}
                    #{i.esc_invoice_no} {money(i.amount)}
                    {Number(i.balance) > 0 && <strong> (bal {money(i.balance)})</strong>}
                    <span className="muted"> {fmtDate(i.inv_date)}{i.location_name ? ` · ${i.location_name}` : ''}</span>
                  </div>
                ))}
              </section>
                </>
              )}
            </>
          )}
        </div>
      </div>

      {modal && (
        <dialog className="modal" open>
          <h2>
            {modal === 'customer' && 'New Customer'}
            {modal === 'job' && `New Job — ${detail?.name}`}
            {modal === 'edit' && 'Edit Customer'}
            {modal === 'location' && 'Add Location'}
            {modal === 'equipment' && 'Add Equipment'}
          </h2>
          <form onSubmit={submitModal}>
            {(modal === 'customer' || modal === 'edit') && (
              <>
                <input name="name" placeholder="Name" required defaultValue={modal === 'edit' ? detail?.name : ''} />
                <input name="address1" placeholder="Billing address" defaultValue={modal === 'edit' ? detail?.billing_address1 || '' : ''} />
                <div className="row">
                  <input name="city" placeholder="City" style={{ flex: 2 }} defaultValue={modal === 'edit' ? detail?.billing_city || '' : ''} />
                  <input name="state" placeholder="ST" style={{ flex: 1 }} defaultValue={modal === 'edit' ? detail?.billing_state || 'FL' : 'FL'} />
                  <input name="zip" placeholder="ZIP" style={{ flex: 1 }} defaultValue={modal === 'edit' ? detail?.billing_zip || '' : ''} />
                </div>
                <input name="email" type="email" placeholder="Email" defaultValue={modal === 'edit' ? detail?.email || '' : ''} />
                {modal === 'customer' && <input name="phone" placeholder="Phone" />}
              </>
            )}
            {modal === 'job' && (
              <>
                <select name="location_id" required>
                  {detail?.locations.map((l) => (
                    <option key={l.id} value={l.id}>{l.name || l.address1 || 'Location'}</option>
                  ))}
                </select>
                <div className="row">
                  <select name="type" style={{ flex: 1 }}>
                    {['repair', 'pm', 'install', 'warranty', 'callback', 'project'].map((t) => <option key={t}>{t}</option>)}
                  </select>
                  <select name="priority" style={{ flex: 1 }}>
                    {['normal', 'high', 'emergency', 'low'].map((p) => <option key={p}>{p}</option>)}
                  </select>
                </div>
                <textarea name="summary" placeholder="Problem / work description" rows={3} required />
              </>
            )}
            {modal === 'location' && (
              <>
                <input name="name" placeholder="Location name" />
                <input name="address1" placeholder="Address" required />
                <div className="row">
                  <input name="city" placeholder="City" style={{ flex: 2 }} />
                  <input name="state" placeholder="ST" style={{ flex: 1 }} defaultValue="FL" />
                  <input name="zip" placeholder="ZIP" style={{ flex: 1 }} />
                </div>
                <input name="access_notes" placeholder="Gate code / access notes" />
              </>
            )}
            {modal === 'equipment' && (
              <>
                <select name="location_id" required>
                  {detail?.locations.map((l) => (
                    <option key={l.id} value={l.id}>{l.name || l.address1 || 'Location'}</option>
                  ))}
                </select>
                <div className="row">
                  <select name="kind" style={{ flex: 1 }}>
                    {['generator', 'ats', 'panel', 'pump', 'other'].map((k) => <option key={k}>{k}</option>)}
                  </select>
                  <select name="fuel" style={{ flex: 1 }}>
                    <option value="">fuel…</option>
                    {['natural_gas', 'propane', 'diesel', 'gasoline', 'other'].map((fu) => <option key={fu}>{fu}</option>)}
                  </select>
                </div>
                <div className="row">
                  <input name="manufacturer" placeholder="Manufacturer" style={{ flex: 1 }} />
                  <input name="model" placeholder="Model" style={{ flex: 1 }} />
                </div>
                <div className="row">
                  <input name="serial" placeholder="Serial #" style={{ flex: 2 }} />
                  <input name="kw" type="number" step="0.5" placeholder="kW" style={{ flex: 1 }} />
                </div>
              </>
            )}
            <div className="actions">
              <button type="button" className="ghost" onClick={() => setModal(null)}>Cancel</button>
              <button className="primary">Save</button>
            </div>
          </form>
        </dialog>
      )}
    </div>
  );
}
