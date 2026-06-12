import { pool } from './db';

/**
 * Preventive-maintenance engine, ESC-style: every agreement task carries a
 * next-due date; tasks within the lead window generate PM jobs.
 *
 * Real ESC usage (13k dispatches, 7k agreement tasks analyzed): only the
 * visit-level task carries a recurrence date; commercial agreements add one
 * UNDATED task per inspection component (engine, fuel, electrical, cooling,
 * ...) that rides along as checklist sections of the visit. So: dated tasks
 * within the lead window are grouped by (agreement, due date) into ONE job,
 * and the agreement's undated component tasks are merged into that job's
 * checklist. Completing the job advances every dated task in the group and
 * decrements the visit counter once. See the completion hook in routes/jobs.ts.
 */
export async function generatePmJobs(leadDays = 14): Promise<number> {
  const { rows } = await pool.query(
    `SELECT t.id AS task_id, t.name, t.kind, t.checklist, t.next_due_on,
            a.id AS agreement_id, a.customer_id, a.location_id, a.plan_name, a.type_code
     FROM service.agreement_tasks t
     JOIN service.agreements a ON a.id = t.agreement_id
     WHERE a.status = 'active'
       AND (a.expires_on IS NULL OR a.expires_on >= CURRENT_DATE)
       AND t.next_due_on IS NOT NULL
       AND t.next_due_on <= CURRENT_DATE + $1::int
       AND NOT EXISTS (
         SELECT 1 FROM service.jobs j
         WHERE j.agreement_id = a.id
           AND j.type = 'pm'
           AND j.status NOT IN ('complete','invoiced','cancelled')
           AND EXISTS (SELECT 1 FROM service.agreement_tasks t2
                       WHERE t2.id = j.agreement_task_id
                         AND t2.next_due_on = t.next_due_on)
       )
     ORDER BY a.id, t.next_due_on, t.kind DESC, t.name`,
    [leadDays]
  );

  // One visit per agreement per due date.
  const groups = new Map<string, typeof rows>();
  for (const t of rows) {
    const key = `${t.agreement_id}|${t.next_due_on.toISOString().slice(0, 10)}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(t);
  }

  const section = (t: { name: string; checklist: unknown }) => {
    const items: string[] = Array.isArray(t.checklist) ? (t.checklist as string[]) : [];
    if (!items.length) return `■ ${t.name}`;
    return `■ ${t.name}\n` + items.map((c) => `  • ${c}`).join('\n');
  };

  let created = 0;
  for (const tasks of groups.values()) {
    const lead = tasks[0];
    // The agreement's undated component tasks ride along as checklist sections.
    const components = (await pool.query(
      `SELECT name, checklist FROM service.agreement_tasks
       WHERE agreement_id = $1 AND next_due_on IS NULL ORDER BY name`,
      [lead.agreement_id])).rows;

    const kinds = new Set(tasks.map((t) => t.kind));
    const visitKind = kinds.has('major') ? 'major' : 'minor';
    const plan = lead.plan_name || lead.type_code || 'Maintenance';
    const sectionCount = tasks.length + components.length;
    const summary = sectionCount === 1
      ? `${plan} — ${lead.name} (${visitKind})`
      : `${plan} — PM visit, ${sectionCount} checklist sections (${visitKind})`;

    const job = (await pool.query(
      `INSERT INTO service.jobs (customer_id, location_id, agreement_id, agreement_task_id,
                                 type, priority, status, summary)
       VALUES ($1,$2,$3,$4,'pm','normal','pending',$5) RETURNING id`,
      [lead.customer_id, lead.location_id, lead.agreement_id, lead.task_id, summary]
    )).rows[0];

    const sections = [...tasks, ...components].map(section).join('\n');
    await pool.query(
      `INSERT INTO service.job_notes (job_id, author_name, body) VALUES ($1,'PM Scheduler',$2)`,
      [job.id, 'Service checklist:\n' + sections]
    );
    created++;
  }
  return created;
}

/**
 * Called when a PM job completes: advance EVERY task in the visit group (same
 * agreement + same due date as the linked task), each by its own interval,
 * then decrement the agreement's visit counter once.
 */
export async function onPmJobComplete(job: {
  agreement_id: string | null;
  agreement_task_id: string | null;
}): Promise<void> {
  if (!job.agreement_task_id || !job.agreement_id) return;
  const linked = (await pool.query(
    'SELECT kind, next_due_on FROM service.agreement_tasks WHERE id = $1',
    [job.agreement_task_id])).rows[0];
  if (!linked) return;

  await pool.query(
    `UPDATE service.agreement_tasks
     SET next_due_on = CASE WHEN interval_months IS NOT NULL
                            THEN next_due_on + (interval_months || ' months')::interval
                            ELSE NULL END
     WHERE agreement_id = $1
       AND (next_due_on = $2 OR id = $3)`,
    [job.agreement_id, linked.next_due_on, job.agreement_task_id]
  );

  const col = linked.kind === 'major' ? 'visits_major_remaining' : 'visits_minor_remaining';
  await pool.query(
    `UPDATE service.agreements SET ${col} = GREATEST(${col} - 1, 0)
     WHERE id = $1 AND ${col} IS NOT NULL`,
    [job.agreement_id]
  );
}
