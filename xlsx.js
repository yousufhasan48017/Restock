/**
 * Minimal .xlsx reader — no dependencies.
 *
 * An .xlsx file is a ZIP archive of XML. Rather than pull in a spreadsheet
 * library, this walks the ZIP central directory itself and inflates the two
 * entries that matter with the browser's built-in DecompressionStream:
 *
 *   xl/worksheets/sheet1.xml   the cells
 *   xl/sharedStrings.xml       the string table cells point into
 *
 * Only the first worksheet is read, and only cell values — formulas are taken
 * at their cached result, formatting is ignored. That is all an inventory
 * export needs.
 *
 * Browser only (needs DecompressionStream + DOMParser). Returns a Promise of
 * { headers, rows } in the same shape as the CSV parser.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.XlsxReader = factory();
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  function supported() {
    return typeof DecompressionStream === 'function' && typeof DOMParser === 'function';
  }

  /* ---------------- ZIP ---------------- */
  function u16(v, p) { return v.getUint16(p, true); }
  function u32(v, p) { return v.getUint32(p, true); }

  /** Locate the End Of Central Directory record, scanning back from the tail. */
  function findEOCD(view) {
    var min = Math.max(0, view.byteLength - 66000);
    for (var i = view.byteLength - 22; i >= min; i--) {
      if (u32(view, i) === 0x06054b50) return i;
    }
    return -1;
  }

  function readDirectory(buffer) {
    var view = new DataView(buffer);
    var eocd = findEOCD(view);
    if (eocd < 0) throw new Error('Not a valid .xlsx file (no ZIP directory found).');

    var count = u16(view, eocd + 10);
    var offset = u32(view, eocd + 16);
    var entries = {};
    var p = offset;

    for (var n = 0; n < count; n++) {
      if (u32(view, p) !== 0x02014b50) break;
      var method = u16(view, p + 10);
      var compressedSize = u32(view, p + 20);
      var uncompressedSize = u32(view, p + 24);
      var nameLen = u16(view, p + 28);
      var extraLen = u16(view, p + 30);
      var commentLen = u16(view, p + 32);
      var localOffset = u32(view, p + 42);
      var name = new TextDecoder('utf-8').decode(new Uint8Array(buffer, p + 46, nameLen));

      entries[name] = {
        name: name, method: method,
        compressedSize: compressedSize, uncompressedSize: uncompressedSize,
        localOffset: localOffset
      };
      p += 46 + nameLen + extraLen + commentLen;
    }
    return entries;
  }

  function entryBytes(buffer, entry) {
    var view = new DataView(buffer);
    var p = entry.localOffset;
    if (u32(view, p) !== 0x04034b50) throw new Error('Corrupt entry: ' + entry.name);
    var nameLen = u16(view, p + 26);
    var extraLen = u16(view, p + 28);
    var start = p + 30 + nameLen + extraLen;
    return new Uint8Array(buffer, start, entry.compressedSize);
  }

  function inflate(bytes, method) {
    if (method === 0) return Promise.resolve(bytes);                 // stored
    if (method !== 8) return Promise.reject(new Error('Unsupported ZIP compression method ' + method));
    var stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
    return new Response(stream).arrayBuffer().then(function (buf) { return new Uint8Array(buf); });
  }

  function readText(buffer, entries, name) {
    var entry = entries[name];
    if (!entry) return Promise.resolve(null);
    return inflate(entryBytes(buffer, entry), entry.method).then(function (bytes) {
      return new TextDecoder('utf-8').decode(bytes);
    });
  }

  /* ---------------- XLSX ---------------- */

  /** "BC" → 54 (zero-based column index) */
  function colIndex(ref) {
    var letters = /^([A-Z]+)/.exec(ref);
    if (!letters) return 0;
    var s = letters[1], n = 0;
    for (var i = 0; i < s.length; i++) n = n * 26 + (s.charCodeAt(i) - 64);
    return n - 1;
  }

  function parseSharedStrings(xml) {
    if (!xml) return [];
    var doc = new DOMParser().parseFromString(xml, 'application/xml');
    return Array.prototype.map.call(doc.getElementsByTagName('si'), function (si) {
      // <si> may hold one <t>, or several inside <r> runs — concatenate them all
      return Array.prototype.map.call(si.getElementsByTagName('t'), function (t) {
        return t.textContent;
      }).join('');
    });
  }

  function firstSheetName(entries) {
    var sheets = Object.keys(entries).filter(function (n) {
      return /^xl\/worksheets\/sheet\d+\.xml$/.test(n);
    }).sort(function (a, b) {
      return parseInt(a.replace(/\D/g, ''), 10) - parseInt(b.replace(/\D/g, ''), 10);
    });
    return sheets[0] || null;
  }

  function parseSheet(xml, strings) {
    var doc = new DOMParser().parseFromString(xml, 'application/xml');
    var err = doc.getElementsByTagName('parsererror')[0];
    if (err) throw new Error('The worksheet XML could not be read.');

    var grid = [];
    var rowNodes = doc.getElementsByTagName('row');

    for (var r = 0; r < rowNodes.length; r++) {
      var cells = rowNodes[r].getElementsByTagName('c');
      var out = [];
      for (var c = 0; c < cells.length; c++) {
        var cell = cells[c];
        var ref = cell.getAttribute('r') || '';
        var idx = ref ? colIndex(ref) : out.length;
        var type = cell.getAttribute('t');
        var value = '';

        if (type === 'inlineStr') {
          var is = cell.getElementsByTagName('t');
          value = is.length ? is[0].textContent : '';
        } else {
          var v = cell.getElementsByTagName('v')[0];
          var raw = v ? v.textContent : '';
          if (type === 's') {
            var n = parseInt(raw, 10);
            value = (strings[n] === undefined) ? '' : strings[n];
          } else {
            value = raw;
          }
        }
        while (out.length < idx) out.push('');
        out[idx] = value;
      }
      grid.push(out);
    }
    return grid;
  }

  /**
   * @param {ArrayBuffer} buffer contents of the .xlsx file
   * @returns {Promise<{headers: string[], rows: Object[]}>}
   */
  function read(buffer) {
    if (!supported()) {
      return Promise.reject(new Error(
        'This browser cannot unzip Excel files. Save the sheet as CSV and upload that instead.'));
    }
    return Promise.resolve().then(function () {
      var entries = readDirectory(buffer);
      var sheet = firstSheetName(entries);
      if (!sheet) throw new Error('No worksheet found inside the workbook.');

      return Promise.all([
        readText(buffer, entries, sheet),
        readText(buffer, entries, 'xl/sharedStrings.xml')
      ]).then(function (parts) {
        var grid = parseSheet(parts[0], parseSharedStrings(parts[1]));

        // drop fully blank leading rows, then treat the first populated row as the header
        while (grid.length && grid[0].every(function (v) { return String(v).trim() === ''; })) grid.shift();
        if (!grid.length) throw new Error('The first worksheet is empty.');

        var headers = grid[0].map(function (h, i) {
          var s = String(h).trim();
          return s || 'column_' + (i + 1);
        });

        var rows = grid.slice(1)
          .filter(function (r) { return r.some(function (v) { return String(v).trim() !== ''; }); })
          .map(function (r) {
            var o = {};
            headers.forEach(function (h, i) { o[h] = r[i] === undefined ? '' : String(r[i]); });
            return o;
          });

        return { headers: headers, rows: rows };
      });
    });
  }

  return { read: read, supported: supported, _internals: { colIndex: colIndex, readDirectory: readDirectory } };
}));
