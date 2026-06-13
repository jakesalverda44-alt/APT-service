import { useCallback, useEffect, useState } from 'react';
import { api, fmtDate, fmtTime } from '../api';
import SignaturePad from '../components/SignaturePad';

interface MyDispatch {
  id: string; job_id: string; status: string; scheduled_start: string;
  time_in: string | null; time_out: string | null; signature: string | null;
  job_number: number; job_type: string; summary: string | null; priority: string;
  customer_name: string | null; location_id: string | null; location_name: string | null;
  address1: string | null; city: string | null; state: string | null; zip: string | null;
  access_notes: string | null; location_phones: Record<string, string> | null;
}

interface JobInfo {
  notes: { id: string; author_name: string | null; body: string; created_at: string }[];
  lines: { id: string; kind: string; description: string; qty: string; unit_price: string }[];
}
interface LocInfo {
  equipment: { id: string; kind: string; manufacturer: string | null; model: string | null;
    serial: string | null; kw: string | null }[];
  dispatch_history: { id: string; received_date: string | null; summary: string | null }[];
}

const NEXT: Record<string, { label: string; status: string }> = {
  scheduled: { label: 'Dispatch me', status: 'dispatched' },
  dispatched: { label: 'En route', status: 'enroute' },
  enroute: { label: 'On site', status: 'onsite' },
  onsite: { label: 'Complete', status: 'complete' },
};

