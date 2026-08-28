/**
 * Builds data/inventory.xlsx from data/inventory.csv.
 *
 * Writes the ZIP container by hand (local headers, central directory, EOCD,
 * CRC32) with zlib for the deflate, so the demo can offer a genuine Excel file
 * without adding a spreadsheet dependency. Text goes through the shared string
 * table, because that is what Excel itself produces and it is the path the
 * reader most needs to handle.
 *
 *   node tools/make-xlsx.js
 */
var fs = require('fs');
var path = require('path');
var zlib = require('zlib');

/* ---------------- CRC32 ---------------- */
var CRC_TABLE = (function () {
  var t = new Int32Array(256);
  for (var n = 0; n < 256; n++) {
    var c = n;
    for (var k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    t[n] = c;
  }
  return t;
})();

function crc32(buf) {
  var c = -1;
  for (var i = 0; i < buf.length; i++) c = (c >>> 8) ^ CRC_TABLE[(c ^ buf[i]) & 0xFF];
  return (c ^ -1) >>> 0;
}

/* ---------------- ZIP writer ---------------- */
function zip(files) {
  var chunks = [], central = [], offset = 0;

  files.forEach(function (f) {
    var raw = Buffer.from(f.content, 'utf8');
    var deflated = zlib.deflateRawSync(raw, { level: 9 });
    var useDeflate = deflated.length < raw.length;
    var data = useDeflate ? deflated : raw;
    var method = useDeflate ? 8 : 0;
    var name = Buffer.from(f.name, 'utf8');
    var crc = crc32(raw);

    var local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);        // version needed
    local.writeUInt16LE(0, 6);         // flags
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(0, 10);        // mod time
    local.writeUInt16LE(0x2158, 12);   // mod date (fixed, keeps output byte-stable)
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);

    chunks.push(local, name, data);

    var dir = Buffer.alloc(46);
    dir.writeUInt32LE(0x02014b50, 0);
    dir.writeUInt16LE(20, 4);          // version made by
    dir.writeUInt16LE(20, 6);          // version needed
    dir.writeUInt16LE(0, 8);
    dir.writeUInt16LE(method, 10);
    dir.writeUInt16LE(0, 12);
    dir.writeUInt16LE(0x2158, 14);
    dir.writeUInt32LE(crc, 16);
    dir.writeUInt32LE(data.length, 20);
    dir.writeUInt32LE(raw.length, 24);
    dir.writeUInt16LE(name.length, 28);
    dir.writeUInt16LE(0, 30);          // extra
    dir.writeUInt16LE(0, 32);          // comment
    dir.writeUInt16LE(0, 34);          // disk
    dir.writeUInt16LE(0, 36);          // internal attrs
    dir.writeUInt32LE(0, 38);          // external attrs
    dir.writeUInt32LE(offset, 42);

    central.push(dir, name);
    offset += local.length + name.length + data.length;
  });

  var centralBuf = Buffer.concat(central);
  var eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(files.length, 8);
  eocd.writeUInt16LE(files.length, 10);
  eocd.writeUInt32LE(centralBuf.length, 12);
  eocd.writeUInt32LE(offset, 16);
  eocd.writeUInt16LE(0, 20);

  return Buffer.concat([Buffer.concat(chunks), centralBuf, eocd]);
}

/* ---------------- CSV → grid ---------------- */
function parseCSV(text) {
  var rows = [], field = '', row = [], q = false;
  for (var i = 0; i < text.length; i++) {
    var c = text[i];
    if (q) {
      if (c === '"') { if (text[i + 1] === '"') { field += '"'; i++; } else q = false; }
      else field += c;
    } else if (c === '"') q = true;
    else if (c === ',') { row.push(field); field = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(field); rows.push(row); row = []; field = '';
    } else field += c;
  }
  if (field !== '' || row.length) { row.push(field); rows.push(row); }
  return rows.filter(function (r) { return r.some(function (v) { return v.trim() !== ''; }); });
}

function colName(n) {
  var s = '';
  n++;
  while (n > 0) { var r = (n - 1) % 26; s = String.fromCharCode(65 + r) + s; n = Math.floor((n - 1) / 26); }
  return s;
}
function xmlEscape(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/* ---------------- build ---------------- */
var csv = fs.readFileSync(path.join(__dirname, '..', 'data', 'inventory.csv'), 'utf8');
var grid = parseCSV(csv);

var strings = [], stringIndex = {};
function internString(s) {
  if (stringIndex[s] === undefined) { stringIndex[s] = strings.length; strings.push(s); }
  return stringIndex[s];
}

var sheetRows = grid.map(function (row, r) {
  var cells = row.map(function (v, c) {
    var ref = colName(c) + (r + 1);
    var isNumber = v !== '' && /^-?\d+(\.\d+)?$/.test(v);
    if (isNumber) return '<c r="' + ref + '"><v>' + v + '</v></c>';
    if (v === '') return '';
    return '<c r="' + ref + '" t="s"><v>' + internString(v) + '</v></c>';
  }).join('');
  return '<row r="' + (r + 1) + '">' + cells + '</row>';
}).join('');

var sheetXml =
  '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
  '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">' +
  '<sheetData>' + sheetRows + '</sheetData></worksheet>';

var sharedXml =
  '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
  '<sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" count="' + strings.length +
  '" uniqueCount="' + strings.length + '">' +
  strings.map(function (s) { return '<si><t xml:space="preserve">' + xmlEscape(s) + '</t></si>'; }).join('') +
  '</sst>';

var files = [
  { name: '[Content_Types].xml', content:
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
    '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
    '<Default Extension="xml" ContentType="application/xml"/>' +
    '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>' +
    '<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>' +
    '<Override PartName="/xl/sharedStrings.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sharedStrings+xml"/>' +
    '</Types>' },
  { name: '_rels/.rels', content:
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
    '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>' +
    '</Relationships>' },
  { name: 'xl/workbook.xml', content:
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" ' +
    'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">' +
    '<sheets><sheet name="Inventory" sheetId="1" r:id="rId1"/></sheets></workbook>' },
  { name: 'xl/_rels/workbook.xml.rels', content:
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
    '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>' +
    '<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/sharedStrings" Target="sharedStrings.xml"/>' +
    '</Relationships>' },
  { name: 'xl/sharedStrings.xml', content: sharedXml },
  { name: 'xl/worksheets/sheet1.xml', content: sheetXml }
];

var out = zip(files);
fs.writeFileSync(path.join(__dirname, '..', 'data', 'inventory.xlsx'), out);
console.log('Wrote data/inventory.xlsx — ' + (grid.length - 1) + ' rows, ' +
  strings.length + ' shared strings, ' + out.length.toLocaleString('en-US') + ' bytes');
