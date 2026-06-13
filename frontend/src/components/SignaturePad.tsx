import { useEffect, useRef, useState } from 'react';
import { api } from '../api';

/** Touch/pointer signature pad; saves a PNG data-URL onto the dispatch. */
export default function SignaturePad({ dispatchId, existing, onSaved }: {
  dispatchId: string; existing: string | null; onSaved: () => void;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [drawing, setDrawing] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    if (!open) return;
    const canvas = canvasRef.current!;
    const scale = window.devicePixelRatio || 1;
    canvas.width = canvas.offsetWidth * scale;
    canvas.height = 160 * scale;
    const ctx = canvas.getContext('2d')!;
    ctx.scale(scale, scale);
    ctx.lineWidth = 2;
    ctx.lineCap = 'round';
    ctx.strokeStyle = '#1B2F55';
  }, [open]);

  function pos(e: React.PointerEvent) {
    const r = canvasRef.current!.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  }

  function down(e: React.PointerEvent) {
    e.preventDefault();
    const ctx = canvasRef.current!.getContext('2d')!;
    const p = pos(e);
    ctx.beginPath();
    ctx.moveTo(p.x, p.y);
    setDrawing(true);
    setDirty(true);
  }
  function move(e: React.PointerEvent) {
    if (!drawing) return;
    e.preventDefault();
    const ctx = canvasRef.current!.getContext('2d')!;
    const p = pos(e);
    ctx.lineTo(p.x, p.y);
    ctx.stroke();
  }
  function clear() {
    const c = canvasRef.current!;
    c.getContext('2d')!.clearRect(0, 0, c.width, c.height);
    setDirty(false);
  }
  async function save() {
    await api(`/api/dispatches/${dispatchId}`, {
      method: 'PATCH',
      body: JSON.stringify({ signature: canvasRef.current!.toDataURL('image/png') }),
    });
    setOpen(false);
    onSaved();
  }

  if (existing) {
    return (
      <div className="sig-done">
        ✓ Customer signed
        <img src={existing} alt="signature" style={{ display: 'block', maxHeight: 60, marginTop: 4 }} />
      </div>
    );
  }
  if (!open) {
    return <button className="ghost big" onClick={() => setOpen(true)}>Get Signature</button>;
  }
  return (
    <div className="sig-pad">
      <div className="muted" style={{ fontSize: 12 }}>Customer signs below:</div>
      <canvas
        ref={canvasRef}
        style={{ width: '100%', height: 160, touchAction: 'none' }}
        onPointerDown={down}
        onPointerMove={move}
        onPointerUp={() => setDrawing(false)}
        onPointerLeave={() => setDrawing(false)}
      />
      <div style={{ display: 'flex', gap: 8 }}>
        <button className="ghost" onClick={clear}>Clear</button>
        <button className="primary" disabled={!dirty} onClick={save}>Save Signature</button>
        <button className="ghost" onClick={() => setOpen(false)}>Cancel</button>
      </div>
    </div>
  );
}
