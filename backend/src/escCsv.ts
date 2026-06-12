/**
 * Importer for the full ESC SQL-Server export (one CSV per ESC table, produced
 * by the on-site Claude Code export per docs/ESC_EXPORT_BRIEFING.md).
 *
 * Files are UTF-8 with BOM, CRLF, RFC-4180 quoting. ESC keys (CustNo 7-digit,
 * LocNo 5-digit, AgrmtNo 7-digit, equipment Counter) are kept verbatim as text
 * and drive idempotent upserts, so re-uploads and partial re-runs are safe.
 *
 * Table is auto-detected from the header fingerprint. Dependency order:
 *   customers -> locations -> agreements -> agreement_recurrence ->
 *   agreement_tasks -> equipment
 * (recurrence is staged raw; tasks join it for next-due dates. equipment can
 * also run before agreements — the agreement link is re-tried on both sides.)
 */
import { PoolClient } from 'pg';
import { pool } from './db';

// ── CSV (RFC-4180: quoted fields, doubled quotes, embedded newlines) ────────
export function parseCsv(text: string): string[][] {
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; }
        else inQuotes = false;
      } else field += c;
    } else if (c === '"') {
      inQuotes = true;
    } else if (c === ',') {
      row.push(field); field = '';
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(field); field = '';
      if (row.length > 1 || row[0] !== '') rows.push(row);
      row = [];
    } else field += c;
  }
  if (field !== '' || row.length) { row.push(field); rows.push(row); }
  return rows;
}

export type Rec = Record<string, string>;

function toRecords(rows: string[][]): { headers: string[]; records: Rec[] } {
  const headers = rows[0].map((h) => h.trim());
  const records = rows.slice(1).map((r) => {
    const rec: Rec = {};
    headers.forEach((h, i) => { rec[h] = (r[i] ?? '').trim(); });
    return rec;
  });
  return { headers, records };
}

// ── Table detection by header fingerprint ────────────────────────────────────
const FINGERPRINTS: [string, string[]][] = [
  ['esc_customers',   ['CustNo', 'lblPhone1', 'CustomerInactive']],
  ['esc_locations',   ['CustNo', 'LocNo', 'TaxCode', 'LocName']],
  ['esc_agreements',  ['AgrmtNo', 'AgrmtType', 'ContrAmt']],
  ['esc_agreement_tasks', ['AgrmtNo', 'Task', 'Level', 'LongDesc']],
  ['esc_recurrence',  ['TransID', 'RecurType', 'NextDate']],
  ['esc_equipment',   ['CustNo', 'LocNo', 'Mfg', 'Serial', 'EqType']],
  ['esc_dispatches',  ['CustNo', 'LocNo', 'Dispatch', 'RecDate', 'Priority']],
  ['esc_invoices',    ['Invoice', 'CustNo', 'InvDate', 'InvAmount', 'InvType']],
  ['esc_invoice_lines', ['Invoice', 'Prod', 'Quan', 'PType']],
  ['esc_payments',    ['Invoice', 'CustNo', 'CkNo', 'PayMethod']],
  ['esc_receivables', ['Invoice', 'CustNo', 'InvAmt', 'PaidOff']],
];

// High-volume tables we don't stage into import_rows (no cross-file joins need them).
const NO_STAGE = new Set(['esc_dispatches', 'esc_invoices', 'esc_invoice_lines', 'esc_payments', 'esc_receivables']);

export function detectTable(headers: string[]): string | null {
  const set = new Set(headers);
  for (const [table, needed] of FINGERPRINTS) {
    if (needed.every((h) => set.has(h))) return table;
  }
  return null;
}

// ── Field helpers ────────────────────────────────────────────────────────────
const dateOf = (v?: string) => (v && v.length >= 10 ? v.slice(0, 10) : null);
const isInactive = (v?: string) => !!v && v !== '0';
const numOf = (v?: string) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

const PHONE_LABELS = new Set([
  'work', 'home', 'fax', 'cellular', 'cell', 'phone', 'mobile', 'alt phone',
  'office', 'pager', 'other', 'main', 'alt',
]);
const isLabel = (v: string) => PHONE_LABELS.has(v.toLowerCase());
const normLabel = (v: string) => v.toLowerCase().replace(/\s+/g, '_');

