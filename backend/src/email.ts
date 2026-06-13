/**
 * Outbound email via Resend's HTTP API (same provider the CRM uses; no SDK
 * needed). Requires RESEND_API_KEY; EMAIL_FROM should be a sender on the
 * company's verified domain, e.g. "APT Service <service@accuratepower...com>".
 */
export async function sendEmail(to: string, subject: string, html: string): Promise<void> {
  const key = process.env.RESEND_API_KEY;
  if (!key) {
    throw new Error('Email is not configured yet — set RESEND_API_KEY and EMAIL_FROM on the service (copy RESEND_API_KEY from the CRM).');
  }
  const from = process.env.EMAIL_FROM || 'APT Service <onboarding@resend.dev>';
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ from, to, subject, html }),
  });
  if (!res.ok) {
    throw new Error(`Email send failed: ${(await res.text()).slice(0, 200)}`);
  }
}

const money = (v: unknown) =>
  `$${Number(v || 0).toLocaleString(undefined, { minimumFractionDigits: 2 })}`;
const esc = (v: unknown) =>
  String(v ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

export interface DocLine { kind: string; description: string; qty: unknown; unit_price: unknown }

/** Branded HTML for an emailed quote or invoice. */
export function documentHtml(opts: {
  kind: 'Invoice' | 'Quote';
  number: string | number;
  customerName: string;
  billing: string;
  serviceAt?: string | null;
  lines: DocLine[];
  subtotal: number;
  tax: number;
  total: number;
  terms?: string | null;
  validUntil?: string | null;
  summary?: string | null;
}): string {
  const rows = opts.lines.map((l) => `
    <tr>
      <td style="padding:6px 8px;border-bottom:1px solid #E1E4EA">${esc(l.description)}</td>
      <td style="padding:6px 8px;border-bottom:1px solid #E1E4EA;text-align:right">${Number(l.qty || 1)}</td>
      <td style="padding:6px 8px;border-bottom:1px solid #E1E4EA;text-align:right">${money(l.unit_price)}</td>
      <td style="padding:6px 8px;border-bottom:1px solid #E1E4EA;text-align:right"><b>${money(Number(l.qty || 1) * Number(l.unit_price || 0))}</b></td>
    </tr>`).join('');
  return `
  <div style="font-family:-apple-system,Segoe UI,Roboto,Arial,sans-serif;max-width:640px;margin:0 auto;color:#1E2633">
    <div style="background:#1B2F55;color:#fff;padding:18px 22px;border-radius:10px 10px 0 0">
      <div style="font-size:18px;font-weight:700;letter-spacing:.04em">ACCURATE POWER <span style="color:#E8B33C">&#9889;</span> SERVICE</div>
      <div style="font-size:13px;opacity:.85">${opts.kind} #${esc(opts.number)}</div>
    </div>
    <div style="border:1px solid #E1E4EA;border-top:0;padding:18px 22px;border-radius:0 0 10px 10px">
      <p style="margin:0 0 4px"><b>${opts.kind === 'Quote' ? 'Prepared for' : 'Bill to'}:</b> ${esc(opts.customerName)}<br>
      <span style="color:#5B6678">${esc(opts.billing)}</span></p>
      ${opts.serviceAt ? `<p style="margin:0 0 4px"><b>Service at:</b> ${esc(opts.serviceAt)}</p>` : ''}
      ${opts.summary ? `<p style="margin:0 0 10px;color:#5B6678">${esc(opts.summary)}</p>` : ''}
      <table style="width:100%;border-collapse:collapse;font-size:14px;margin-top:8px">
        <tr style="color:#5B6678;font-size:12px;text-transform:uppercase">
          <th style="text-align:left;padding:6px 8px">Description</th>
          <th style="text-align:right;padding:6px 8px">Qty</th>
          <th style="text-align:right;padding:6px 8px">Price</th>
          <th style="text-align:right;padding:6px 8px">Amount</th>
        </tr>
        ${rows}
      </table>
      <table style="margin-left:auto;margin-top:10px;font-size:14px">
        <tr><td style="padding:2px 14px 2px 0">Subtotal</td><td style="text-align:right">${money(opts.subtotal)}</td></tr>
        <tr><td style="padding:2px 14px 2px 0">Tax</td><td style="text-align:right">${money(opts.tax)}</td></tr>
        <tr style="font-weight:700;border-top:2px solid #1B2F55"><td style="padding:4px 14px 2px 0">Total</td><td style="text-align:right">${money(opts.total)}</td></tr>
      </table>
      ${opts.terms ? `<p style="font-size:13px;color:#5B6678;margin-top:14px"><b>Terms:</b> ${esc(opts.terms)}</p>` : ''}
      ${opts.validUntil ? `<p style="font-size:13px;color:#5B6678"><b>Quote valid until:</b> ${esc(opts.validUntil)}</p>` : ''}
      <p style="font-size:12px;color:#8A94A6;margin-top:18px">Accurate Power &amp; Technology &middot; Eustis, FL &middot; EC13007737</p>
    </div>
  </div>`;
}
