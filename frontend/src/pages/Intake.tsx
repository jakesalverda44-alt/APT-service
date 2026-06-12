import { useEffect, useState } from 'react';
import { api, fmtDate } from '../api';

interface IntakeItem {
  id: string;
  crm_project_id: string;
  source_type: 'elec' | 'gen';
  received_at: string;
  payload: { name?: string; contract_value?: string | number; awarded_at?: string };
}

export default function Intake() {
  const [items, setItems] = useState<IntakeItem[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState('');

  const load = () => api<IntakeItem[]>('/api/intake').then(setItems).catch(() => setItems([]));
  useEffect(() => { load(); }, []);

  async function act(item: IntakeItem, action: 'accept' | 'dismiss') {
    setBusy(item.id);
    try {
      const res = await api<{ number?: number; customer_created?: boolean; equipment_created?: boolean }>(
        `/api/intake/${item.id}/${action}`, { method: 'POST', body: '{}' });
      if (action === 'accept' && res.number) {
        const extras = [
          res.customer_created ? 'new customer added' : 'linked to existing customer',
          res.equipment_created ? 'generator equipment recorded' : null,
        ].filter(Boolean).join(', ');
        setMsg(`Job #${res.number} created — ${extras}.`);
      }
      await load();
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="page">
      <div className="toolbar">
        <h1>Project Intake</h1>
        <span className="muted">
          {msg || 'Awarded jobs flow here automatically from the sales CRM. Accept to create a service job (the customer comes across too).'}
        </span>
      </div>
      <div className="panel scroll" style={{ flex: 1 }}>
        <table className="grid">
          <thead>
            <tr><th>Awarded</th><th>Type</th><th>Project</th><th>Value</th><th style={{ width: 200 }} /></tr>
          </thead>
          <tbody>
            {items.map((i) => (
              <tr key={i.id}>
                <td>{fmtDate(i.payload.awarded_at || i.received_at)}</td>
                <td><span className={`chip ${i.source_type === 'gen' ? 'gold' : 'scheduled'}`}>
                  {i.source_type === 'gen' ? 'Generator' : 'Electrical'}
                </span></td>
                <td>{i.payload.name || i.crm_project_id}</td>
                <td>{i.payload.contract_value ? `$${Number(i.payload.contract_value).toLocaleString()}` : '—'}</td>
                <td>
                  <button className="primary" disabled={busy === i.id} onClick={() => act(i, 'accept')}>
                    Accept → Job
                  </button>{' '}
                  <button className="ghost" disabled={busy === i.id} onClick={() => act(i, 'dismiss')}>
                    Dismiss
                  </button>
                </td>
              </tr>
            ))}
            {!items.length && (
              <tr><td colSpan={5}><div className="empty">Queue is empty — new awarded projects appear here on their own.</div></td></tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