/** phones jsonb from parallel number/label columns, deduping label keys. */
function buildPhones(pairs: [string | undefined, string | undefined][]): Record<string, string> {
  const phones: Record<string, string> = {};
  let generic = 0;
  for (const [num, label] of pairs) {
    if (!num) continue;
    let key = label && isLabel(label) ? normLabel(label) : (generic++ ? `phone_${generic}` : 'phone');
    while (key in phones) key += '_2';
    phones[key] = num;
  }
  return phones;
}

function planFromTask(code: string): string | null {
  const c = code.toUpperCase();
  if (c.includes('SILVER')) return 'Silver';
  if (c.includes('GOLD')) return 'Gold';
  if (c.includes('PLAT')) return 'Platinum';
  return null;
}

/**
 * ESC's ContrPer is the contract TERM ("1 Year", "3 Year"), not a billing
 * frequency — the term is already captured by the contract/expiration dates.
 * Only explicitly periodic values map to a billing frequency.
 */
function billingFreq(contrPer: string): string | null {
  const p = contrPer.toLowerCase();
  if (/^1\s*year|^annual/.test(p)) return 'annual';
  if (/6\s*month|semi/.test(p)) return 'semiannual';
  if (/3\s*month|quarter/.test(p)) return 'quarterly';
  if (/^1\s*month|^monthly/.test(p)) return 'monthly';
  return null;
}

// ESC's Location.Notes is a general free-text field staff filled with contacts,
// equipment specs, history AND access info. Keep the whole thing as notes, and
// lift only genuine access lines (gate codes etc.) into access_notes.
const ACCESS_RE = /gate\s*code|lock\s*box|key\s*(?:code|pad|box)|alarm\s*code|combo|access\s*code|gate\b/i;
function splitNotes(blob?: string): { notes: string | null; access: string | null } {
  if (!blob || !blob.trim()) return { notes: null, access: null };
  const access = blob.split(/\r?\n/).map((l) => l.trim())
    .filter((l) => l && ACCESS_RE.test(l));
  return { notes: blob.trim(), access: access.length ? access.join('\n') : null };
}

const KW_RE = /(\d+(?:\.\d+)?)\s*k\s*w\b/i;
function extractKw(...fields: (string | undefined)[]): number | null {
  for (const f of fields) {
    const m = f && KW_RE.exec(f);
    if (m) return Number(m[1]);
  }
  return null;
}

// Map an ESC dispatch to a service job type from its priority / agreement link.
function dispatchType(priority: string, hasAgreement: boolean): string {
  const p = priority.toUpperCase();
  if (/INSTAL/.test(p)) return 'install';
  if (/STRTUP|START/.test(p)) return 'install';
  if (/WARR/.test(p)) return 'warranty';
  if (/SER\s*A|PM|MAINT/.test(p) || hasAgreement) return 'pm';
  if (/CALL\s*BACK|CALLBACK/.test(p)) return 'callback';
  return 'repair';
}

function summaryFromNotes(notes: string, dispatchNo: string): string {
  const firstLine = (notes || '').split(/\r?\n/).map((s) => s.trim()).find(Boolean);
  if (!firstLine) return `ESC dispatch ${dispatchNo}`;
  return firstLine.length > 140 ? firstLine.slice(0, 140) + '…' : firstLine;
}

// ESC SalesLed PType: M=material, L=labor, H=helper labor, A/C/other=flat.
function lineKind(ptype: string): string {
  const p = ptype.toUpperCase();
  if (p === 'L' || p === 'H') return 'labor';
  if (p === 'M') return 'part';
  return 'flat';
}

async function invoiceHistoryMap(client: PoolClient): Promise<Map<string, string>> {
  const { rows } = await client.query(
    'SELECT id, esc_invoice_no FROM service.invoice_history WHERE esc_invoice_no IS NOT NULL');
  return new Map(rows.map((r) => [r.esc_invoice_no, r.id]));
}

function equipKind(eqType: string, model: string): string {
  const t = `${eqType} ${model}`.toLowerCase();
  if (/\bats\b|transfer/.test(t)) return 'ats';
  if (/pump/.test(t)) return 'pump';
  if (/engine|marine|panel/.test(t)) return /panel/.test(t) ? 'panel' : 'other';
  return 'generator';
}

