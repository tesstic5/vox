const CP1252: Record<number, number> = {
  0x20ac: 0x80, 0x201a: 0x82, 0x0192: 0x83, 0x201e: 0x84, 0x2026: 0x85, 0x2020: 0x86, 0x2021: 0x87,
  0x02c6: 0x88, 0x2030: 0x89, 0x0160: 0x8a, 0x2039: 0x8b, 0x0152: 0x8c, 0x017d: 0x8e, 0x2018: 0x91,
  0x2019: 0x92, 0x201c: 0x93, 0x201d: 0x94, 0x2022: 0x95, 0x2013: 0x96, 0x2014: 0x97, 0x02dc: 0x98,
  0x2122: 0x99, 0x0161: 0x9a, 0x203a: 0x9b, 0x0153: 0x9c, 0x017e: 0x9e, 0x0178: 0x9f,
};

function winAnsi(text: string): Buffer {
  const bytes: number[] = [];
  for (const char of text.normalize('NFC')) {
    const code = char.codePointAt(0) ?? 63;
    if (code <= 0xff && !(code >= 0x80 && code <= 0x9f)) bytes.push(code);
    else bytes.push(CP1252[code] ?? 63);
  }
  return Buffer.from(bytes);
}

function pdfEscape(text: string): Buffer {
  const input = winAnsi(text);
  const out: number[] = [];
  for (const byte of input) {
    if (byte === 0x28 || byte === 0x29 || byte === 0x5c) out.push(0x5c, byte);
    else if (byte === 0x0d || byte === 0x0a) out.push(0x20);
    else out.push(byte);
  }
  return Buffer.from(out);
}

function wrap(text: string, width = 92): string[] {
  const result: string[] = [];
  for (const paragraph of String(text).replace(/\r/g, '').split('\n')) {
    if (!paragraph.trim()) { result.push(''); continue; }
    let line = '';
    for (const word of paragraph.split(/\s+/)) {
      if (!line) line = word;
      else if (`${line} ${word}`.length <= width) line += ` ${word}`;
      else { result.push(line); line = word; }
      while (line.length > width) { result.push(line.slice(0, width)); line = line.slice(width); }
    }
    result.push(line);
  }
  return result;
}

function object(id: number, content: Buffer | string) {
  return Buffer.concat([Buffer.from(`${id} 0 obj\n`, 'ascii'), Buffer.isBuffer(content) ? content : Buffer.from(content, 'ascii'), Buffer.from('\nendobj\n', 'ascii')]);
}

/** A deterministic, dependency-free A4 PDF suitable for finalised text letters. */
export function renderTextPdf(input: { title: string; body: string; footer?: string; producedAt?: string }): Buffer {
  const lines = wrap(input.body);
  const perPage = 52;
  const pages = Math.max(1, Math.ceil(lines.length / perPage));
  const pageIds = Array.from({ length: pages }, (_, index) => 4 + index * 2);
  const contentIds = pageIds.map((id) => id + 1);
  const objects = new Map<number, Buffer>();
  objects.set(1, object(1, '<< /Type /Catalog /Pages 2 0 R >>'));
  objects.set(2, object(2, `<< /Type /Pages /Count ${pages} /Kids [${pageIds.map((id) => `${id} 0 R`).join(' ')}] >>`));
  objects.set(3, object(3, '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>'));
  for (let index = 0; index < pages; index += 1) {
    const pageId = pageIds[index];
    const contentId = contentIds[index];
    objects.set(pageId, object(pageId, `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 3 0 R >> >> /Contents ${contentId} 0 R >>`));
    const chunks: Buffer[] = [Buffer.from('BT\n/F1 15 Tf\n54 790 Td\n', 'ascii'), pdfEscape(input.title), Buffer.from(' Tj\n/F1 10 Tf\n0 -28 Td\n', 'ascii')];
    const pageLines = lines.slice(index * perPage, (index + 1) * perPage);
    for (const line of pageLines) chunks.push(pdfEscape(line), Buffer.from(' Tj\n0 -14 Td\n', 'ascii'));
    chunks.push(Buffer.from('ET\nBT\n/F1 8 Tf\n54 28 Td\n', 'ascii'), pdfEscape(`${input.footer ?? ''}${input.footer ? ' · ' : ''}Page ${index + 1} of ${pages}`), Buffer.from(' Tj\nET', 'ascii'));
    const stream = Buffer.concat(chunks);
    objects.set(contentId, object(contentId, Buffer.concat([Buffer.from(`<< /Length ${stream.length} >>\nstream\n`, 'ascii'), stream, Buffer.from('\nendstream', 'ascii')])));
  }
  const maxId = 3 + pages * 2;
  const header = Buffer.from('%PDF-1.4\n%\xE2\xE3\xCF\xD3\n', 'binary');
  const parts: Buffer[] = [header];
  const offsets = [0];
  let offset = header.length;
  for (let id = 1; id <= maxId; id += 1) {
    const item = objects.get(id);
    if (!item) throw new Error(`missing PDF object ${id}`);
    offsets[id] = offset;
    parts.push(item);
    offset += item.length;
  }
  const xrefOffset = offset;
  const xref = [`xref\n0 ${maxId + 1}\n`, '0000000000 65535 f \n'];
  for (let id = 1; id <= maxId; id += 1) xref.push(`${String(offsets[id]).padStart(10, '0')} 00000 n \n`);
  xref.push(`trailer\n<< /Size ${maxId + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`);
  parts.push(Buffer.from(xref.join(''), 'ascii'));
  return Buffer.concat(parts);
}
