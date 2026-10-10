// A made-up trade report in the shape of a CoinDCX futures export: a cover
// sheet first, then the orders sheet with notes above a header on row 9,
// inline strings, times stored as Excel day numbers with a custom date format,
// newest row first and a "Total" line under the table. Built here rather than
// committed, so the repo holds no real account data.
import zlib from 'node:zlib';

// [pair, time, type, gross, settlement, fee]; net is gross + settlement - fee.
// What the journal should make of them is in EXPECTED below.
const ROWS = [
  // AAA: open, funding, part close, funding, close; then a second trade
  ['B-AAA_USDT', '2026-09-01 10:00:00', 'By Order', 0, 0, 5],
  ['B-AAA_USDT', '2026-09-01 13:30:00', 'By Funding', -1, 0, 0],
  ['B-AAA_USDT', '2026-09-01 15:00:00', 'By Order', 100, 0, 4],
  ['B-AAA_USDT', '2026-09-01 21:30:00', 'By Funding', -0.5, 0, 0],
  ['B-AAA_USDT', '2026-09-02 09:00:00', 'By Order', 50, 0, 3],
  ['B-AAA_USDT', '2026-09-03 10:00:00', 'By Order', 0, 0, 1],
  ['B-AAA_USDT', '2026-09-03 11:30:00', 'By Order', 10, 0, 1],
  // BBB: a losing trade
  ['B-BBB_USDT', '2026-09-02 12:00:00', 'By Order', 0, 0, 2],
  ['B-BBB_USDT', '2026-09-02 14:00:00', 'By Order', -80, 0, 2],
  // CCC: opened before the report starts (funding comes first)
  ['B-CCC_USDT', '2026-09-01 05:30:00', 'By Funding', -1.2, 0, 0],
  ['B-CCC_USDT', '2026-09-01 12:00:00', 'By Order', 30, 0, 1],
  // DDD: still open at the end of the report
  ['B-DDD_USDT', '2026-09-04 09:00:00', 'By Order', 0, 0, 3],
  ['B-DDD_USDT', '2026-09-04 13:30:00', 'By Funding', -2, 0, 0],
  ['B-DDD_USDT', '2026-09-04 21:30:00', 'By Funding', -2, 0, 0],
  // EEE: a close and the next open in the same second, then a loss
  ['B-EEE_USDT', '2026-09-05 10:00:00', 'By Order', 0, 0, 1],
  ['B-EEE_USDT', '2026-09-05 12:00:00', 'By Order', 0, 0, 1],
  ['B-EEE_USDT', '2026-09-05 12:00:00', 'By Order', 20, 0, 1],
  ['B-EEE_USDT', '2026-09-05 13:00:00', 'By Order', -5, 0, 1],
].map(([pair, at, type, gross, settle, fee], i) => ({ id: `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`, pair, at, type, gross, settle, fee, net: gross + settle - fee }));

// The rows themselves, for the CoinDCX API test to send the same transactions back.
export const REPORT_ROWS = ROWS;

export const EXPECTED = {
  rows: ROWS.length, orders: ROWS.filter(r => r.type === 'By Order').length, funding: ROWS.filter(r => r.type === 'By Funding').length,
  net: ROWS.reduce((s, r) => s + r.net, 0),
  // Closed trades by close time, then the one left open.
  closed: [
    { sym: 'B-CCC_USDT', start: '2026-09-01 05:30:00', end: '2026-09-01 12:00:00', legs: 2, net: 27.8, carried: true },
    { sym: 'B-AAA_USDT', start: '2026-09-01 10:00:00', end: '2026-09-02 09:00:00', legs: 5, net: 136.5, funding: -1.5, fees: 12, held: 23 * 60 },
    { sym: 'B-BBB_USDT', start: '2026-09-02 12:00:00', end: '2026-09-02 14:00:00', legs: 2, net: -84 },
    { sym: 'B-AAA_USDT', start: '2026-09-03 10:00:00', end: '2026-09-03 11:30:00', legs: 2, net: 8 },
    { sym: 'B-EEE_USDT', start: '2026-09-05 10:00:00', end: '2026-09-05 12:00:00', legs: 2, net: 18 },
    { sym: 'B-EEE_USDT', start: '2026-09-05 12:00:00', end: '2026-09-05 13:00:00', legs: 2, net: -7 },
  ],
  open: [{ sym: 'B-DDD_USDT', start: '2026-09-04 09:00:00', legs: 3, net: -7 }],
  wins: 4, losses: 2, closedNet: 99.3, maxDD: 84, fees: 26, fundingTotal: -6.7,
};

