import { Router } from 'express';
import { pool } from '../db';
import { requireAuth, requireOffice } from '../auth';

const router = Router();
router.use(requireAuth, requireOffice);

async function refreshBalance(invoiceId: string) {
  const { rows } = await pool.query(
    `UPDATE service.invoices i SET
       balance_due = i.total - COALESCE((SELECT SUM(p.amount) FROM service.payments p WHERE p.invoice_id = i.id), 0),
       status = CASE
         WHEN i.status = 'void' THEN 'void'
         WHEN i.total - COALESCE((SELECT SUM(p.amount) FROM service.payments p WHERE p.invoice_id = i.id), 0) <= 0 THEN 'paid'
         WHEN COALESCE((SELECT SUM(p.amount) FROM service.payments p WHERE p.invoice_id = i.id), 0) > 0 THEN 'partial'
         ELSE i.status END
     WHERE i.id = $1 RETURNING *`, [invoiceId]);
  return rows[0];
}

router.get('/', async (req, res) => {
  const { status, q } = req.query as Record<string, string | undefined>;
  const params: unknown[] = [];
  const where: string[] = [];
  if (status) { params.push(status); where.push(`i.status = $${params.length}`); }
  if (q) {
    params.push(`%${q}%`);
    where.push(`(c.name ILIKE $${params.length} OR i.number::text LIKE $${params.length})`);
  }
  const { rows } = await pool.query(
    `SELECT i.id, i.number, i.status, i.total, i.balance_due, i.issued_on, i.due_on, i.terms,
            c.name AS customer_name, l.name AS location_name, j.number AS job_number
     FROM service.invoices i
     JOIN service.customers c ON c.id = i.customer_id
     LEFT JOIN service.locations l ON l.id = i.location_id
     LEFT JOIN service.jobs j ON j.id = i.job_id
     ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
     ORDER BY i.created_at DESC LIMIT 200`, params);
  res.json(rows);
});

// Create an invoice from a job: lines (parts & labor) come from the job's
// line items; tax can be set/adjusted afterwards. Job moves to 'invoiced'.
router.post('/from-job/:jobId', async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const job = (await client.query(
      'SELECT * FROM service.jobs WHERE id = $1 FOR UPDATE', [req.params.jobId])).rows[0];
    if (!job) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Job not found' }); }
    if (!job.customer_id) { await client.query('ROLLBACK'); return res.status(400).json({ error: 'Job has no customer' }); }
    const existing = (await client.query(
      `SELECT id FROM service.invoices WHERE job_id = $1 AND status != 'void'`, [req.params.jobId])).rows[0];
    if (existing) { await client.query('ROLLBACK'); return res.status(409).json({ error: 'Job already has an invoice' }); }

    const sums = (await client.query(
      `SELECT COALESCE(SUM(qty * unit_price), 0) AS subtotal
       FROM service.job_lines WHERE job_id = $1`, [req.params.jobId])).rows[0];
    const terms = (await client.query(
      'SELECT credit_terms FROM service.customers WHERE id = $1', [job.customer_id])).rows[0]?.credit_terms
      || 'DUE ON RECEIPT';
    const tax = Number(req.body?.tax) || 0;
    const subtotal = Number(sums.subtotal);
    const invoice = (await client.query(
      `INSERT INTO service.invoices
         (customer_id, location_id, job_id, agreement_id, status, terms, customer_po,
          subtotal, tax, total, balance_due, issued_on, due_on)
       VALUES ($1,$2,$3,$4,'draft',$5,$6,$7::numeric,$8::numeric,
               $7::numeric+$8::numeric,$7::numeric+$8::numeric,CURRENT_DATE,CURRENT_DATE)
       RETURNING *`,
      [job.customer_id, job.location_id, job.id, job.agreement_id, terms, job.customer_po, subtotal, tax]
    )).rows[0];
    await client.query(`UPDATE service.jobs SET status = 'invoiced' WHERE id = $1`, [job.id]);
    await client.query('COMMIT');
    res.status(201).json(invoice);
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
});

router.get('/:id', async (req, res) => {
  const invoice = (await pool.query(
    `SELECT i.*, c.name AS customer_name, c.esc_account_no,
            c.billing_address1, c.billing_city, c.billing_state, c.billing_zip,
            l.name AS location_name, l.address1 AS location_address, l.city AS location_city,
            l.state AS location_state, l.zip AS location_zip,
            j.number AS job_number, j.summary AS job_summary
     FROM service.invoices i
     JOIN service.customers c ON c.id = i.customer_id
     LEFT JOIN service.locations l ON l.id = i.location_id
     LEFT JOIN service.jobs j ON j.id = i.job_id
     WHERE i.id = $1`, [req.params.id])).rows[0];
  if (!invoice) return res.status(404).json({ error: 'Invoice not found' });
  const [lines, payments] = await Promise.all([
    invoice.job_id
      ? pool.query('SELECT * FROM service.job_lines WHERE job_id = $1 ORDER BY created_at', [invoice.job_id])
      : Promise.resolve({ rows: [] }),
    pool.query('SELECT * FROM service.payments WHERE invoice_id = $1 ORDER BY received_on', [req.params.id]),
  ]);
  res.json({ ...invoice, lines: lines.rows, payments: payments.rows });
});

router.patch('/:id', async (req, res) => {
  const allowed = ['status', 'terms', 'customer_po', 'tax', 'issued_on', 'due_on'];
  const sets: string[] = [];
  const params: unknown[] = [];
  for (const f of allowed) {
    if (f in (req.body || {})) { params.push(req.body[f]); sets.push(`${f} = $${params.length}`); }
  }
  if (!sets.length) return res.status(400).json({ error: 'Nothing to update' });
  if ('tax' in (req.body || {})) sets.push('total = subtotal + tax');
  params.push(req.params.id);
  const updated = (await pool.query(
    `UPDATE service.invoices SET ${sets.join(', ')} WHERE id = $${params.length} RETURNING id`, params)).rows[0];
  if (!updated) return res.status(404).json({ error: 'Invoice not found' });
  res.json(await refreshBalance(req.params.id));
});

router.post('/:id/payments', async (req, res) => {
  const { method, amount, reference, received_on } = req.body || {};
  if (!amount || Number(amount) <= 0) return res.status(400).json({ error: 'Payment amount required' });
  await pool.query(
    `INSERT INTO service.payments (invoice_id, method, amount, reference, received_on)
     VALUES ($1,COALESCE($2,'check'),$3,$4,COALESCE($5,CURRENT_DATE))`,
    [req.params.id, method, amount, reference, received_on]);
  res.status(201).json(await refreshBalance(req.params.id));
});

export default router;
