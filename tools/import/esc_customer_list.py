#!/usr/bin/env python3
"""Parse an ESC "Customer List Report" PDF into service-program import files.

ESC prints customers as account-numbered blocks with nested location blocks:

    0002911       Aegies Medical Group         Work         Home   Fax  Cellular
                  711 3rd Street               407-325-2510
                  Leesburg , FL 34748
      00001         Aegies Medical Group       Work         Home   Fax  Cellular
                    711 3rd Street             407-325-2510
                    Leesburg , FL 34748

Phone labels vary by record vintage (Work/Home/Fax/Cellular vs
Phone/Mobile/Alt Phone) and numbers sit *under* their label column, so the
parser maps each number to the nearest label by column position. Stray lines
like "Gate Code 2916" are routed to access notes.

Output (in --out dir):
    rows.csv   batch_id,row_kind,raw-json   -> \\copy into service.import_rows
    load.sql   one-shot psql script: batch insert + \\copy + import_normalize()

Usage:
    python3 esc_customer_list.py "Customer List Report.pdf" --out build/
    psql "$DATABASE_URL" -f build/load.sql

Requires pdftotext (poppler-utils) when given a PDF; .txt input skips it.
Stdlib only; safe to re-run — import_normalize() upserts on ESC numbers.
"""

import argparse
import csv
import json
import re
import subprocess
import sys
import uuid
from pathlib import Path

LABEL_RE = re.compile(r'Alt Phone|Cellular|Mobile|Work|Home|Fax|Phone')
PHONE_RE = re.compile(r'\d{3}-\d{3}-\d{4}')
CUSTOMER_RE = re.compile(r'^(\d{7})\s+(\S.*)$')
LOCATION_RE = re.compile(r'^\s{1,10}(\d{5})\s+(\S.*)$')
CITY_RE = re.compile(r'^(.*?)\s*,\s*([A-Za-z]{2})\.?\s+(\d{5})(?:-\d{4})?$')
ACCESS_RE = re.compile(r'gate|code|lock|key|alarm|access|combo|dog', re.I)
SKIP_RES = [
    re.compile(r'Customer List Report'),
    re.compile(r'Accurate Power and Technology'),
    re.compile(r'^\s*\d+ of \d+\s*$'),
    re.compile(r'^\s*\d{1,2}/\d{1,2}/\d{4}\s*(\d{1,2}:\d{2}\s*[AP]M)?\s*(\d{1,2}/\d{1,2}/\d{4})?\s*$'),
    re.compile(r'^\s*\d{1,2}:\d{2}\s*[AP]M\s*'),
    re.compile(r'^\s*Customer #\s+Customer Name'),
    re.compile(r'^\s*Location #\s+Address'),
]
FILTER_FOOTER_RE = re.compile(r'Inactive\s*=|is between', re.I)
CITY_FIXES = {'lesburg': 'Leesburg', 'leeburg': 'Leesburg', 'leeesburg': 'Leesburg'}


def normalize_label(label: str) -> str:
    return label.lower().replace(' ', '_')


def normalize_city(city: str) -> str:
    city = re.sub(r'\s+', ' ', city).strip()
    fixed = CITY_FIXES.get(city.lower())
    return fixed if fixed else city.title() if city.isupper() else city


def clean_name(text: str) -> str:
    segments = [s for s in re.split(r'\s{2,}', text.strip()) if s]
    if not segments:
        return ''
    name = segments[0]
    # ESC sometimes repeats the contact name as a phantom column header.
    if len(segments) > 1 and segments[1].rstrip('Phone').strip() in (name, ''):
        pass  # repeated name segment is ignored by taking segments[0]
    return re.sub(r'\s+', ' ', name)


class Block:
    """One customer or location block being accumulated."""

    def __init__(self, kind, number, header_line, text_start):
        self.kind = kind
        self.number = number
        self.name = clean_name(header_line[text_start:])
        # Column positions of phone labels on the header line (absolute, in
        # full-line coordinates); numbers on following lines are matched to
        # the nearest label start.
        name_end = text_start + len(self.name)
        self.labels = [(m.group(0), m.start())
                       for m in LABEL_RE.finditer(header_line)
                       if m.start() > name_end]
        self.label_min = min((pos for _, pos in self.labels), default=10**6)
        self.address_lines = []
        self.access_notes = []
        self.phones = {}
        self.city = self.state = self.zip = None

    def feed(self, line: str):
        left = line[:self.label_min].rstrip()
        left_text = PHONE_RE.sub('', left).strip()
        for m in PHONE_RE.finditer(line):
            label = self._nearest_label(m.start())
            self.phones.setdefault(label, m.group(0))
        if not left_text:
            return
        cm = CITY_RE.match(left_text)
        if cm and self.zip is None:
            self.city = normalize_city(cm.group(1))
            self.state = cm.group(2).upper()
            self.zip = cm.group(3)
        elif ACCESS_RE.search(left_text) and not left_text[0].isdigit():
            self.access_notes.append(left_text)
        else:
            self.address_lines.append(left_text)

    def _nearest_label(self, pos: int) -> str:
        if not self.labels:
            return 'phone'
        label, _ = min(self.labels, key=lambda lp: abs(lp[1] - pos))
        return normalize_label(label)

    def raw(self, customer_no=None) -> dict:
        d = {
            'name': self.name,
            'address1': self.address_lines[0] if self.address_lines else None,
            'address2': self.address_lines[1] if len(self.address_lines) > 1 else None,
            'city': self.city or None, 'state': self.state, 'zip': self.zip,
            'phones': self.phones,
        }
        if self.kind == 'customer':
            d['esc_account_no'] = self.number
            d['notes'] = '\n'.join(self.access_notes) or None
        else:
            d['esc_location_no'] = self.number
            d['customer_esc_account_no'] = customer_no
            d['access_notes'] = '\n'.join(self.access_notes) or None
        if len(self.address_lines) > 2:
            d['notes'] = ((d.get('notes') or '') + '\n' +
                          '\n'.join(self.address_lines[2:])).strip()
        return d