export default function MyDay() {
  const [date, setDate] = useState(new Date().toISOString().slice(0, 10));
  const [list, setList] = useState<MyDispatch[]>([]);
  const [noteFor, setNoteFor] = useState<string | null>(null);
  const [note, setNote] = useState('');
  const [openId, setOpenId] = useState<string | null>(null);
  const [jobInfo, setJobInfo] = useState<JobInfo | null>(null);
  const [locInfo, setLocInfo] = useState<LocInfo | null>(null);

  const load = useCallback(() => {
    api<MyDispatch[]>(`/api/dispatches/mine?date=${date}`).then(setList).catch(() => setList([]));
  }, [date]);
  useEffect(load, [load]);

  async function toggleDetails(d: MyDispatch) {
    if (openId === d.id) return setOpenId(null);
    setOpenId(d.id);
    setJobInfo(null);
    setLocInfo(null);
    api<JobInfo>(`/api/jobs/${d.job_id}`).then(setJobInfo).catch(() => setJobInfo(null));
    if (d.location_id) {
      api<LocInfo>(`/api/customers/location/${d.location_id}`).then(setLocInfo).catch(() => setLocInfo(null));
    }
  }

  async function addLine(e: React.FormEvent<HTMLFormElement>, jobId: string) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    await api(`/api/jobs/${jobId}/lines`, {
      method: 'POST',
      body: JSON.stringify({
        kind: f.get('kind'), description: f.get('description'),
        qty: Number(f.get('qty')) || 1, unit_price: Number(f.get('unit_price')) || 0,
      }),
    });
    e.currentTarget?.reset?.();
    api<JobInfo>(`/api/jobs/${jobId}`).then(setJobInfo);
  }

  async function advance(d: MyDispatch) {
    const next = NEXT[d.status];
    if (!next) return;
    const body: Record<string, unknown> = { status: next.status };
    if (next.status === 'onsite') body.time_in = new Date().toISOString();
    if (next.status === 'complete') body.time_out = new Date().toISOString();
    await api(`/api/dispatches/${d.id}`, { method: 'PATCH', body: JSON.stringify(body) });
    load();
  }

  async function saveNote(jobId: string) {
    if (!note.trim()) return;
    await api(`/api/jobs/${jobId}/notes`, { method: 'POST', body: JSON.stringify({ body: note }) });
    setNote('');
    setNoteFor(null);
  }

  const mapsUrl = (d: MyDispatch) =>
    `https://maps.apple.com/?q=${encodeURIComponent([d.address1, d.city, d.state, d.zip].filter(Boolean).join(', '))}`;

  return (
    <div className="page myday">
      <div className="toolbar">
        <h1>My Day</h1>
        <input type="date" value={date} onChange={(e) => setDate(e.target.value)} />
        <button className="ghost" onClick={load}>Refresh</button>
      </div>
      {list.length === 0 && <div className="panel empty">No dispatches for this day.</div>}
      {list.map((d) => (
        <div key={d.id} className={`panel myday-card card ${d.priority === 'emergency' ? 'emergency' : d.status}`}>
          <div className="when">
            {fmtTime(d.scheduled_start)} <span className={`chip ${d.status}`}>{d.status}</span>
            {d.priority === 'emergency' && <span className="chip emergency">EMERGENCY</span>}
          </div>
          <div className="who" style={{ fontSize: 16 }}>{d.customer_name}</div>
          <div>{d.location_name}</div>
          <div className="muted">{[d.address1, d.city].filter(Boolean).join(', ')}</div>
          <div style={{ margin: '4px 0' }}>{d.job_type} #{d.job_number} — {d.summary}</div>
          {d.access_notes && <div><span className="chip gold">access</span> {d.access_notes}</div>}
          {d.location_phones && Object.entries(d.location_phones).map(([label, num]) => (
            <div key={label}><a href={`tel:${num}`}>{num}</a> <span className="muted">({label.replace('_', ' ')})</span></div>
          ))}
          <div style={{ display: 'flex', gap: 8, marginTop: 10, flexWrap: 'wrap' }}>
            {NEXT[d.status] && (
              <button className="primary big" onClick={() => advance(d)}>{NEXT[d.status].label}</button>
            )}
            <a className="ghost big" style={{ textDecoration: 'none', display: 'inline-block' }}
               href={mapsUrl(d)} target="_blank" rel="noreferrer">Directions</a>
            <button className="ghost big" onClick={() => setNoteFor(noteFor === d.id ? null : d.id)}>Note</button>
            <button className="ghost big" onClick={() => toggleDetails(d)}>
              {openId === d.id ? 'Hide Details' : 'Details'}
            </button>
          </div>

          {openId === d.id && (
            <div className="myday-details">
              {locInfo && locInfo.equipment.length > 0 && (
                <div className="loc-equip">
                  {locInfo.equipment.map((e) => (
                    <div key={e.id}>🔧 {[e.kind, e.manufacturer, e.model, e.serial ? `S/N ${e.serial}` : '',
                      e.kw ? `${Number(e.kw)}kW` : ''].filter(Boolean).join(' · ')}</div>
                  ))}
                </div>
              )}

              {jobInfo && jobInfo.notes.length > 0 && (
                <div className="myday-notes">
                  {jobInfo.notes.map((n) => (
                    <div key={n.id} style={{ marginBottom: 6 }}>
                      <div className="muted" style={{ fontSize: 11 }}>
                        {fmtDate(n.created_at)} — {n.author_name || 'office'}
                      </div>
                      <div style={{ whiteSpace: 'pre-wrap' }}>{n.body}</div>
                    </div>
                  ))}
                </div>
              )}

              {locInfo && locInfo.dispatch_history.length > 0 && (
                <div style={{ marginTop: 8 }}>
                  <div className="muted" style={{ fontSize: 11, textTransform: 'uppercase' }}>Last visits here</div>
                  {locInfo.dispatch_history.slice(0, 3).map((h) => (
                    <div key={h.id} className="muted" style={{ fontSize: 12.5 }}>
                      {fmtDate(h.received_date)} — {(h.summary || '').slice(0, 70)}
                    </div>
                  ))}
                </div>
              )}

              <div style={{ marginTop: 10 }}>
                <div className="muted" style={{ fontSize: 11, textTransform: 'uppercase' }}>Parts & labor used</div>
                {jobInfo?.lines.map((l) => (
                  <div key={l.id} style={{ fontSize: 13 }}>
                    {l.description} — {Number(l.qty)} × ${Number(l.unit_price).toFixed(2)}
                  </div>
                ))}
                <form onSubmit={(e) => addLine(e, d.job_id)} style={{ display: 'flex', gap: 4, marginTop: 6, flexWrap: 'wrap' }}>
                  <select name="kind" style={{ width: 76 }}>
                    <option value="part">part</option>
                    <option value="labor">labor</option>
                  </select>
                  <input name="description" placeholder="What was used / done" required style={{ flex: 1, minWidth: 140 }} />
                  <input name="qty" type="number" step="0.25" defaultValue={1} style={{ width: 56 }} />
                  <input name="unit_price" type="number" step="0.01" placeholder="$" style={{ width: 72 }} />
                  <button className="ghost">Add</button>
                </form>
              </div>

              <div style={{ marginTop: 10 }}>
                <SignaturePad dispatchId={d.id} existing={d.signature} onSaved={load} />
              </div>
            </div>
          )}
          {noteFor === d.id && (
            <div style={{ display: 'flex', gap: 6, marginTop: 8 }}>
              <input style={{ flex: 1 }} placeholder="Field note…" value={note} onChange={(e) => setNote(e.target.value)} />
              <button className="primary" onClick={() => saveNote(d.job_id)}>Save</button>
            </div>
          )}
          {(d.time_in || d.time_out) && (
            <div className="muted" style={{ marginTop: 6 }}>
              {d.time_in && `In ${fmtTime(d.time_in)}`} {d.time_out && ` · Out ${fmtTime(d.time_out)}`}
            </div>
          )}
        </div>
      ))}
    </div>
  );
}
