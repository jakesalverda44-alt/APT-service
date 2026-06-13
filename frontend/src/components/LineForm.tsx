import { useEffect, useRef, useState } from 'react';
import { api } from '../api';

interface PriceItem { id: string; code: string | null; description: string; kind: string; price: string }

/**
 * Shared parts/labor line entry with price-book autocomplete: typing in the
 * description searches the price book; picking a match fills kind and price.
 */
export default function LineForm({ onAdd, compact }: {
  onAdd: (line: { kind: string; description: string; qty: number; unit_price: number }) => Promise<void> | void;
  compact?: boolean;
}) {
  const [kind, setKind] = useState('part');
  const [desc, setDesc] = useState('');
  const [qty, setQty] = useState('1');
  const [price, setPrice] = useState('');
  const [hits, setHits] = useState<PriceItem[]>([]);
  const listId = useRef(`pb-${Math.random().toString(36).slice(2)}`);

  useEffect(() => {
    if (desc.trim().length < 2) return setHits([]);
    const t = setTimeout(() => {
      api<PriceItem[]>(`/api/pricebook?q=${encodeURIComponent(desc)}&limit=8`)
        .then(setHits).catch(() => setHits([]));
    }, 200);
    return () => clearTimeout(t);
  }, [desc]);

  const label = (h: PriceItem) => (h.code ? `${h.code} — ${h.description}` : h.description);

  function onDescChange(v: string) {
    setDesc(v);
    const hit = hits.find((h) => label(h) === v);
    if (hit) {
      setKind(hit.kind);
      setPrice(String(Number(hit.price)));
    }
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!desc.trim()) return;
    await onAdd({ kind, description: desc.trim(), qty: Number(qty) || 1, unit_price: Number(price) || 0 });
    setDesc(''); setQty('1'); setPrice('');
  }

  return (
    <form onSubmit={submit} style={{ display: 'flex', gap: 4, marginTop: 6, flexWrap: compact ? 'wrap' : undefined }}>
      <select value={kind} onChange={(e) => setKind(e.target.value)} style={{ width: 76 }}>
        <option value="labor">labor</option>
        <option value="part">part</option>
        <option value="flat">flat</option>
      </select>
      <input list={listId.current} value={desc} onChange={(e) => onDescChange(e.target.value)}
             placeholder="Description (searches price book)" required
             style={{ flex: 1, minWidth: compact ? 140 : undefined }} />
      <datalist id={listId.current}>
        {hits.map((h) => <option key={h.id} value={label(h)} />)}
      </datalist>
      <input type="number" step="0.25" value={qty} onChange={(e) => setQty(e.target.value)}
             style={{ width: 56 }} aria-label="Qty" />
      <input type="number" step="0.01" value={price} onChange={(e) => setPrice(e.target.value)}
             placeholder="$" style={{ width: 76 }} aria-label="Price" />
      <button className="ghost">Add</button>
    </form>
  );
}