def parse(lines):
    customers, filters, warnings = [], [], []
    block = customer = None

    def close_block():
        nonlocal block
        if block is None:
            return
        if block.kind == 'customer':
            customers.append({'block': block, 'locations': []})
        elif customers:
            customers[-1]['locations'].append(block)
        else:
            warnings.append(f'location {block.number} before any customer — skipped')
        block = None

    for line in lines:
        if not line.strip() or any(p.search(line) for p in SKIP_RES):
            continue
        if FILTER_FOOTER_RE.search(line):
            filters.append(line.strip())
            continue
        cm = CUSTOMER_RE.match(line)
        if cm:
            close_block()
            block = Block('customer', cm.group(1), line, cm.start(2))
            customer = block
            continue
        lm = LOCATION_RE.match(line)
        # Distinguish a location header from an address whose house number is
        # 5 digits: location numbers are zero-padded and/or carry phone labels.
        if lm and (lm.group(1).startswith('0') or len(LABEL_RE.findall(line)) >= 2):
            close_block()
            block = Block('location', lm.group(1), line, lm.start(2))
            continue
        if block is not None:
            block.feed(line)
        else:
            warnings.append(f'unattached line: {line.strip()[:80]}')
    close_block()
    return customers, filters, warnings


def sql_quote(s):
    return "'" + str(s).replace("'", "''") + "'"


def main():
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument('input', help='ESC Customer List Report (.pdf or pdftotext -layout .txt)')
    ap.add_argument('--out', default='build', help='output directory (default: build/)')
    args = ap.parse_args()

    src = Path(args.input)
    if src.suffix.lower() == '.pdf':
        text = subprocess.run(['pdftotext', '-layout', str(src), '-'],
                              check=True, capture_output=True, text=True).stdout
    else:
        text = src.read_text()

    customers, filters, warnings = parse(text.splitlines())

    out = Path(args.out)
    out.mkdir(parents=True, exist_ok=True)
    batch_id = str(uuid.uuid4())

    n_loc = 0
    with open(out / 'rows.csv', 'w', newline='') as f:
        w = csv.writer(f)
        for c in customers:
            w.writerow([batch_id, 'customer', json.dumps(c['block'].raw())])
            for loc in c['locations']:
                w.writerow([batch_id, 'location',
                            json.dumps(loc.raw(customer_no=c['block'].number))])
                n_loc += 1

    stats = {'customers': len(customers), 'locations': n_loc,
             'warnings': warnings[:50]}
    load_sql = f"""\\set ON_ERROR_STOP on
BEGIN;
INSERT INTO service.import_batches (id, source, filename, filters, stats)
VALUES ('{batch_id}', 'esc_customer_list_pdf', {sql_quote(src.name)},
        {sql_quote('; '.join(filters)) if filters else 'NULL'},
        {sql_quote(json.dumps(stats))}::jsonb);
\\copy service.import_rows (batch_id, row_kind, raw) FROM '{(out / 'rows.csv').resolve()}' WITH (FORMAT csv)
SELECT * FROM service.import_normalize('{batch_id}');
COMMIT;
"""
    (out / 'load.sql').write_text(load_sql)

    print(f'batch    {batch_id}')
    print(f'parsed   {len(customers)} customers, {n_loc} locations')
    print(f'filters  {"; ".join(filters) or "(none found)"}')
    if warnings:
        print(f'warnings ({len(warnings)}):')
        for wmsg in warnings[:10]:
            print(f'  - {wmsg}')
    print(f'\nwrote {out}/rows.csv and {out}/load.sql')
    print(f'load with:  psql "$DATABASE_URL" -f {out}/load.sql')
    return 0


if __name__ == '__main__':
    sys.exit(main())