function crc32(buf) {
  let crc = 0xFFFFFFFF;
  for (const b of buf) { let c = (crc ^ b) & 0xFF; for (let k = 0; k < 8; k++) c = c & 1 ? (c >>> 1) ^ 0xEDB88320 : c >>> 1; crc = (crc >>> 8) ^ c; }
  return (crc ^ 0xFFFFFFFF) >>> 0;
}
function zip(files) {
  const parts = [], central = [];
  let off = 0;
  for (const [nameText, text] of files) {
    const name = Buffer.from(nameText), raw = Buffer.from(text), comp = zlib.deflateRawSync(raw), crc = crc32(raw);
    const h = Buffer.alloc(30);
    h.writeUInt32LE(0x04034b50, 0); h.writeUInt16LE(20, 4); h.writeUInt16LE(8, 8);
    h.writeUInt32LE(crc, 14); h.writeUInt32LE(comp.length, 18); h.writeUInt32LE(raw.length, 22); h.writeUInt16LE(name.length, 26);
    parts.push(h, name, comp);
    const c = Buffer.alloc(46);
    c.writeUInt32LE(0x02014b50, 0); c.writeUInt16LE(20, 4); c.writeUInt16LE(20, 6); c.writeUInt16LE(8, 10);
    c.writeUInt32LE(crc, 16); c.writeUInt32LE(comp.length, 20); c.writeUInt32LE(raw.length, 24); c.writeUInt16LE(name.length, 28); c.writeUInt32LE(off, 42);
    central.push(c, name);
    off += 30 + name.length + comp.length;
  }
  const cd = Buffer.concat(central), end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(files.length, 8); end.writeUInt16LE(files.length, 10); end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(off, 16);
  return Buffer.concat([...parts, cd, end]);
}

const xml = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const col = i => String.fromCharCode(65 + i);
const str = (ref, v) => `<c r="${ref}" s="2" t="inlineStr"><is><t>${xml(v)}</t></is></c>`;
const num = (ref, v) => `<c r="${ref}" s="2" t="n"><v>${v}</v></c>`;
// The workbook's own clock: a day count from 30 Dec 1899, no time zone.
const serial = at => Date.UTC(+at.slice(0, 4), +at.slice(5, 7) - 1, +at.slice(8, 10), +at.slice(11, 13), +at.slice(14, 16), +at.slice(17, 19)) / 864e5 + 25569;

export function backtestXlsx() {
  const head = ['Transaction ID', 'Crypto Pair', 'Base currency', 'Transaction time', 'Type of transaction', 'Gross P&L for this transaction(in INR)', 'USDT Settlement Amount (in INR)', 'Fees(in INR)', 'Net P&L for this transaction(in INR)'];
  const rows = [
    `<row r="1"><c r="A1" s="2" t="str"><v>1-Sep-2026 to 30-Sep-2026</v></c><c r="B1" s="2" t="str"><v/></c></row>`,
    `<row r="2">${str('A2', 'Please note - ')}</row>`,
    `<row r="4">${str('A4', 'Net P&L is Gross P&L plus USDT Settlement amount minus fees paid.')}</row>`,
    `<row r="9">${head.map((h, i) => str(col(i) + 9, h)).join('')}</row>`,
  ];
  const newestFirst = ROWS.slice().reverse();
  newestFirst.forEach((r, i) => {
    const n = 10 + i;
    rows.push(`<row r="${n}">${str('A' + n, r.id)}${str('B' + n, r.pair)}${str('C' + n, 'INR')}<c r="D${n}" s="1"><v>${serial(r.at)}</v></c>${str('E' + n, r.type)}${num('F' + n, r.gross)}${num('G' + n, r.settle)}${num('H' + n, r.fee)}${num('I' + n, r.net)}</row>`);
  });
  const t = 10 + newestFirst.length;
  rows.push(`<row r="${t}">${str('A' + t, 'Total')}${num('I' + t, EXPECTED.net)}</row>`);
  const sheet = body => `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${body}</sheetData></worksheet>`;
  return zip([
    ['[Content_Types].xml', '<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/>'
      + '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>'
      + '<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/worksheets/sheet2.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/></Types>'],
    ['_rels/.rels', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>'],
    ['xl/workbook.xml', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><workbookPr date1904="false"/><sheets><sheet name="CoinDCX Trade Report" sheetId="2" r:id="rId3"/><sheet name="Futures Orders (INR-M)" sheetId="1" r:id="rId4"/></sheets></workbook>'],
    ['xl/_rels/workbook.xml.rels', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/><Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId4" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet2.xml"/></Relationships>'],
    ['xl/styles.xml', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><numFmts count="1"><numFmt numFmtId="165" formatCode="yyyy\\-mm\\-dd hh:mm:ss"/></numFmts><cellXfs count="3"><xf numFmtId="0"/><xf numFmtId="165" applyNumberFormat="1"/><xf numFmtId="0"/></cellXfs></styleSheet>'],
    ['xl/worksheets/sheet1.xml', sheet(`<row r="8">${str('B8', 'NAME')}</row><row r="9">${str('B9', 'Test Person')}</row><row r="20">${str('B20', 'DURATION')}</row>`)],
    ['xl/worksheets/sheet2.xml', sheet(rows.join(''))],
  ]);
}

// The same report as a CSV with no ID column and day-first dates, as another
// export might give it. Uploaded after the .xlsx it must add nothing.
export function backtestCsv() {
  const dmy = at => at.slice(8, 10) + '-' + at.slice(5, 7) + '-' + at.slice(0, 4) + ' ' + at.slice(11);
  const lines = ['Trade report 1-Sep-2026 to 30-Sep-2026', '', 'Pair,Time,Type,Gross P&L (INR),Fees (INR),Net P&L (INR)'];
  ROWS.slice().reverse().forEach(r => lines.push([r.pair, dmy(r.at), r.type, r.gross, r.fee, r.net].join(',')));
  return Buffer.from('﻿' + lines.join('\r\n') + '\r\n');
}
