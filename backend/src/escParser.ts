/**
 * Server-side parser for ESC "Customer List Report" PDFs.
 *
 * Port of tools/import/esc_customer_list.py, but instead of emulating a text
 * layout it works on pdfjs text items with native x/y coordinates: phone
 * numbers are matched to the label column (Work/Home/Fax/Cellular vs
 * Phone/Mobile/Alt Phone — varies by record vintage) nearest by x position,
 * gate codes are routed to access notes, and city typos are normalized.
 */

interface Cell { str: string; x: number; w: number }
interface Line { cells: Cell[] }

export interface ParsedCustomer {
  esc_account_no: string;
  name: string;
  address1: string | null;
  address2: string | null;
  city: string | null;
  state: string | null;
  zip: string | null;
  phones: Record<string, string>;
  notes: string | null;
}

export interface ParsedLocation extends Omit<ParsedCustomer, 'esc_account_no' | 'notes'> {
  esc_location_no: string;
  customer_esc_account_no: string;
  access_notes: string | null;
  notes: string | null;
}

export interface ParseResult {
  customers: { customer: ParsedCustomer; locations: ParsedLocation[] }[];
  filters: string[];
  warnings: string[];
}

const LABEL_RE = /Alt Phone|Cellular|Mobile|Work|Home|Fax|Phone/g;
const PHONE_RE = /\d{3}-\d{3}-\d{4}/g;
const CITY_RE = /^(.*?)\s*,\s*([A-Za-z]{2})\.?\s+(\d{5})(?:-\d{4})?$/;
const ACCESS_RE = /gate|code|lock|key|alarm|access|combo|dog/i;
const SKIP_RES = [
  /Customer List Report/,
  /Accurate Power and Technology/,
  /^\s*\d+ of \d+\s*$/,
  /^\s*\d{1,2}\/\d{1,2}\/\d{4}(\s+\d{1,2}:\d{2}\s*[AP]M)?(\s+\d{1,2}\/\d{1,2}\/\d{4})?\s*$/,
  /^\s*\d{1,2}:\d{2}\s*[AP]M\b/,
  /Customer #\s+Customer Name/,
  /Location #\s+Address/,
];
const FILTER_FOOTER_RE = /Inactive\s*=|is between/i;
const CITY_FIXES: Record<string, string> = {
  lesburg: 'Leesburg',
  leeburg: 'Leesburg',
  leeesburg: 'Leesburg',
};

const normalizeLabel = (label: string) => label.toLowerCase().replace(/\s+/g, '_');

function normalizeCity(city: string): string {
  const c = city.replace(/\s+/g, ' ').trim();
  const fixed = CITY_FIXES[c.toLowerCase()];
  if (fixed) return fixed;
  if (c === c.toUpperCase() && /[A-Z]/.test(c)) {
    return c.toLowerCase().replace(/\b\w/g, (m) => m.toUpperCase());
  }
  return c;
}

/** Split a cell on runs of 2+ spaces, interpolating x by character offset. */
function subCells(cell: Cell): Cell[] {
  const out: Cell[] = [];
  const charW = cell.str.length ? cell.w / cell.str.length : 0;
  const re = /\S+(?:\s\S+)*/g; // chunks separated by 2+ spaces
  let m: RegExpExecArray | null;
  while ((m = re.exec(cell.str))) {
    out.push({ str: m[0], x: cell.x + m.index * charW, w: m[0].length * charW });
  }
  return out;
}

/** All matches of `re` within the cell, with interpolated x positions. */
function matchesWithX(cell: Cell, re: RegExp): { text: string; x: number }[] {
  const out: { text: string; x: number }[] = [];
  const charW = cell.str.length ? cell.w / cell.str.length : 0;
  for (const m of cell.str.matchAll(re)) {
    out.push({ text: m[0], x: cell.x + (m.index ?? 0) * charW });
  }
  return out;
}

class Block {
  kind: 'customer' | 'location';
  number: string;
  name = '';
  labels: { label: string; x: number }[] = [];
  labelMin = Number.MAX_SAFE_INTEGER;
  addressLines: string[] = [];
  accessNotes: string[] = [];
  phones: Record<string, string> = {};
  city: string | null = null;
  state: string | null = null;
  zip: string | null = null;

  constructor(kind: 'customer' | 'location', number: string, headerCells: Cell[]) {
    this.kind = kind;
    this.number = number;
    for (const cell of headerCells) {
      const labelHits = matchesWithX(cell, LABEL_RE);
      // The name is the first header cell that isn't itself a label column.
      if (!this.name && cell.str.trim() && !(labelHits.length && labelHits[0].x <= cell.x + 1)) {
        this.name = cell.str.replace(/\s+/g, ' ').trim();
        // A merged trailing label ("Richard WilliamPhone") still counts as a column.
        for (const h of labelHits) this.labels.push({ label: h.text, x: h.x });
        if (labelHits.length) this.name = this.name.slice(0, this.name.length - labelHits.map((h) => h.text).join('').length).trim() || this.name;
        continue;
      }
      for (const h of labelHits) this.labels.push({ label: h.text, x: h.x });
    }
    if (this.labels.length) this.labelMin = Math.min(...this.labels.map((l) => l.x));
  }