// ── Lookup maps (loaded once per import call) ───────────────────────────────
async function customerMap(client: PoolClient): Promise<Map<string, string>> {
  const { rows } = await client.query(
    'SELECT id, esc_account_no FROM service.customers WHERE esc_account_no IS NOT NULL');
  return new Map(rows.map((r) => [r.esc_account_no, r.id]));
}
async function locationMap(client: PoolClient): Promise<Map<string, string>> {
  const { rows } = await client.query(
    `SELECT l.id, c.esc_account_no, l.esc_location_no
     FROM service.locations l JOIN service.customers c ON c.id = l.customer_id
     WHERE c.esc_account_no IS NOT NULL AND l.esc_location_no IS NOT NULL`);
  return new Map(rows.map((r) => [`${r.esc_account_no}|${r.esc_location_no}`, r.id]));
}
async function agreementMap(client: PoolClient): Promise<Map<string, string>> {
  const { rows } = await client.query(
    'SELECT id, esc_agreement_no FROM service.agreements WHERE esc_agreement_no IS NOT NULL');
  return new Map(rows.map((r) => [r.esc_agreement_no, r.id]));
}

export interface ImportOutcome {
  table: string;
  imported: number;
  errors: { row: number; key: string; error: string }[];
}

/** Import one detected ESC CSV. Caller owns the transaction. */
export async function importEscTable(
  client: PoolClient, batchId: string, table: string, records: Rec[]
): Promise<ImportOutcome> {
  const out: ImportOutcome = { table, imported: 0, errors: [] };
  const fail = (i: number, key: string, error: string) => {
    if (out.errors.length < 50) out.errors.push({ row: i + 2, key, error });
  };

  if (table === 'esc_customers') {
    for (let i = 0; i < records.length; i++) {
      const r = records[i];
      if (!r.CustNo) continue;
      const name = [r.FirstName, r.LastName].filter(Boolean).join(' ').trim() || r.FullName || r.CustNo;
      const phones = buildPhones([
        [r.Phone1, r.lblPhone1], [r.Phone2, r.lblPhone2],
        [r.Phone3, r.lblPhone3], [r.Phone4, r.lblPhone4],
      ]);
      await client.query(
        `INSERT INTO service.customers (esc_account_no, name, billing_address1, billing_address2,
           billing_city, billing_state, billing_zip, phones, credit_terms, status)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9,$10)
         ON CONFLICT (esc_account_no) DO UPDATE SET
           name = EXCLUDED.name,
           billing_address1 = COALESCE(NULLIF(EXCLUDED.billing_address1,''), service.customers.billing_address1),
           billing_address2 = COALESCE(NULLIF(EXCLUDED.billing_address2,''), service.customers.billing_address2),
           billing_city  = COALESCE(NULLIF(EXCLUDED.billing_city,''),  service.customers.billing_city),
           billing_state = COALESCE(NULLIF(EXCLUDED.billing_state,''), service.customers.billing_state),
           billing_zip   = COALESCE(NULLIF(EXCLUDED.billing_zip,''),   service.customers.billing_zip),
           phones = service.customers.phones || EXCLUDED.phones,
           credit_terms = COALESCE(NULLIF(EXCLUDED.credit_terms,''), service.customers.credit_terms),
           status = EXCLUDED.status`,
        [r.CustNo, name, r.Add1 || null, r.Add2 || null, r.City || null, r.State || null,
         r.Zip || null, JSON.stringify(phones), r.Terms || null,
         isInactive(r.CustomerInactive) ? 'inactive' : 'active']);
      out.imported++;
    }

  } else if (table === 'esc_locations') {
    const customers = await customerMap(client);
    for (let i = 0; i < records.length; i++) {
      const r = records[i];
      if (!r.CustNo || !r.LocNo) continue;
      const customerId = customers.get(r.CustNo);
      if (!customerId) { fail(i, `${r.CustNo}/${r.LocNo}`, 'parent customer not imported'); continue; }
      // ESC stores the phone labels in the Contact1-6 columns; a Contact value
      // that isn't a label is an actual contact person.
      const contactVals = [r.Contact, r.Contact2, r.Contact3, r.Contact4, r.Contact5, r.Contact6];
      const phones = buildPhones([
        [r.Phone1, contactVals[0]], [r.Phone2, contactVals[1]], [r.Phone3, contactVals[2]],
        [r.Phone4, contactVals[3]], [r.Phone5, contactVals[4]], [r.Phone6, contactVals[5]],
      ]);
      if (r.Fax && !Object.values(phones).includes(r.Fax)) phones.fax = phones.fax || r.Fax;
      const contactName = contactVals.find((v) => v && !isLabel(v)) || null;
      const email = [r.Email, r.Email2, r.Email3, r.Email4].find(Boolean) || null;
      const { notes, access } = splitNotes(r.Notes);
      await client.query(
        `INSERT INTO service.locations (customer_id, esc_location_no, name, address1, address2,
           city, state, zip, access_notes, notes, contact_name, phones, email, tax_code, status)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12::jsonb,$13,$14,$15)
         ON CONFLICT (customer_id, esc_location_no) DO UPDATE SET
           name = COALESCE(NULLIF(EXCLUDED.name,''), service.locations.name),
           address1 = COALESCE(NULLIF(EXCLUDED.address1,''), service.locations.address1),
           address2 = COALESCE(NULLIF(EXCLUDED.address2,''), service.locations.address2),
           city  = COALESCE(NULLIF(EXCLUDED.city,''),  service.locations.city),
           state = COALESCE(NULLIF(EXCLUDED.state,''), service.locations.state),
           zip   = COALESCE(NULLIF(EXCLUDED.zip,''),   service.locations.zip),
           access_notes = EXCLUDED.access_notes,
           notes = EXCLUDED.notes,
           contact_name = COALESCE(NULLIF(EXCLUDED.contact_name,''), service.locations.contact_name),
           phones = service.locations.phones || EXCLUDED.phones,
           email = COALESCE(NULLIF(EXCLUDED.email,''), service.locations.email),
           tax_code = COALESCE(NULLIF(EXCLUDED.tax_code,''), service.locations.tax_code),
           status = EXCLUDED.status`,
        [customerId, r.LocNo, r.LocName || r.Add1 || null, r.Add1 || null, r.Add2 || null,
         r.City || null, r.State || null, r.Zip || null, access, notes, contactName,
         JSON.stringify(phones), email, r.TaxCode || null,
         isInactive(r.LocationInactive) ? 'inactive' : 'active']);
      out.imported++;
    }

  } else if (table === 'esc_agreements') {
    const customers = await customerMap(client);
    const locations = await locationMap(client);
    for (let i = 0; i < records.length; i++) {
      const r = records[i];
      if (!r.AgrmtNo) continue;
      const customerId = customers.get(r.CustNo);
      if (!customerId) { fail(i, r.AgrmtNo, `customer ${r.CustNo} not imported`); continue; }
      const expired = r.ExpireDate && dateOf(r.ExpireDate)! < new Date().toISOString().slice(0, 10);
      const status = isInactive(r.SAInactive) ? (expired ? 'expired' : 'cancelled')
        : expired ? 'expired' : 'active';
      const notes = [r.Notes, r.ContrPer && !/^1\s*year/i.test(r.ContrPer) ? `Term: ${r.ContrPer}` : null]
        .filter(Boolean).join('\n') || null;
      await client.query(
        `INSERT INTO service.agreements (esc_agreement_no, customer_id, location_id, type_code,
           plan_name, billing_freq, price, original_contract_date, last_renewal_date, expires_on,
           status, notes)
         VALUES ($1,$2,$3,$4,$5,$6,$7::numeric,$8,$9,$10,$11,$12)
         ON CONFLICT (esc_agreement_no) DO UPDATE SET
           customer_id = EXCLUDED.customer_id,
           location_id = COALESCE(EXCLUDED.location_id, service.agreements.location_id),
           type_code = EXCLUDED.type_code,
           plan_name = COALESCE(EXCLUDED.plan_name, service.agreements.plan_name),
           billing_freq = COALESCE(EXCLUDED.billing_freq, service.agreements.billing_freq),
           price = COALESCE(EXCLUDED.price, service.agreements.price),
           original_contract_date = COALESCE(EXCLUDED.original_contract_date, service.agreements.original_contract_date),
           last_renewal_date = COALESCE(EXCLUDED.last_renewal_date, service.agreements.last_renewal_date),
           expires_on = COALESCE(EXCLUDED.expires_on, service.agreements.expires_on),
           status = EXCLUDED.status,
           notes = COALESCE(NULLIF(EXCLUDED.notes,''), service.agreements.notes)`,
        [r.AgrmtNo, customerId, locations.get(`${r.CustNo}|${r.LocNo}`) || null,
         r.AgrmtType || null, r.JobClass || null, billingFreq(r.ContrPer || ''),
         numOf(r.ContrAmt), dateOf(r.OrigContr), dateOf(r.RenewDate), dateOf(r.ExpireDate),
         status, notes]);
      out.imported++;
    }
    // Late-bind: equipment rows staged earlier that referenced these agreements.
    await client.query(
      `INSERT INTO service.agreement_equipment (agreement_id, equipment_id)
       SELECT a.id, e.id
       FROM service.import_rows ir
       JOIN service.agreements a ON a.esc_agreement_no = ir.raw->>'SerAgrNo'
       JOIN service.locations l  ON l.esc_location_no = ir.raw->>'LocNo'
       JOIN service.customers c  ON c.id = l.customer_id AND c.esc_account_no = ir.raw->>'CustNo'
       JOIN service.equipment e  ON e.location_id = l.id AND e.esc_counter = ir.raw->>'Counter'
       WHERE ir.row_kind = 'esc_equipment' AND COALESCE(ir.raw->>'SerAgrNo','') != ''
       ON CONFLICT DO NOTHING`);

  } else if (table === 'esc_recurrence') {
    // Staged raw only — agreement_tasks joins on it for next-due dates.
    out.imported = records.length;

  } else if (table === 'esc_agreement_tasks') {
    const agreements = await agreementMap(client);
    // AgrmtNo -> RecurSchedID from the staged agreements upload.
    const sched = (await client.query(
      `SELECT raw->>'AgrmtNo' AS no, raw->>'RecurSchedID' AS sid
       FROM service.import_rows WHERE row_kind = 'esc_agreements'
         AND COALESCE(raw->>'RecurSchedID','') != ''`)).rows;
    const schedByNo = new Map(sched.map((s) => [s.no, s.sid]));
    // (TransID|TaskCode) -> recurrence row.
    const recur = (await client.query(
      `SELECT raw FROM service.import_rows WHERE row_kind = 'esc_recurrence'`)).rows;
    const recurMap = new Map<string, Rec>();
    for (const { raw } of recur) recurMap.set(`${raw.TransID}|${raw.Task}`, raw);

    const MONTHS = ['RecurJan','RecurFeb','RecurMar','RecurApr','RecurMay','RecurJun',
                    'RecurJul','RecurAug','RecurSep','RecurOct','RecurNov','RecurDec'];
    for (let i = 0; i < records.length; i++) {
      const r = records[i];
      if (!r.AgrmtNo || !r.Task) continue;
      const agreementId = agreements.get(r.AgrmtNo);
      if (!agreementId) { fail(i, r.AgrmtNo, 'agreement not imported'); continue; }
      const rec = recurMap.get(`${schedByNo.get(r.AgrmtNo)}|${r.Task}`);
      let nextDue: string | null = null;
      let intervalMonths: number | null = null;
      if (rec) {
        nextDue = dateOf(rec.NextDate);
        const activeMonths = MONTHS.filter((m) => rec[m] && rec[m] !== '0').length;
        if (activeMonths > 0) intervalMonths = Math.round(12 / activeMonths);
      }
      const checklist = (r.LongDesc || '').split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
      const kind = r.Level === '1' ? 'major' : 'minor';
      await client.query(
        `INSERT INTO service.agreement_tasks
           (agreement_id, esc_key, name, kind, interval_months, next_due_on, checklist)
         VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb)
         ON CONFLICT (agreement_id, esc_key) WHERE esc_key IS NOT NULL DO UPDATE SET
           name = EXCLUDED.name, kind = EXCLUDED.kind,
           interval_months = COALESCE(EXCLUDED.interval_months, service.agreement_tasks.interval_months),
           next_due_on = COALESCE(EXCLUDED.next_due_on, service.agreement_tasks.next_due_on),
           checklist = EXCLUDED.checklist`,
        // Task is the row's own code (component sections like "IN ENG");
        // MasterTask is the parent visit code — wrong as a section name.
        [agreementId, `${r.Counter || i}-${r.Task}`, r.Task || r.MasterTask, kind,
         intervalMonths, nextDue, JSON.stringify(checklist)]);
      const plan = planFromTask(`${r.MasterTask} ${r.Task}`);
      if (plan) {
        await client.query(
          `UPDATE service.agreements SET plan_name = $1 WHERE id = $2 AND plan_name IS NULL`,
          [plan, agreementId]);
      }
      out.imported++;
    }

  } else if (table === 'esc_equipment') {
    const locations = await locationMap(client);
    const agreements = await agreementMap(client);
    for (let i = 0; i < records.length; i++) {
      const r = records[i];
      if (!r.CustNo || !r.LocNo || !r.Counter) continue;
      const locationId = locations.get(`${r.CustNo}|${r.LocNo}`);
      if (!locationId) { fail(i, `${r.CustNo}/${r.LocNo}#${r.Counter}`, 'location not imported'); continue; }
      const customs = [r.Custom1, r.Custom2, r.Custom3, r.Custom4,
                       r.Custom5, r.Custom6, r.Custom7, r.Custom8];
      const kw = extractKw(r.Custom8, r.Model, r.EqType, r.Code, r.Notes, ...customs);
      const notes = [r.EquipLoc, r.Notes, r.EqType, ...customs.filter(Boolean)]
        .filter(Boolean).join('\n') || null;
      const eq = (await client.query(
        `INSERT INTO service.equipment (location_id, esc_counter, kind, manufacturer, model,
           serial, kw, install_date, warranty_expires, notes)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
         ON CONFLICT (location_id, esc_counter) WHERE esc_counter IS NOT NULL DO UPDATE SET
           kind = EXCLUDED.kind,
           manufacturer = COALESCE(NULLIF(EXCLUDED.manufacturer,''), service.equipment.manufacturer),
           model  = COALESCE(NULLIF(EXCLUDED.model,''),  service.equipment.model),
           serial = COALESCE(NULLIF(EXCLUDED.serial,''), service.equipment.serial),
           kw = COALESCE(EXCLUDED.kw, service.equipment.kw),
           install_date = COALESCE(EXCLUDED.install_date, service.equipment.install_date),
           warranty_expires = COALESCE(EXCLUDED.warranty_expires, service.equipment.warranty_expires),
           notes = COALESCE(EXCLUDED.notes, service.equipment.notes)
         RETURNING id`,
        [locationId, r.Counter, equipKind(r.EqType || '', r.Model || ''),
         r.Mfg?.trim() || null, r.Model?.trim() || null, r.Serial?.trim() || null, kw,
         dateOf(r.Install), dateOf(r.Warranty), notes])).rows[0];
      const agreementId = r.SerAgrNo ? agreements.get(r.SerAgrNo) : null;
      if (agreementId) {
        await client.query(
          `INSERT INTO service.agreement_equipment (agreement_id, equipment_id)
           VALUES ($1,$2) ON CONFLICT DO NOTHING`, [agreementId, eq.id]);
      }
      out.imported++;
    }
  } else if (table === 'esc_dispatches') {
    const customers = await customerMap(client);
    const locations = await locationMap(client);
    const agreements = await agreementMap(client);
    const CHUNK = 400;
    for (let i = 0; i < records.length; i += CHUNK) {
      const slice = records.slice(i, i + CHUNK);
      const values: string[] = [];
      const params: unknown[] = [];
      for (const r of slice) {
        if (!r.Dispatch || !r.CustNo) continue;
        const customerId = customers.get(r.CustNo);
        if (!customerId) { fail(i, r.Dispatch, `customer ${r.CustNo} not imported`); continue; }
        const escDispatchNo = r.Dispatch;
        const p = (params.length);
        params.push(
          escDispatchNo,                                            // esc_dispatch_no
          customerId,                                               // customer_id
          locations.get(`${r.CustNo}|${r.LocNo}`) || null,          // location_id
          r.ServAgrNum ? agreements.get(r.ServAgrNum) || null : null, // agreement_id
          r.ServAgrNum || null,                                     // esc_agreement_no
          dispatchType(r.Priority || '', !!r.ServAgrNum),           // type
          r.Priority || null,                                       // priority
          dateOf(r.RecDate),                                        // received_date
          dateOf(r.Complete),                                       // completed_date
          r.Invoice || null,                                        // invoice_no
          summaryFromNotes(r.Notes || '', escDispatchNo),           // summary
          r.Notes || null                                           // notes
        );
        values.push(`($${p + 1},$${p + 2},$${p + 3},$${p + 4},$${p + 5},$${p + 6},$${p + 7},$${p + 8}::date,$${p + 9}::date,$${p + 10},$${p + 11},$${p + 12})`);
      }
      if (!values.length) continue;
      await client.query(
        `INSERT INTO service.dispatch_history
           (esc_dispatch_no, customer_id, location_id, agreement_id, esc_agreement_no,
            type, priority, received_date, completed_date, invoice_no, summary, notes)
         VALUES ${values.join(',')}
         ON CONFLICT (esc_dispatch_no) DO UPDATE SET
           customer_id = EXCLUDED.customer_id,
           location_id = COALESCE(EXCLUDED.location_id, service.dispatch_history.location_id),
           agreement_id = COALESCE(EXCLUDED.agreement_id, service.dispatch_history.agreement_id),
           esc_agreement_no = EXCLUDED.esc_agreement_no,
           type = EXCLUDED.type, priority = EXCLUDED.priority,
           received_date = EXCLUDED.received_date, completed_date = EXCLUDED.completed_date,
           invoice_no = EXCLUDED.invoice_no, summary = EXCLUDED.summary, notes = EXCLUDED.notes`,
        params);
      out.imported += values.length;
    }

  } else if (table === 'esc_invoices') {
    const customers = await customerMap(client);
    const locations = await locationMap(client);
    const agreements = await agreementMap(client);
    for (let i = 0; i < records.length; i++) {
      const r = records[i];
      if (!r.Invoice || !r.CustNo) continue;
      const customerId = customers.get(r.CustNo);
      if (!customerId) { fail(i, r.Invoice, `customer ${r.CustNo} not imported`); continue; }
      await client.query(
        `INSERT INTO service.invoice_history
           (esc_invoice_no, customer_id, location_id, agreement_id, esc_dispatch_no,
            inv_date, due_date, inv_type, po_num, terms, amount)
         VALUES ($1,$2,$3,$4,$5,$6::date,$7::date,$8,$9,$10,COALESCE($11::numeric,0))
         ON CONFLICT (esc_invoice_no) DO UPDATE SET
           customer_id = EXCLUDED.customer_id,
           location_id = COALESCE(EXCLUDED.location_id, service.invoice_history.location_id),
           agreement_id = COALESCE(EXCLUDED.agreement_id, service.invoice_history.agreement_id),
           esc_dispatch_no = COALESCE(EXCLUDED.esc_dispatch_no, service.invoice_history.esc_dispatch_no),
           inv_date = EXCLUDED.inv_date, due_date = EXCLUDED.due_date,
           inv_type = EXCLUDED.inv_type, po_num = EXCLUDED.po_num, terms = EXCLUDED.terms,
           amount = EXCLUDED.amount`,
        [r.Invoice, customerId, locations.get(`${r.CustNo}|${r.LocNo}`) || null,
         r.AgrmtNo ? agreements.get(r.AgrmtNo) || null : null, r.Dispatch || null,
         dateOf(r.InvDate), dateOf(r.DueDate), r.InvType || null, r.PONum || null,
         r.SlTerms || null, numOf(r.InvAmount)]);
      out.imported++;
    }

  } else if (table === 'esc_invoice_lines') {
    const invoices = await invoiceHistoryMap(client);
    for (let i = 0; i < records.length; i++) {
      const r = records[i];
      if (!r.Invoice) continue;
      const invId = invoices.get(r.Invoice);
      if (!invId) { fail(i, r.Invoice, 'invoice not imported'); continue; }
      await client.query(
        `INSERT INTO service.invoice_history_lines
           (invoice_history_id, esc_line_no, kind, prod, description, qty, unit_price, amount, cost, serial)
         VALUES ($1,$2,$3,$4,$5,$6::numeric,$7::numeric,$8::numeric,$9::numeric,$10)
         ON CONFLICT (invoice_history_id, esc_line_no) DO UPDATE SET
           kind = EXCLUDED.kind, prod = EXCLUDED.prod, description = EXCLUDED.description,
           qty = EXCLUDED.qty, unit_price = EXCLUDED.unit_price, amount = EXCLUDED.amount,
           cost = EXCLUDED.cost, serial = EXCLUDED.serial`,
        [invId, r.Count || String(i), lineKind(r.PType || ''), r.Prod || null,
         r.Desc || null, numOf(r.Quan), numOf(r.Price), numOf(r.Amount), numOf(r.Cost),
         r.Serial || null]);
      out.imported++;
    }

  } else if (table === 'esc_payments') {
    const customers = await customerMap(client);
    for (let i = 0; i < records.length; i++) {
      const r = records[i];
      if (!r.Invoice && !r.CustNo) continue;
      await client.query(
        `INSERT INTO service.payment_history
           (esc_entry_id, customer_id, esc_invoice_no, amount, method, check_no, check_date, notes)
         VALUES ($1,$2,$3,COALESCE($4::numeric,0),$5,$6,$7::date,$8)
         ON CONFLICT (esc_entry_id) DO UPDATE SET
           customer_id = EXCLUDED.customer_id, esc_invoice_no = EXCLUDED.esc_invoice_no,
           amount = EXCLUDED.amount, method = EXCLUDED.method,
           check_no = EXCLUDED.check_no, check_date = EXCLUDED.check_date, notes = EXCLUDED.notes`,
        [r.EntryID || `${r.Invoice}-${r.Counter || i}`, customers.get(r.CustNo) || null,
         r.Invoice || null, numOf(r.Amount), r.PayMethod || null, r.CkNo || null,
         dateOf(r.CkDate), r.Notes || null]);
      out.imported++;
    }

  } else if (table === 'esc_receivables') {
    // The AR ledger: paid amounts + paid-off dates per invoice. Creates a
    // minimal invoice record when Sales didn't include it (e.g. opening AR).
    const customers = await customerMap(client);
    const locations = await locationMap(client);
    for (let i = 0; i < records.length; i++) {
      const r = records[i];
      if (!r.Invoice || !r.CustNo) continue;
      const customerId = customers.get(r.CustNo);
      if (!customerId) { fail(i, r.Invoice, `customer ${r.CustNo} not imported`); continue; }
      await client.query(
        `INSERT INTO service.invoice_history
           (esc_invoice_no, customer_id, location_id, inv_date, amount, paid, paid_off_date)
         VALUES ($1,$2,$3,$4::date,COALESCE($5::numeric,0),COALESCE($6::numeric,0),$7::date)
         ON CONFLICT (esc_invoice_no) DO UPDATE SET
           paid = COALESCE($6::numeric, 0),
           paid_off_date = $7::date,
           amount = CASE WHEN service.invoice_history.amount = 0
                         THEN COALESCE($5::numeric, 0) ELSE service.invoice_history.amount END`,
        [r.Invoice, customerId, locations.get(`${r.CustNo}|${r.LocNo}`) || null,
         dateOf(r.InvDate), numOf(r.InvAmt), numOf(r.Paid), dateOf(r.PaidOff)]);
      out.imported++;
    }

  } else {
    throw new Error(`Unknown table: ${table}`);
  }

  // Stage the raw rows for cross-file joins and auditability (skip high-volume).
  if (records.length && !NO_STAGE.has(table)) {
    const CHUNK = 500;
    for (let i = 0; i < records.length; i += CHUNK) {
      const slice = records.slice(i, i + CHUNK);
      const values: string[] = [];
      const params: unknown[] = [batchId, table];
      for (const rec of slice) {
        params.push(JSON.stringify(rec));
        values.push(`($1, $2, $${params.length}::jsonb, 'imported')`);
      }
      await client.query(
        `INSERT INTO service.import_rows (batch_id, row_kind, raw, status) VALUES ${values.join(',')}`,
        params);
    }
  }
  return out;
}

/** Parse + import one uploaded ESC CSV (own transaction). */
export async function importEscCsv(filename: string, text: string): Promise<ImportOutcome & { batch_id: string }> {
  const rows = parseCsv(text);
  if (rows.length < 2) throw new Error('Empty CSV');
  const { headers, records } = toRecords(rows);
  const table = detectTable(headers);
  if (!table) throw new Error(`Could not recognize this file as an ESC export (headers: ${headers.slice(0, 6).join(', ')}…)`);

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const batch = (await client.query(
      `INSERT INTO service.import_batches (source, filename, stats)
       VALUES ('esc_sql_csv', $1, $2::jsonb) RETURNING id`,
      [filename, JSON.stringify({ table, rows: records.length })])).rows[0];
    const outcome = await importEscTable(client, batch.id, table, records);
    await client.query(
      `UPDATE service.import_batches SET stats = stats || $2::jsonb WHERE id = $1`,
      [batch.id, JSON.stringify({ imported: outcome.imported, errors: outcome.errors.length })]);
    await client.query('COMMIT');
    return { ...outcome, batch_id: batch.id };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}
