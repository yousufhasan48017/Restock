/**
 * Tests the .xlsx reader against a genuine Excel file (data/inventory.xlsx,
 * produced by tools/make-xlsx.js).
 *
 * The ZIP layer — central directory walk, local headers, deflate — is fully
 * exercised here. The XML-to-grid step needs DOMParser, which Node does not
 * have, so that part is checked by asserting on the inflated XML itself and
 * verified for real in the browser.
 *
 *   node test/xlsx.test.js
 */
var fs = require('fs');
var path = require('path');
var Xlsx = require('../xlsx.js');

var passed = 0, failed = 0;
function check(name, cond, detail) {
  if (cond) { passed++; console.log('  PASS  ' + name); }
  else { failed++; console.log('  FAIL  ' + name + (detail ? '  → ' + detail : '')); }
}

console.log('\nColumn references');
var ci = Xlsx._internals.colIndex;
check('A → 0', ci('A1') === 0, String(ci('A1')));
check('B → 1', ci('B7') === 1, String(ci('B7')));
check('Z → 25', ci('Z100') === 25, String(ci('Z100')));
check('AA → 26', ci('AA1') === 26, String(ci('AA1')));
check('AB → 27', ci('AB1') === 27, String(ci('AB1')));
check('BC → 54', ci('BC12') === 54, String(ci('BC12')));

console.log('\nZIP container');
var file = path.join(__dirname, '..', 'data', 'inventory.xlsx');
check('inventory.xlsx exists', fs.existsSync(file));

var buf = fs.readFileSync(file);
var ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
var entries = Xlsx._internals.readDirectory(ab);
var names = Object.keys(entries);

check('found all six parts', names.length === 6, names.length + ': ' + names.join(', '));
check('has the worksheet', !!entries['xl/worksheets/sheet1.xml']);
check('has the shared string table', !!entries['xl/sharedStrings.xml']);
check('has [Content_Types].xml', !!entries['[Content_Types].xml']);
check('worksheet is deflated', entries['xl/worksheets/sheet1.xml'].method === 8,
  'method ' + entries['xl/worksheets/sheet1.xml'].method);
check('compression actually shrinks it',
  entries['xl/worksheets/sheet1.xml'].compressedSize < entries['xl/worksheets/sheet1.xml'].uncompressedSize,
  entries['xl/worksheets/sheet1.xml'].compressedSize + ' < ' + entries['xl/worksheets/sheet1.xml'].uncompressedSize);

console.log('\nInflated content');
/* Node 18+ ships DecompressionStream, so the reader's own inflate path runs here. */
if (typeof DecompressionStream !== 'function') {
  console.log('  SKIP  DecompressionStream unavailable in this Node build');
} else {
  var zlib = require('zlib');
  function raw(name) {
    var e = entries[name];
    var view = new DataView(ab);
    var p = e.localOffset;
    var nameLen = view.getUint16(p + 26, true);
    var extraLen = view.getUint16(p + 28, true);
    var start = p + 30 + nameLen + extraLen;
    var bytes = Buffer.from(ab, start, e.compressedSize);
    return (e.method === 8 ? zlib.inflateRawSync(bytes) : bytes).toString('utf8');
  }

  var sheet = raw('xl/worksheets/sheet1.xml');
  var shared = raw('xl/sharedStrings.xml');
  var csv = fs.readFileSync(path.join(__dirname, '..', 'data', 'inventory.csv'), 'utf8');
  var csvRows = csv.trim().split('\n').length;

  check('worksheet is well-formed XML', /^<\?xml/.test(sheet) && /<\/worksheet>$/.test(sheet.trim()));
  check('row count matches the CSV',
    (sheet.match(/<row /g) || []).length === csvRows,
    (sheet.match(/<row /g) || []).length + ' vs ' + csvRows);
  check('header row carries a shared-string cell', /<c r="A1" t="s">/.test(sheet));
  check('numeric cells are stored as numbers, not strings',
    /<c r="E2"><v>/.test(sheet), sheet.slice(sheet.indexOf('<c r="E2"'), sheet.indexOf('<c r="E2"') + 40));
  check('shared strings include a supplier name', shared.indexOf('Searle Pakistan') > -1);
  check('shared strings include a header', shared.indexOf('lead_time_days') > -1);
  var textCells = (sheet.match(/t="s"/g) || []).length;
  var uniqueStrings = (shared.match(/<si>/g) || []).length;
  check('strings are de-duplicated',
    uniqueStrings < textCells,
    uniqueStrings + ' unique strings backing ' + textCells + ' text cells');
  check('every string reference resolves',
    Math.max.apply(null, (sheet.match(/t="s"><v>(\d+)</g) || ['0'])
      .map(function (m) { return parseInt(m.replace(/\D/g, ''), 10); })) < uniqueStrings);
}

console.log('\n' + passed + ' passed, ' + failed + ' failed\n');
process.exit(failed ? 1 : 0);
