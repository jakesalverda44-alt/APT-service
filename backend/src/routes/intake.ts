import { Router } from 'express';
import { pool } from '../db';
import { requireAuth, requireOffice, AuthRequest } from '../auth';

const router = Router();
router.use(requireAuth, requireOffice);

// Awarded CRM projects waiting to become service jobs.
router.get('/', async (_req, res) => {
  const { rows } = await pool.query(
    `SELECT id, crm_project_id, source_type, payload, received_at
     FROM service.project_intake
     WHERE processed_at IS NULL
     ORDER BY received_at DESC`);
  res.json(rows);
});

const phonesJson = (phone?: string | null) => (phone ? JSON.stringify({ phone }) : '{}');

// Accept: turn an awarded CRM project into a service job, bringing the customer
// across with it. The project links to a public.customers record, so we
// find-or-create the matching service customer (linked by crm_customer_id, or
// matched by exact name and back-linked), create a job-site location from the
// customer/site address, and — for generator awards — seed the equipment
// record from the generator proposal (make/model/kW).
router.post('/:id/accept', async (req: AuthRequest, res) => {
  // Probe which CRM tables exist before opening the transaction (a failed
  // query inside a transaction would abort it, so we can't catch-and-continue).
  const has = async (rel: string) =>
    (await pool.query('SELECT to_regclass($1) IS NOT NULL AS x', [rel])).rows[0].x as boolean;
  const [hasCustomers, hasGens] = await Promise.all([
    has('public.customers'),
    has('public.generator_proposals'),
  ]);

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const intake = (await client.query(
      'SELECT * FROM service.project_intake WHERE id = $1 AND processed_at IS NULL FOR UPDATE',
      [req.params.id])).rows[0];
    if (!intake) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Intake item not found or already processed' });
    }
    const p = intake.payload || {};

    // 1. Resolve the service customer.
    let customerId: string | null = req.body?.customer_id || null;
    let locationId: string | null = req.body?.location_id || null;
    let customerCreated = false;

    if (!customerId && p.customer_id && hasCustomers) {
      const crm = (await client.query(
        'SELECT * FROM public.customers WHERE id = $1', [p.customer_id])).rows[0];
      if (crm) {
        // Already linked from a prior project?
        const linked = (await client.query(
          'SELECT id FROM service.customers WHERE crm_customer_id = $1', [crm.id])).rows[0];
        if (linked) {
          customerId = linked.id;
        } else {
          // Same customer already in the service book (e.g. ESC import) by name?
          // Back-link it so future projects match directly.
          const named = (await client.query(
            'SELECT id FROM service.customers WHERE LOWER(name) = LOWER($1) AND crm_customer_id IS NULL LIMIT 1',
            [crm.company || crm.name])).rows[0];
          if (named) {
            customerId = named.id;
            await client.query(
              'UPDATE service.customers SET crm_customer_id = $1 WHERE id = $2', [crm.id, named.id]);
          } else {
            const created = (await client.query(
              `INSERT INTO service.customers
                 (crm_customer_id, name, billing_address1, billing_city, billing_state, billing_zip,
                  email, phones, notes)
               VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9) RETURNING id`,
              [crm.id, crm.company || crm.name, crm.address, crm.city, crm.state, crm.zip,
               crm.email, phonesJson(crm.phone),
               crm.contact_name ? `Contact: ${crm.contact_name}` : null])).rows[0];
            customerId = created.id;
            customerCreated = true;
          }
        }
      }
    }

    // 2. Resolve the job-site location. The site's identity is the source
    // row's loc text (bids.loc / generator_proposals.loc) — each distinct site
    // is its own location. Only when the CRM gives us no site text do we fall
    // back to the customer's address (and match on that). The billing address
    // is the customer's office, not the job site, so we never stamp it onto a
    // named site location.
    if (!locationId && customerId) {
      const srcTable = intake.source_type === 'gen' ? 'generator_proposals' : 'bids';
      let siteText: string | null = null;
      if (await has(`public.${srcTable}`)) {
        siteText = (await client.query(
          `SELECT loc FROM public.${srcTable} WHERE id = $1`, [intake.crm_project_id])).rows[0]?.loc || null;
      }
      const crm = hasCustomers && p.customer_id
        ? (await client.query('SELECT * FROM public.customers WHERE id = $1', [p.customer_id])).rows[0]
        : null;

      if (siteText) {
        // Distinct named site — reuse only an exact name match.
        const existing = (await client.query(
          'SELECT id FROM service.locations WHERE customer_id = $1 AND LOWER(name) = LOWER($2) LIMIT 1',
          [customerId, siteText])).rows[0];
        locationId = existing
          ? existing.id
          : (await client.query(
              `INSERT INTO service.locations (customer_id, name, contact_name, phones, email)
               VALUES ($1,$2,$3,$4::jsonb,$5) RETURNING id`,
              [customerId, siteText, crm?.contact_name || null, phonesJson(crm?.phone), crm?.email || null]
            )).rows[0].id;
      } else if (crm?.address || crm?.city) {
        // No site text — use the customer address, matched on that address.
        const existing = (await client.query(
          `SELECT id FROM service.locations WHERE customer_id = $1
           AND LOWER(COALESCE(address1,'')) = LOWER(COALESCE($2,'')) LIMIT 1`,
          [customerId, crm.address])).rows[0];
        locationId = existing
          ? existing.id
          : (await client.query(
              `INSERT INTO service.locations
                 (customer_id, name, address1, city, state, zip, contact_name, phones, email)
               VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9) RETURNING id`,
              [customerId, crm.name, crm.address, crm.city, crm.state, crm.zip,
               crm.contact_name || null, phonesJson(crm.phone), crm.email || null]
            )).rows[0].id;
      }
    }

    // 3. Create the job.
    const summary = [
      p.name || `CRM ${intake.source_type === 'gen' ? 'generator' : 'electrical'} project`,
      p.contract_value ? `$${Number(p.contract_value).toLocaleString()}` : null,
    ].filter(Boolean).join(' — ');
    const job = (await client.query(
      `INSERT INTO service.jobs (crm_project_id, type, status, summary, customer_id, location_id, created_by)
       VALUES ($1, 'project', 'pending', $2, $3, $4, $5) RETURNING *`,
      [intake.crm_project_id, summary, customerId, locationId, req.user!.id])).rows[0];

    // 4. For generator awards, seed the equipment record from the proposal.
    let equipmentCreated = false;
    if (intake.source_type === 'gen' && locationId && hasGens) {
      const gen = (await client.query(
        'SELECT mfr, model, kw FROM public.generator_proposals WHERE id = $1',
        [intake.crm_project_id])).rows[0];
      if (gen && (gen.mfr || gen.model || gen.kw)) {
        const eq = (await client.query(
          `INSERT INTO service.equipment (location_id, kind, manufacturer, model, kw)
           VALUES ($1,'generator',$2,$3,$4) RETURNING id`,
          [locationId, gen.mfr, gen.model, gen.kw])).rows[0];
        equipmentCreated = true;
        await client.query('UPDATE service.jobs SET equipment_id = $1 WHERE id = $2', [eq.id, job.id]);
        job.equipment_id = eq.id;
      }
    }

    await client.query(
      'UPDATE service.project_intake SET processed_at = now(), job_id = $1 WHERE id = $2',
      [job.id, intake.id]);
    await client.query('COMMIT');
    res.status(201).json({ ...job, customer_created: customerCreated, equipment_created: equipmentCreated });
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
});

// Dismiss without creating a job (e.g. pure construction work with no service
// component). Kept in the table with processed_at set, so nothing re-queues.
router.post('/:id/dismiss', async (req, res) => {
  const { rowCount } = await pool.query(
    'UPDATE service.project_intake SET processed_at = now() WHERE id = $1 AND processed_at IS NULL',
    [req.params.id]);
  if (!rowCount) return res.status(404).json({ error: 'Intake item not found or already processed' });
  res.json({ ok: true });
});

export default router;
