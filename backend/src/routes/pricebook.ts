import { Router } from 'express';
import { pool } from '../db';
import { requireAuth, requireOffice } from '../auth';

const router = Router();
router.use(requireAuth);

// Autocomplete + list. Techs can read (field line entry); office maintains.
router.get('/', async (req, res) => {
  const q = String(req.query.q || '').trim();
  const limit = Math.min(Number(req.query.limit) || 20, 100);
  const params: unknown[] = [];
  let where = 'WHERE active';
  if (q) {
    params.push(`%${q}%`);
    where += ` AND (code ILIKE $1 OR description ILIKE $1)`;
  }
  params.push(limit);
  const { rows } = await pool.query(
    `SELECT * FROM service.price_book ${where} ORDER BY code NULLS LAST, description LIMIT $${params.length}`,
    params);
  res.json(rows);
});

router.post('/', requireOffice, async (req, res) => {
  const { code, description, kind, cost, price, taxable } = req.body || {};
  if (!description) return res.status(400).json({ error: 'Description required' });
  const { rows } = await pool.query(
    `INSERT INTO service.price_book (code, description, kind, cost, price, taxable)
     VALUES (NULLIF($1,''),$2,COALESCE($3,'part'),$4::numeric,COALESCE($5::numeric,0),COALESCE($6,true))
     ON CONFLICT (code) DO UPDATE SET
       description = EXCLUDED.description, kind = EXCLUDED.kind,
       cost = EXCLUDED.cost, price = EXCLUDED.price, taxable = EXCLUDED.taxable, active = true
     RETURNING *`,
    [code, description, kind, cost ?? null, price, taxable]);
  res.status(201).json(rows[0]);
});

router.patch('/:id', requireOffice, async (req, res) => {
  const allowed = ['code', 'description', 'kind', 'cost', 'price', 'taxable', 'active'];
  const sets: string[] = [];
  const params: unknown[] = [];
  for (const f of allowed) {
    if (f in (req.body || {})) { params.push(req.body[f]); sets.push(`${f} = $${params.length}`); }
  }
  if (!sets.length) return res.status(400).json({ error: 'Nothing to update' });
  params.push(req.params.id);
  const { rows } = await pool.query(
    `UPDATE service.price_book SET ${sets.join(', ')} WHERE id = $${params.length} RETURNING *`, params);
  if (!rows[0]) return res.status(404).json({ error: 'Item not found' });
  res.json(rows[0]);
});

// Seed from the imported ESC invoice history: latest price/cost per product
// code. Existing codes are left untouched; safe to re-run.
router.post('/build-from-history', requireOffice, async (_req, res) => {
  const { rowCount } = await pool.query(
    `INSERT INTO service.price_book (code, description, kind, cost, price)
     SELECT DISTINCT ON (l.prod)
            l.prod,
            COALESCE(NULLIF(l.description, ''), l.prod),
            COALESCE(l.kind, 'part'),
            l.cost,
            COALESCE(l.unit_price, 0)
     FROM service.invoice_history_lines l
     JOIN service.invoice_history ih ON ih.id = l.invoice_history_id
     WHERE l.prod IS NOT NULL AND l.prod != ''
     ORDER BY l.prod, ih.inv_date DESC NULLS LAST
     ON CONFLICT (code) DO NOTHING`);
  res.json({ added: rowCount });
});

export default router;
