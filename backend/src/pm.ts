import { pool } from './db';

/**
 * Preventive-maintenance engine, ESC-style: every agreement task carries a
 * next-due date; when it comes within the lead window this creates the PM job
 * (one open job per task at a time). Completing the job advances the task and
 * decrements the agreement's major/minor visits-remaining counter — see the
 * completion hook in routes/jobs.ts.
 */
export async function generatePmJobs(leadDays = 14): Promise<number> {
  const { rows } = await pool.query(
    `SELECT t.id AS task_id, t.name, t.kind, t.checklist,
            a.id AS agreement_id, a.customer_id, a.location_id, a.plan_name, a.type_code
     FROM service.agreement_tasks t
     JOIN service.agreements a ON a.id = t.agreement_id
     WHERE a.status = 'active'
       AND (a.expires_on IS NULL OR a.expires_on >= CURRENT_DATE)
       AND t.next_due_on IS NOT NULL
       AND t.next_due_on <= CURRENT_DATE + $1::int
       AND NOT EXISTS (
         SELECT 1 FROM service.jobs j
         WHERE j.agreement_task_id = t.id
           AND j.status NOT IN ('complete','invoiced','cancelled')
       )`,
    [leadDays]
  );

  let created = 0;
  for (const t of rows) {
    const job = (await pool.query(
      `INSERT INTO service.jobs (customer_id, location_id, agreement_id, agreement_task_id,
                                 type, priority, status, summary)
       VALUES ($1,$2,$3,$4,'pm','normal','pending',$5) RETURNING id`,
      [t.customer_id, t.location_id, t.agreement_id, t.task_id,
       `${t.plan_name || t.type_code || 'Maintenance'} — ${t.name} (${t.kind})`]
    )).rows[0];
    const checklist: string[] = Array.isArray(t.checklist) ? t.checklist : [];
    if (checklist.length) {
      await pool.query(
        `INSERT INTO service.job_notes (job_id, author_name, body) VALUES ($1,'PM Scheduler',$2)`,
        [job.id, 'Service checklist:\n' + checklist.map((c) => `• ${c}`).join('\n')]
      );
    }
    created++;
  }
  return created;
}

/** Called when a PM job completes: advance the task, decrement the counter. */
export async function onPmJobComplete(job: {
  agreement_id: string | null;
  agreement_task_id: string | null;
}): Promise<void> {
  if (!job.agreement_task_id) return;
  const task = (await pool.query(
    `UPDATE service.agreement_tasks
     SET next_due_on = CASE WHEN interval_months IS NOT NULL
                            THEN next_due_on + (interval_months || ' months')::interval
                            ELSE NULL END
     WHERE id = $1 RETURNING kind`,
    [job.agreement_task_id]
  )).rows[0];
  if (task && job.agreement_id) {
    const col = task.kind === 'major' ? 'visits_major_remaining' : 'visits_minor_remaining';
    await pool.query(
      `UPDATE service.agreements SET ${col} = GREATEST(${col} - 1, 0)
       WHERE id = $1 AND ${col} IS NOT NULL`,
      [job.agreement_id]
    );
  }
}
