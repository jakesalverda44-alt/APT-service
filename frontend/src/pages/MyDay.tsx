import { useCallback, useEffect, useState } from 'react';
import { api, fmtTime } from '../api';

interface MyDispatch {
  id: string; job_id: string; status: string; scheduled_start: string;
  time_in: string | null; time_out: string | null;
  job_number: number; job_type: string; summary: string | null; priority: string;
  customer_name: string | null; location_name: string | null;
  address1: string | null; city: string | null; state: string | null; zip: string | null;
  access_notes: string | null; location_phones: Record<string, string> | null;
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

  const load = useCallback(() => {
    api<MyDispatch[]>(`/api/dispatches/mine?date=${date}`).then(setList).catch(() => setList([]));
  }, [date]);
  useEffect(load, [load]);

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
          </div>
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
