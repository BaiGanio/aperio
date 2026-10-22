// lib/docgraph/extract-eml.js
// EML (RFC 822 / MIME) extractor — self-contained, no mailparser dependency.
// Handles the common cases: folded headers, RFC 2047 encoded-words in
// Subject/From, quoted-printable / base64 bodies, and one level of multipart
// (prefers text/plain, strips HTML for text/html). Good enough for v1; if real
// mail comes out garbled, swap in `mailparser`. Returns { title, sections, refs }.
//
// Produces a single section: a header summary block + the decoded body text.

const baseName = (relPath) => relPath.split('/').pop().replace(/\.[^.]+$/, '');

function decodeQuotedPrintable(s) {
  return s
    .replace(/=\r?\n/g, '')                                   // soft line breaks
    .replace(/=([0-9A-Fa-f]{2})/g, (_, h) => String.fromCharCode(parseInt(h, 16)));
}

function decodeTransfer(body, encoding) {
  const enc = (encoding || '').toLowerCase();
  if (enc === 'base64') {
    try { return Buffer.from(body.replace(/\s+/g, ''), 'base64').toString('utf8'); } catch { return body; }
  }
  if (enc === 'quoted-printable') return decodeQuotedPrintable(body);
  return body;
}

// RFC 2047 =?charset?B|Q?text?= in header values.
function decodeWords(value) {
  return value.replace(/=\?([^?]+)\?([BbQq])\?([^?]*)\?=/g, (_, charset, enc, text) => {
    try {
      if (enc.toUpperCase() === 'B') return Buffer.from(text, 'base64').toString('utf8');
      const qp = text.replace(/_/g, ' ').replace(/=([0-9A-Fa-f]{2})/g, (_, h) => String.fromCharCode(parseInt(h, 16)));
      return Buffer.from(qp, 'binary').toString('utf8');
    } catch { return text; }
  });
}

function parseHeaders(raw) {
  const unfolded = raw.replace(/\r?\n[ \t]+/g, ' '); // join continuation lines
  const headers = {};
  for (const line of unfolded.split(/\r?\n/)) {
    const m = line.match(/^([!-9;-~]+):\s?(.*)$/);
    if (m) headers[m[1].toLowerCase()] = m[2];
  }
  return headers;
}

const stripHtml = (html) =>
  html.replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ').replace(/&amp;/gi, '&').replace(/&lt;/gi, '<').replace(/&gt;/gi, '>')
    .replace(/[ \t]+/g, ' ').replace(/\s*\n\s*/g, '\n').trim();

// Split a MIME message (headers + body) into decoded plain text. Recurses one
// level into multipart, preferring text/plain.
function bodyToText(headers, body, depth = 0) {
  const ctRaw = headers['content-type'] || 'text/plain';
  const ct = ctRaw.toLowerCase();
  const boundaryMatch = ctRaw.match(/boundary="?([^";]+)"?/i); // boundaries are case-sensitive

  if (ct.startsWith('multipart/') && boundaryMatch && depth < 3) {
    const boundary = boundaryMatch[1];
    const parts = body.split(new RegExp(`--${boundary.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?:--)?\\r?\\n?`));
    const decoded = [];
    let htmlFallback = '';
    for (const part of parts) {
      const sep = part.search(/\r?\n\r?\n/);
      if (sep === -1) continue;
      const pHeaders = parseHeaders(part.slice(0, sep));
      const pBody = part.slice(sep).replace(/^\r?\n\r?\n/, '');
      const pct = (pHeaders['content-type'] || '').toLowerCase();
      if (pct.startsWith('multipart/')) { decoded.push(bodyToText(pHeaders, pBody, depth + 1)); continue; }
      const text = decodeTransfer(pBody, pHeaders['content-transfer-encoding']);
      if (pct.startsWith('text/plain')) decoded.push(text.trim());
      else if (pct.startsWith('text/html')) htmlFallback ||= stripHtml(text);
    }
    const joined = decoded.filter(Boolean).join('\n\n').trim();
    return joined || htmlFallback;
  }

  const text = decodeTransfer(body, headers['content-transfer-encoding']);
  return ct.startsWith('text/html') ? stripHtml(text) : text.trim();
}

export async function extract(input, relPath) {
  const raw = Buffer.isBuffer(input) ? input.toString('utf8') : String(input);
  const sep = raw.search(/\r?\n\r?\n/);
  const headerBlock = sep === -1 ? raw : raw.slice(0, sep);
  const body = sep === -1 ? '' : raw.slice(sep).replace(/^\r?\n\r?\n/, '');

  const headers = parseHeaders(headerBlock);
  const subject = decodeWords(headers.subject || '').trim() || '(no subject)';
  const from = decodeWords(headers.from || '').trim();
  const to = decodeWords(headers.to || '').trim();
  const date = (headers.date || '').trim();

  const bodyText = bodyToText(headers, body);
  const summaryLines = [
    from && `From: ${from}`,
    to && `To: ${to}`,
    date && `Date: ${date}`,
    `Subject: ${subject}`,
  ].filter(Boolean).join('\n');

  const text = `${summaryLines}\n\n${bodyText}`.trim();
  return {
    title: subject,
    sections: [{ localId: 1, parentLocalId: null, ord: 0, level: 1, heading: subject, text }],
    refs: [],
  };
}