  feed(cells: Cell[]): void {
    const leftParts: string[] = [];
    for (const cell of cells) {
      for (const hit of matchesWithX(cell, PHONE_RE)) {
        const label = this.nearestLabel(hit.x);
        if (!(label in this.phones)) this.phones[label] = hit.text;
      }
      if (cell.x < this.labelMin - 4) {
        const text = cell.str.replace(PHONE_RE, '').replace(/\s+/g, ' ').trim();
        if (text) leftParts.push(text);
      }
    }
    const left = leftParts.join(' ').trim();
    if (!left) return;
    const cm = CITY_RE.exec(left);
    if (cm && this.zip === null) {
      this.city = normalizeCity(cm[1]);
      this.state = cm[2].toUpperCase();
      this.zip = cm[3];
    } else if (ACCESS_RE.test(left) && !/^\d/.test(left)) {
      this.accessNotes.push(left);
    } else {
      this.addressLines.push(left);
    }
  }

  private nearestLabel(x: number): string {
    if (!this.labels.length) return 'phone';
    let best = this.labels[0];
    for (const l of this.labels) if (Math.abs(l.x - x) < Math.abs(best.x - x)) best = l;
    return normalizeLabel(best.label);
  }

  raw(): Omit<ParsedCustomer, 'esc_account_no'> {
    const extra = this.addressLines.slice(2);
    return {
      name: this.name,
      address1: this.addressLines[0] || null,
      address2: this.addressLines[1] || null,
      city: this.city,
      state: this.state,
      zip: this.zip,
      phones: this.phones,
      notes: extra.length ? extra.join('\n') : null,
    };
  }
}

async function extractLines(data: Uint8Array): Promise<Line[]> {
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const doc = await pdfjs.getDocument({ data, useSystemFonts: true }).promise;
  const lines: Line[] = [];
  for (let p = 1; p <= doc.numPages; p++) {
    const page = await doc.getPage(p);
    const tc = await page.getTextContent();
    const cells: (Cell & { y: number })[] = [];
    for (const item of tc.items) {
      if (!('str' in item) || !item.str.trim()) continue;
      cells.push({ str: item.str, x: item.transform[4], y: item.transform[5], w: item.width });
    }
    // y values carry float jitter (573.96 vs 573.9600001), so group by y with
    // tolerance first, then order each line's cells left-to-right.
    cells.sort((a, b) => b.y - a.y || a.x - b.x);
    let current: (Cell & { y: number })[] = [];
    const flush = () => {
      if (current.length) lines.push({ cells: current.sort((a, b) => a.x - b.x) });
      current = [];
    };
    for (const c of cells) {
      if (current.length && Math.abs(current[0].y - c.y) > 2.5) flush();
      current.push(c);
    }
    flush();
  }
  return lines;
}

export async function parseEscCustomerList(buffer: Buffer): Promise<ParseResult> {
  const lines = await extractLines(new Uint8Array(buffer));
  const customers: ParseResult['customers'] = [];
  const filters: string[] = [];
  const warnings: string[] = [];
  let block: Block | null = null;

  const close = () => {
    if (!block) return;
    if (block.kind === 'customer') {
      const raw = block.raw();
      // Customers have no separate access field — fold access-style lines
      // (rare at the billing level) into notes.
      const notes = [...block.accessNotes, ...(raw.notes ? [raw.notes] : [])].join('\n') || null;
      customers.push({
        customer: { esc_account_no: block.number, ...raw, notes },
        locations: [],
      });
    } else if (customers.length) {
      const parent = customers[customers.length - 1];
      parent.locations.push({
        esc_location_no: block.number,
        customer_esc_account_no: parent.customer.esc_account_no,
        access_notes: block.accessNotes.length ? block.accessNotes.join('\n') : null,
        ...block.raw(),
      });
    } else {
      warnings.push(`location ${block.number} before any customer — skipped`);
    }
    block = null;
  };

  for (const line of lines) {
    const joined = line.cells.map((c) => c.str).join('  ').trim();
    if (!joined || SKIP_RES.some((re) => re.test(joined))) continue;
    if (FILTER_FOOTER_RE.test(joined)) {
      filters.push(joined);
      continue;
    }
    const subs = line.cells.flatMap(subCells);
    const first = subs[0];
    if (first && /^\d{7}$/.test(first.str)) {
      close();
      block = new Block('customer', first.str, subs.slice(1));
      continue;
    }
    const labelCount = (joined.match(LABEL_RE) || []).length;
    if (first && /^\d{5}$/.test(first.str) && (first.str.startsWith('0') || labelCount >= 2)) {
      close();
      block = new Block('location', first.str, subs.slice(1));
      continue;
    }
    if (block) {
      block.feed(subs);
    } else {
      warnings.push(`unattached line: ${joined.slice(0, 80)}`);
    }
  }
  close();

  return { customers, filters, warnings };
}
