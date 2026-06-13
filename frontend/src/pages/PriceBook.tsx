import { useCallback, useEffect, useState } from 'react';
import { api } from '../api';

interface Item {
  id: string; code: string | null; description: string; kind: string;
  cost: string | null; price: string; active: boolean;
}

export default function PriceBook() {
  const [q, setQ] = useState('');
  const [rows, setRows] = useState<Item[]>([]);
  const [msg, setMsg] = useState('');

  const load = useCallback(() => {
    api<Item[]>(`/api/pricebook?q=${encodeURIComponent(q)}&limit=100`).then(setRows).catch(() => setRows([]));
  }, [q]);
  useEffect(() => { const t = setTimeout(load, 250); return () => clearTimeout(t); }, [load]);

  async function buildFromHistory() {
    const { added } = await api<{ added: number }>('/api/pricebook/build-from-history', { method: 'POST', body: '{}' });
    setMsg(`Imported ${added} items from ESC invoice history.`);
    load();
  }

  async function add(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    await api('/api/pricebook', {
      method: 'POST',
      body: JSON.stringify({
        code: f.get('code'), description: f.get('description'), kind: f.get('kind'),
        cost: Number(f.get('cost')) || null, price: Number(f.get('price')) || 0,
      }),
    });
    e.currentTarget?.reset?.();
    load();
  }

  async function patch(id: string, body: Record<string, unknown>) {
    await api(`/api/pricebook/${id}`, { method: 'PATCH', body: JSON.stringify(body) });
    load();
  }

  return (
    <div className="page">
      <div className="toolbar">
        <h1>Price Book</h1>
        <input type="search" placeholder="Search code or description…" value={q} onChange={(e) => setQ(e.target.value)} />
        <button className="ghost" onClick={buildFromHistory}>Import from ESC history</button>
        <span className="muted">{msg || `${rows.length} items`}</span>
      </div>

      <div className="panel" style={{ padding: 12 }}>
        <form onSubmit={add} style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
          <input name="code" placeholder="Code" style={{ width: 120 }} />
          <input name="description" placeholder="Description" required style={{ flex: 1, minWidth: 200 }} />
          <select name="kind" style={{ width: 90 }}>
            <option value="part">part</option>
            <option value="labor">labor</option>
            <option value="flat">flat</option>
          </select>
          <input name="cost" type="number" step="0.01" placeholder="Cost $" style={{ width: 90 }} />
          <input name="price" type="number" step="0.01" placeholder="Sell $" required style={{ width: 90 }} />
          <button className="primary">Add Item</button>
        </form>
      </div>

      <div className="panel scroll" style={{ flex: 1 }}>
        <table className="grid">
          <thead>
            <tr><th>Code</th><th>Description</th><th>Kind</th><th>Cost</th><th>Sell Price</th><th /></tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.id}>
                <td>{r.code || '—'}</td>
                <td>{r.description}</td>
                <td><span className="chip outline">{r.kind}</span></td>
                <td>{r.cost != null ? `$${Number(r.cost).toFixed(2)}` : '—'}</td>
                <td>
                  <input type="number" step="0.01" defaultValue={Number(r.price)}
                         style={{ width: 90, border: '1px solid var(--border2)', borderRadius: 6, padding: '4px 6px' }}
                         onBlur={(e) => Number(e.target.value) !== Number(r.price) && patch(r.id, { price: Number(e.target.value) })} />
                </td>
                <td><button className="ghost" onClick={() => patch(r.id, { active: false })}>Retire</button></td>
              </tr>
            ))}
            {!rows.length && (
              <tr><td colSpan={6}><div className="empty">
                No items yet — click "Import from ESC history" to seed from your invoices, or add items above.
              </div></td></tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
