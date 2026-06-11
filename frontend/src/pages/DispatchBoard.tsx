import { useCallback, useEffect, useState } from 'react';
import { api, fmtTime } from '../api';

interface Tech { id: string; name: string; role: string }
interface Dispatch {
  id: string; job_id: string; tech_id: string | null; tech_name: string | null;
  scheduled_start: string; status: string;
  job_number: number; job_type: string; priority: string; summary: string | null;
  is_agreement_work: boolean; customer_name: string | null; location_name: string | null; city: string | null;
}
interface UnscheduledJob {
  id: string; number: number; type: string; priority: string; summary: string | null;
  customer_name: string | null; location_name: string | null; city: string | null;
}
interface Board { date: string; techs: Tech[]; dispatches: Dispatch[]; unscheduled: UnscheduledJob[] }

const STATUS_FLOW = ['scheduled', 'dispatched', 'enroute', 'onsite', 'complete'];

function cardClass(d: Dispatch) {
  const cls = d.priority === 'emergency' ? 'emergency' : d.status;
  return `card ${cls}${d.is_agreement_work ? ' agreement' : ''}`;
}

export default function DispatchBoard() {
  const [date, setDate] = useState(new Date().toISOString().slice(0, 10));
  const [board, setBoard] = useState<Board | null>(null);
  const [scheduling, setScheduling] = useState<UnscheduledJob | null>(null);

  const load = useCallback(() => {
    api<Board>(`/api/dispatches/board?date=${date}`).then(setBoard).catch(() => setBoard(null));
  }, [date]);
  useEffect(load, [load]);

  async function advance(d: Dispatch) {
    const next = STATUS_FLOW[STATUS_FLOW.indexOf(d.status) + 1];
    if (!next) return;
    await api(`/api/dispatches/${d.id}`, { method: 'PATCH', body: JSON.stringify({ status: next }) });
    load();
  }

  async function schedule(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!scheduling) return;
    const form = new FormData(e.currentTarget);
    await api('/api/dispatches', {
      method: 'POST',
      body: JSON.stringify({
        job_id: scheduling.id,
        tech_id: form.get('tech_id') || null,
        scheduled_start: `${date}T${form.get('time') || '08:00'}:00`,
      }),
    });
    setScheduling(null);
    load();
  }

  const cols = board
    ? [
        ...board.techs.map((t) => ({
          key: t.id,
          title: t.name,
          cards: board.dispatches.filter((d) => d.tech_id === t.id),
        })),
        {
          key: 'unassigned',
          title: 'Unassigned',
          cards: board.dispatches.filter((d) => !d.tech_id || !board.techs.some((t) => t.id === d.tech_id)),
        },
      ]
    : [];

  return (
    <div className="page">
      <div className="toolbar">
        <h1>Dispatch Board</h1>
        <input type="date" value={date} onChange={(e) => setDate(e.target.value)} />
        <button className="ghost" onClick={load}>Refresh</button>
        <span className="muted">
          Card colors: blue scheduled · orange dispatched/en-route · purple on-site · green complete · red emergency ·
          gold top edge = agreement work. Click a card to advance its status.
        </span>
      </div>
      <div className="board">
        <div className="col tray">
          <header>To Schedule ({board?.unscheduled.length ?? 0})</header>
          <div className="cards">
            {board?.unscheduled.map((j) => (
              <div key={j.id} className={`card ${j.priority === 'emergency' ? 'emergency' : 'pending'}`}
                   onClick={() => setScheduling(j)} title="Click to schedule">
                <div className="who">#{j.number} {j.customer_name || '—'}</div>
                <div className="what">{j.location_name || j.city || ''}</div>
                <div className="what">{j.type}{j.summary ? ` — ${j.summary}` : ''}</div>
              </div>
            ))}
            {board && board.unscheduled.length === 0 && <div className="empty">Nothing waiting.</div>}
          </div>
        </div>
        {cols.map((c) => (
          <div key={c.key} className="col">
            <header>{c.title}</header>
            <div className="cards">
              {c.cards.map((d) => (
                <div key={d.id} className={cardClass(d)} onClick={() => advance(d)}
                     title={`#${d.job_number} — click to advance status`}>
                  <div className="when">{fmtTime(d.scheduled_start)} <span className={`chip ${d.status}`}>{d.status}</span></div>
                  <div className="who">{d.customer_name || '—'}</div>
                  <div className="what">{d.location_name || d.city || ''}</div>
                  <div className="what">{d.job_type}{d.summary ? ` — ${d.summary}` : ''}</div>
                </div>
              ))}
              {c.cards.length === 0 && <div className="empty">—</div>}
            </div>
          </div>
        ))}
      </div>

      {scheduling && (
        <dialog className="modal" open>
          <h2>Schedule #{scheduling.number} — {scheduling.customer_name}</h2>
          <form onSubmit={schedule}>
            <div>
              <label className="muted">Technician</label>
              <select name="tech_id" defaultValue="">
                <option value="">Unassigned</option>
                {board?.techs.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
              </select>
            </div>
            <div>
              <label className="muted">Time on {date}</label>
              <input type="time" name="time" defaultValue="08:00" />
            </div>
            <div className="actions">
              <button type="button" className="ghost" onClick={() => setScheduling(null)}>Cancel</button>
              <button className="primary">Schedule</button>
            </div>
          </form>
        </dialog>
      )}
    </div>
  );
}
