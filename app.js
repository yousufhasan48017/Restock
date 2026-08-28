/**
 * Restock — interface layer.
 *
 *   • The model maps columns (which one is the SKU? which are demand history?).
 *   • engine.js does every calculation.
 *
 * Charts are hand-built SVG: a value-concentration curve, a status breakdown,
 * a class-against-status matrix, and a sparkline per SKU. No chart library.
 */
(function () {
  'use strict';

  var KEYS = {
    endpoint: 'restock.endpoint',
    theme: 'restock.theme',
    settings: 'restock.settings'
  };

  var state = {
    report: null, parsed: null, profile: null, sourceName: '',
    showAllActions: false
  };

  var settings = {
    serviceLevel: 0.95, holdingRate: 22, orderCost: 2500, overstockDays: 120
  };

  /* ---------------- helpers ---------------- */
  function $(s) { return document.querySelector(s); }
  function esc(s) {
    return String(s === null || s === undefined ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }
  function store(k, v) { try { v === null ? localStorage.removeItem(k) : localStorage.setItem(k, v); } catch (e) {} }
  function read(k) { try { return localStorage.getItem(k); } catch (e) { return null; } }
  function n0(v) { return Math.round(Number(v) || 0).toLocaleString('en-US'); }
  function money(v) { return 'PKR ' + n0(v); }
  function moneyShort(v) {
    v = Number(v) || 0;
    var a = Math.abs(v);
    if (a >= 1e9) return (v / 1e9).toFixed(1) + 'B';
    if (a >= 1e6) return (v / 1e6).toFixed(1) + 'M';
    if (a >= 1e3) return Math.round(v / 1e3) + 'K';
    return String(Math.round(v));
  }
  function toast(msg, ms) {
    var old = $('.toast'); if (old) old.remove();
    var t = document.createElement('div');
    t.className = 'toast'; t.textContent = msg;
    document.body.appendChild(t);
    setTimeout(function () { if (t.parentNode) t.remove(); }, ms || 3800);
  }
  function svgEl(tag, attrs) {
    var n = document.createElementNS('http://www.w3.org/2000/svg', tag);
    Object.keys(attrs || {}).forEach(function (k) { n.setAttribute(k, attrs[k]); });
    return n;
  }

  /* ---------------- theme ---------------- */
  function initTheme() {
    var saved = read(KEYS.theme);
    if (saved === 'dark' || saved === 'light') document.documentElement.setAttribute('data-theme', saved);
    $('#btn-theme').addEventListener('click', function () {
      var isDark = document.documentElement.getAttribute('data-theme') === 'dark' ||
        (!document.documentElement.getAttribute('data-theme') &&
          window.matchMedia('(prefers-color-scheme: dark)').matches);
      var next = isDark ? 'light' : 'dark';
      document.documentElement.setAttribute('data-theme', next);
      store(KEYS.theme, next);
      if (state.report) renderCharts(state.report);   // SVG picks up new token colours
    });
  }

  /* ---------------- settings ---------------- */
  function loadSettings() {
    try {
      var raw = read(KEYS.settings);
      if (raw) {
        var s = JSON.parse(raw);
        Object.keys(settings).forEach(function (k) {
          if (typeof s[k] === 'number' && isFinite(s[k])) settings[k] = s[k];
        });
      }
    } catch (e) {}
    $('#service-level').value = String(settings.serviceLevel);
    $('#holding-rate').value = String(settings.holdingRate);
    $('#order-cost').value = String(settings.orderCost);
    $('#overstock-days').value = String(settings.overstockDays);
    $('#endpoint').value = read(KEYS.endpoint) || '';
  }

  function readSettingsFromForm() {
    var sl = parseFloat($('#service-level').value);
    var hr = parseFloat($('#holding-rate').value);
    var oc = parseFloat($('#order-cost').value);
    var od = parseFloat($('#overstock-days').value);
    if ([0.9, 0.95, 0.975, 0.99].indexOf(sl) > -1) settings.serviceLevel = sl;
    if (isFinite(hr) && hr > 0 && hr <= 100) settings.holdingRate = hr;
    if (isFinite(oc) && oc >= 0) settings.orderCost = oc;
    if (isFinite(od) && od >= 30) settings.overstockDays = od;
    store(KEYS.settings, JSON.stringify(settings));
  }

  function engineOptions() {
    return {
      serviceLevel: settings.serviceLevel,
      holdingRate: settings.holdingRate / 100,
      orderCost: settings.orderCost,
      overstockCoverDays: settings.overstockDays
    };
  }

  /* ---------------- AI column mapping ---------------- */
  function endpoint() { return (read(KEYS.endpoint) || '').trim(); }

  function callEndpoint(payload) {
    var url = endpoint();
    if (!url) return Promise.resolve(null);
    var ctrl = typeof AbortController !== 'undefined' ? new AbortController() : null;
    var timer = ctrl ? setTimeout(function () { ctrl.abort(); }, 20000) : null;
    return fetch(url, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload), signal: ctrl ? ctrl.signal : undefined
    }).then(function (r) {
      if (!r.ok) throw new Error('Endpoint returned ' + r.status);
      return r.json();
    }).then(function (d) {
      if (timer) clearTimeout(timer);
      if (Array.isArray(d)) d = d[0];
      if (d && d.json) d = d.json;
      return d;
    }).catch(function (e) {
      if (timer) clearTimeout(timer);
      console.warn('[restock] AI mapping failed:', e.message);
      return null;
    });
  }

  var ROLES = ['sku', 'description', 'category', 'supplier', 'unitCost', 'onHand', 'onOrder', 'leadTime', 'moq'];

  function buildProfile(headers, rows) {
    var base = Restock.inferProfile(headers, rows);
    if (!endpoint()) return Promise.resolve(base);

    return callEndpoint({ mode: 'map', headers: headers, sample: rows.slice(0, 10) })
      .then(function (d) {
        if (!d || !d.map) return base;
        var applied = 0;
        ROLES.forEach(function (role) {
          var col = d.map[role];
          if (typeof col === 'string' && headers.indexOf(col) > -1) { base.map[role] = col; applied++; }
        });
        if (Array.isArray(d.demand)) {
          var cols = d.demand.filter(function (c) { return headers.indexOf(c) > -1; });
          if (cols.length >= 2) { base.demand = cols; applied++; }
        }
        if (applied) base.source = 'model';
        return base;
      });
  }

  /* ---------------- run ---------------- */
  function run(parsed, sourceName) {
    if (!parsed || !parsed.headers.length || !parsed.rows.length) {
      toast('No data rows found in that file.'); return;
    }
    state.parsed = parsed;
    state.sourceName = sourceName;
    toast('Analysing ' + n0(parsed.rows.length) + ' SKUs…', 1800);

    buildProfile(parsed.headers, parsed.rows).then(function (profile) {
      state.profile = profile;
      if (!profile.demand || profile.demand.length < 2) {
        toast('Could not find demand history columns. The file needs at least two periods of demand.', 7000);
        return;
      }
      recalculate();
      $('#empty').classList.add('hidden');
      $('#results').classList.remove('hidden');
      window.scrollTo({ top: 0, behavior: 'smooth' });
    }).catch(function (e) {
      console.error(e);
      toast('Something went wrong: ' + e.message);
    });
  }

  function recalculate() {
    if (!state.parsed || !state.profile) return;
    state.report = Restock.analyze(state.parsed.headers, state.parsed.rows, state.profile, engineOptions());
    render(state.report);
  }

  /* ---------------- render ---------------- */
  function render(r) {
    renderKPIs(r);
    renderActions(r);
    renderCharts(r);
    renderMatrix(r);
    renderSuppliers(r);
    renderFilters(r);
    renderSkus();
  }

  function renderKPIs(r) {
    var k = r.kpis;
    var tiles = [
      { label: 'Stock on hand', value: moneyShort(k.totalStockValue), unit: 'PKR', note: r.meta.skuCount + ' SKUs' },
      { label: 'Suggested buy', value: moneyShort(k.orderValue), unit: 'PKR', note: k.atRiskCount + ' lines below reorder point' },
      { label: 'Sales at risk', value: moneyShort(k.salesAtRisk), unit: 'PKR/yr', note: 'annual value of short lines' },
      { label: 'Excess stock', value: moneyShort(k.excessValue), unit: 'PKR', note: 'above the max level' },
      { label: 'Dead stock', value: moneyShort(k.deadValue), unit: 'PKR', note: 'no demand in the period' },
      { label: 'Inventory turns', value: k.turns + 'x', unit: '', note: 'annual demand / stock value' }
    ];
    $('#kpis').innerHTML = tiles.map(function (t) {
      return '<div class="kpi">' +
        '<div class="kpi-label">' + esc(t.label) + '</div>' +
        '<div class="kpi-value">' + esc(t.value) + (t.unit ? ' <span class="kpi-unit">' + esc(t.unit) + '</span>' : '') + '</div>' +
        '<div class="kpi-note">' + esc(t.note) + '</div>' +
      '</div>';
    }).join('');
  }

  function actionable(r) {
    return r.items.filter(function (i) { return i.action.code !== 'HOLD'; });
  }

  function renderActions(r) {
    var list = actionable(r);
    var shown = state.showAllActions ? list : list.slice(0, 8);

    $('#action-sub').textContent = 'Ranked by urgency, then by the money on the line. ' +
      list.length + ' of ' + r.meta.skuCount + ' SKUs need a decision.' +
      (r.meta.profileSource === 'model' ? ' Columns mapped by AI; all figures computed by the engine.' : '');

    $('#actions').innerHTML = shown.map(function (i) {
      return '<div class="panel action">' +
        '<div class="action-main">' +
          '<div class="action-top">' +
            '<span class="chip chip-' + i.action.urgency + '">' + esc(i.action.label) + '</span>' +
            '<span class="action-name">' + esc(i.description || i.sku) + '</span>' +
            '<span class="action-sku">' + esc(i.sku) + '</span>' +
            '<span class="chip chip-neutral chip-plain">' + esc(i.abc) + esc(i.xyz) + '</span>' +
            '<span class="chip chip-neutral chip-plain">' + esc(i.supplier) + '</span>' +
          '</div>' +
          '<p class="action-detail">' + esc(i.action.detail) + '</p>' +
        '</div>' +
        '<div class="action-side">' +
          '<span class="action-qty">' + (i.action.qty ? n0(i.action.qty) + ' u' : '—') + '</span>' +
          '<span class="action-value">' + (i.action.value ? money(i.action.value) : '') + '</span>' +
        '</div>' +
      '</div>';
    }).join('');

    var btn = $('#btn-more-actions');
    if (list.length <= 8) btn.classList.add('hidden');
    else {
      btn.classList.remove('hidden');
      btn.textContent = state.showAllActions
        ? 'Show top 8 only'
        : 'Show all ' + list.length + ' recommendations';
    }
  }

  /* ---------- chart: value concentration ---------- */
  function renderConcentration(r) {
    var host = $('#chart-concentration');
    host.innerHTML = '';
    var pts = r.concentration;
    if (pts.length < 2) return;

    var W = 420, H = 230, L = 34, R = 10, T = 10, B = 26;
    var pw = W - L - R, ph = H - T - B;
    var x = function (v) { return L + (v / 100) * pw; };
    var y = function (v) { return T + ph - (v / 100) * ph; };

    var svg = svgEl('svg', { viewBox: '0 0 ' + W + ' ' + H, role: 'img',
      'aria-label': 'Cumulative share of annual value against share of SKUs' });

    [0, 25, 50, 75, 100].forEach(function (t) {
      svg.appendChild(svgEl('line', { x1: L, x2: W - R, y1: y(t), y2: y(t), class: 'gridline' }));
      var lab = svgEl('text', { x: L - 6, y: y(t) + 3, class: 'axis-label', 'text-anchor': 'end' });
      lab.textContent = t + '%';
      svg.appendChild(lab);
    });
    [0, 25, 50, 75, 100].forEach(function (t) {
      var lab = svgEl('text', { x: x(t), y: H - 8, class: 'axis-label', 'text-anchor': 'middle' });
      lab.textContent = t + '%';
      svg.appendChild(lab);
    });
    var xlab = svgEl('text', { x: L + pw / 2, y: H - 18, class: 'axis-label', 'text-anchor': 'middle' });
    xlab.textContent = 'share of SKUs →';
    svg.appendChild(xlab);

    // reference line: what a completely flat inventory would look like
    svg.appendChild(svgEl('line', {
      x1: x(0), y1: y(0), x2: x(100), y2: y(100),
      stroke: 'var(--axis)', 'stroke-width': 1, 'stroke-dasharray': '3 3'
    }));

    var d = pts.map(function (p, i) { return (i ? 'L' : 'M') + x(p.pctSkus).toFixed(1) + ' ' + y(p.pctValue).toFixed(1); }).join(' ');
    var area = d + ' L' + x(100) + ' ' + y(0) + ' L' + x(0) + ' ' + y(0) + ' Z';
    svg.appendChild(svgEl('path', { d: area, fill: 'var(--accent-wash)', stroke: 'none' }));
    svg.appendChild(svgEl('path', { d: d, fill: 'none', stroke: 'var(--accent)', 'stroke-width': 2, 'stroke-linejoin': 'round' }));
    svg.appendChild(svgEl('line', { x1: L, x2: W - R, y1: y(0), y2: y(0), class: 'baseline' }));

    // mark the class A cut-off — the 80% line is the whole point of the chart
    var aCount = r.items.filter(function (i) { return i.abc === 'A'; }).length;
    var aPct = 100 * aCount / r.meta.skuCount;
    svg.appendChild(svgEl('line', {
      x1: x(aPct), y1: y(0), x2: x(aPct), y2: y(80),
      stroke: 'var(--muted)', 'stroke-width': 1, 'stroke-dasharray': '2 2'
    }));
    var aLab = svgEl('text', { x: x(aPct) + 4, y: y(80) - 5, class: 'axis-label' });
    aLab.textContent = 'class A: ' + Math.round(aPct) + '% of SKUs';
    svg.appendChild(aLab);

    var dot = svgEl('circle', { r: 3.5, fill: 'var(--accent)', stroke: 'var(--surface)', 'stroke-width': 2, opacity: 0 });
    svg.appendChild(dot);

    var readout = $('#concentration-readout');
    var base = 'The top ' + Math.round(aPct) + '% of SKUs carry 80% of annual value.';
    readout.textContent = base;

    svg.addEventListener('mousemove', function (ev) {
      var box = svg.getBoundingClientRect();
      var px = ((ev.clientX - box.left) / box.width) * W;
      var pctSkus = Math.max(0, Math.min(100, ((px - L) / pw) * 100));
      var nearest = pts.reduce(function (best, p) {
        return Math.abs(p.pctSkus - pctSkus) < Math.abs(best.pctSkus - pctSkus) ? p : best;
      }, pts[0]);
      dot.setAttribute('cx', x(nearest.pctSkus));
      dot.setAttribute('cy', y(nearest.pctValue));
      dot.setAttribute('opacity', 1);
      readout.textContent = 'Top ' + nearest.pctSkus.toFixed(0) + '% of SKUs → ' +
        nearest.pctValue.toFixed(1) + '% of annual value';
    });
    svg.addEventListener('mouseleave', function () {
      dot.setAttribute('opacity', 0);
      readout.textContent = base;
    });

    host.appendChild(svg);
  }

  /* ---------- chart: status breakdown ---------- */
  function renderStatusBars(r) {
    var host = $('#chart-status');
    var order = ['stockout', 'dead', 'slow', 'overstock', 'healthy'];
    var max = Math.max.apply(null, order.map(function (k) { return r.statusTotals[k].value; }).concat([1]));

    host.innerHTML = order.map(function (k) {
      var s = r.statusTotals[k];
      var pct = max > 0 ? Math.max(s.value > 0 ? 2 : 0, (s.value / max) * 100) : 0;
      return '<div class="statusbar">' +
        '<span>' + esc(s.label) + ' <span class="dim">(' + s.count + ')</span></span>' +
        '<span class="statusbar-track"><span class="statusbar-fill" style="width:' + pct.toFixed(1) +
          '%;background:var(--' + s.severity + ')"></span></span>' +
        '<span class="statusbar-num">' + moneyShort(s.value) + '</span>' +
      '</div>';
    }).join('');
  }

  function renderCharts(r) {
    renderConcentration(r);
    renderStatusBars(r);
  }

  /* ---------- matrix ---------- */
  function renderMatrix(r) {
    var order = ['stockout', 'dead', 'slow', 'overstock', 'healthy'];
    var max = 0;
    r.matrix.forEach(function (row) { row.cells.forEach(function (c) { if (c.count > max) max = c.count; }); });

    var head = '<thead><tr><th class="row-head">Class</th>' +
      order.map(function (k) { return '<th>' + esc(r.statusTotals[k].label) + '</th>'; }).join('') +
      '<th>Total</th></tr></thead>';

    var body = '<tbody>' + r.matrix.map(function (row) {
      var byKey = {};
      row.cells.forEach(function (c) { byKey[c.status] = c; });
      return '<tr><th class="row-head">' + esc(row.abc) + '</th>' +
        order.map(function (k) {
          var c = byKey[k] || { count: 0, value: 0 };
          if (!c.count) return '<td class="zero">·</td>';
          var step = Math.min(6, Math.max(1, Math.ceil((c.count / max) * 6)));
          var lightText = step >= 4;
          return '<td style="background:var(--seq-' + step + ')' + (lightText ? ';color:#fff' : ';color:#0b0b0b') +
            '" title="' + esc(row.abc + ' · ' + r.statusTotals[k].label + ' · ' + c.count + ' SKUs · ' + money(c.value)) + '">' +
            c.count + '</td>';
        }).join('') +
        '<td class="num">' + row.total + '</td></tr>';
    }).join('') + '</tbody>';

    $('#matrix').innerHTML = head + body;

    $('#matrix-legend').innerHTML =
      '<span>Fewer SKUs</span>' +
      [1, 2, 3, 4, 5, 6].map(function (s) { return '<i style="background:var(--seq-' + s + ')"></i>'; }).join('') +
      '<span>More</span><span class="dim">· hover a cell for the value held</span>';
  }

  /* ---------- suppliers ---------- */
  function renderSuppliers(r) {
    $('#suppliers-table tbody').innerHTML = r.suppliers.map(function (s) {
      return '<tr>' +
        '<td><strong>' + esc(s.supplier) + '</strong></td>' +
        '<td class="num">' + s.skus + '</td>' +
        '<td class="num">' + (s.orderLines || '—') + '</td>' +
        '<td class="num">' + (s.orderValue ? money(s.orderValue) : '—') + '</td>' +
        '<td class="num">' + (s.excessValue ? money(s.excessValue) : '—') + '</td>' +
        '<td class="num">' + s.avgLeadTime + 'd</td>' +
        '<td>' + esc(s.recommendation) + '</td>' +
      '</tr>';
    }).join('');
  }

  /* ---------- sparkline ---------- */
  function sparkline(values) {
    if (!values.length) return '';
    var W = 74, H = 22, pad = 2;
    var max = Math.max.apply(null, values), min = Math.min.apply(null, values);
    var span = max - min || 1;
    var step = (W - pad * 2) / Math.max(1, values.length - 1);
    var pts = values.map(function (v, i) {
      return [pad + i * step, H - pad - ((v - min) / span) * (H - pad * 2)];
    });
    var d = pts.map(function (p, i) { return (i ? 'L' : 'M') + p[0].toFixed(1) + ' ' + p[1].toFixed(1); }).join(' ');
    var last = pts[pts.length - 1];
    return '<svg class="spark" viewBox="0 0 ' + W + ' ' + H + '" aria-hidden="true">' +
      '<path d="' + d + '"/><circle cx="' + last[0].toFixed(1) + '" cy="' + last[1].toFixed(1) + '" r="1.9"/></svg>';
  }

  /* ---------- SKU table ---------- */
  function renderFilters(r) {
    var statuses = {};
    r.items.forEach(function (i) { statuses[i.status] = i.statusLabel; });
    $('#f-status').innerHTML = '<option value="">All statuses</option>' +
      Object.keys(statuses).map(function (k) { return '<option value="' + esc(k) + '">' + esc(statuses[k]) + '</option>'; }).join('');

    var sup = r.suppliers.map(function (s) { return s.supplier; });
    $('#f-supplier').innerHTML = '<option value="">All suppliers</option>' +
      sup.map(function (s) { return '<option value="' + esc(s) + '">' + esc(s) + '</option>'; }).join('');
  }

  function filteredItems() {
    if (!state.report) return [];
    var st = $('#f-status').value, abc = $('#f-abc').value, sup = $('#f-supplier').value;
    var q = $('#f-search').value.trim().toLowerCase();
    return state.report.items.filter(function (i) {
      if (st && i.status !== st) return false;
      if (abc && i.abc !== abc) return false;
      if (sup && i.supplier !== sup) return false;
      if (q && (i.sku + ' ' + i.description).toLowerCase().indexOf(q) < 0) return false;
      return true;
    });
  }

  var CAP = 250;
  function renderSkus() {
    var list = filteredItems();
    var shown = list.slice(0, CAP);
    $('#sku-count').textContent = list.length === shown.length
      ? n0(list.length) + ' SKUs'
      : n0(shown.length) + ' of ' + n0(list.length) + ' SKUs shown';

    $('#skus-table tbody').innerHTML = shown.map(function (i) {
      return '<tr>' +
        '<td class="mono">' + esc(i.sku) + '</td>' +
        '<td class="truncate" title="' + esc(i.description) + '">' + esc(i.description) + '</td>' +
        '<td><span class="chip chip-' + i.severity + '">' + esc(i.statusLabel) + '</span></td>' +
        '<td class="mono">' + esc(i.abc + i.xyz) + '</td>' +
        '<td>' + sparkline(i.demand) + '</td>' +
        '<td class="num">' + n0(i.avgMonthly) + '</td>' +
        '<td class="num">' + n0(i.onHand) + '</td>' +
        '<td class="num">' + (i.daysOfCover === null ? '∞' : n0(i.daysOfCover) + 'd') + '</td>' +
        '<td class="num">' + n0(i.reorderPoint) + '</td>' +
        '<td class="num">' + n0(i.safetyStock) + '</td>' +
        '<td class="num">' + n0(i.eoq) + '</td>' +
        '<td>' + esc(i.action.label) + '</td>' +
        '<td class="num">' + (i.action.qty ? n0(i.action.qty) : '—') + '</td>' +
      '</tr>';
    }).join('') || '<tr><td colspan="13" class="dim" style="padding:1rem">No SKUs match these filters.</td></tr>';
  }

  /* ---------------- files ---------------- */
  function handleFile(file) {
    if (!file) return;
    if (file.size > 12 * 1024 * 1024) { toast('That file is over 12 MB — try a smaller extract.'); return; }
    var isXlsx = /\.xlsx$/i.test(file.name);
    var reader = new FileReader();

    reader.onerror = function () { toast('The file could not be read.'); };
    reader.onload = function () {
      if (isXlsx) {
        XlsxReader.read(reader.result).then(function (parsed) {
          run(parsed, file.name);
        }).catch(function (e) {
          toast(e.message || 'That Excel file could not be read.', 7000);
        });
      } else {
        run(Restock.parseCSV(String(reader.result)), file.name);
      }
    };

    if (isXlsx) reader.readAsArrayBuffer(file);
    else reader.readAsText(file);
  }

  function initFiles() {
    var input = $('#file-input');
    input.addEventListener('change', function () { handleFile(input.files[0]); input.value = ''; });
    ['#btn-upload', '#btn-upload-2'].forEach(function (s) {
      $(s).addEventListener('click', function () { input.click(); });
    });
    ['#btn-sample', '#btn-sample-2'].forEach(function (s) {
      $(s).addEventListener('click', function () {
        if (typeof window.RESTOCK_SAMPLE !== 'string') { toast('Sample data is unavailable.'); return; }
        state.showAllActions = false;
        run(Restock.parseCSV(window.RESTOCK_SAMPLE), 'inventory.csv (sample)');
      });
    });

    var zone = $('#empty');
    ['dragenter', 'dragover'].forEach(function (ev) {
      zone.addEventListener(ev, function (e) { e.preventDefault(); zone.classList.add('is-over'); });
    });
    ['dragleave', 'drop'].forEach(function (ev) {
      zone.addEventListener(ev, function (e) { e.preventDefault(); zone.classList.remove('is-over'); });
    });
    zone.addEventListener('drop', function (e) {
      if (e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0]) handleFile(e.dataTransfer.files[0]);
    });
  }

  /* ---------------- exports ---------------- */
  function download(name, text, mime) {
    var blob = new Blob([text], { type: (mime || 'text/plain') + ';charset=utf-8' });
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url; a.download = name;
    document.body.appendChild(a); a.click(); document.body.removeChild(a);
    setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
  }
  function cell(v) {
    var s = String(v === null || v === undefined ? '' : v);
    return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  }

  function exportActions() {
    if (!state.report) return;
    var rows = actionable(state.report);
    var head = ['sku', 'description', 'supplier', 'status', 'abc_xyz', 'action', 'quantity', 'value_pkr', 'lead_time_days', 'detail'];
    var body = rows.map(function (i) {
      return [i.sku, i.description, i.supplier, i.statusLabel, i.abc + i.xyz,
              i.action.label, i.action.qty, Math.round(i.action.value), i.leadTime, i.action.detail].map(cell).join(',');
    });
    download('restock-actions.csv', head.join(',') + '\n' + body.join('\n'), 'text/csv');
    toast('Exported ' + rows.length + ' recommendations.');
  }

  function exportSkus() {
    if (!state.report) return;
    var rows = filteredItems();
    var head = ['sku', 'description', 'category', 'supplier', 'status', 'abc', 'xyz',
                'avg_monthly_demand', 'demand_cv', 'annual_demand', 'unit_cost', 'on_hand', 'on_order',
                'days_of_cover', 'lead_time_days', 'safety_stock', 'reorder_point', 'eoq', 'max_level',
                'excess_units', 'excess_value', 'action', 'action_qty', 'action_value'];
    var body = rows.map(function (i) {
      return [i.sku, i.description, i.category, i.supplier, i.statusLabel, i.abc, i.xyz,
              i.avgMonthly, i.cv, i.annualDemand, i.unitCost, i.onHand, i.onOrder,
              i.daysOfCover === null ? '' : i.daysOfCover, i.leadTime, i.safetyStock, i.reorderPoint,
              i.eoq, i.maxLevel, i.excessUnits, Math.round(i.excessValue),
              i.action.label, i.action.qty, Math.round(i.action.value)].map(cell).join(',');
    });
    download('restock-skus.csv', head.join(',') + '\n' + body.join('\n'), 'text/csv');
    toast('Exported ' + rows.length + ' SKUs.');
  }

  /* ---------------- drawer ---------------- */
  var REQ = JSON.stringify({
    mode: 'map',
    headers: ['sku', 'description', 'supplier', 'unit_cost', 'on_hand', 'demand_sep', '…'],
    sample: [{ sku: 'BE-1001', on_hand: '2057', demand_sep: '958' }]
  }, null, 2);

  var RES = JSON.stringify({
    map: { sku: 'sku', description: 'description', supplier: 'supplier',
           unitCost: 'unit_cost', onHand: 'on_hand', leadTime: 'lead_time_days', moq: 'moq' },
    demand: ['demand_sep', 'demand_oct', '…']
  }, null, 2);

  function initDrawer() {
    var drawer = $('#drawer');
    $('#req-shape').textContent = REQ;
    $('#res-shape').textContent = RES;

    function open() { drawer.setAttribute('open', ''); }
    function close() { drawer.removeAttribute('open'); }
    $('#btn-settings').addEventListener('click', open);
    $('#btn-close-drawer').addEventListener('click', close);
    drawer.addEventListener('click', function (e) { if (e.target === drawer) close(); });
    document.addEventListener('keydown', function (e) { if (e.key === 'Escape') close(); });

    $('#btn-save').addEventListener('click', function () {
      var url = $('#endpoint').value.trim();
      if (url && !/^https?:\/\//i.test(url)) { toast('The webhook URL must start with http:// or https://'); return; }
      store(KEYS.endpoint, url || null);
      readSettingsFromForm();
      close();
      if (state.report) {
        recalculate();
        toast('Recalculated at ' + Math.round(settings.serviceLevel * 100) + '% service level.');
      } else {
        toast('Settings saved.');
      }
    });

    $('#btn-reset').addEventListener('click', function () {
      settings = { serviceLevel: 0.95, holdingRate: 22, orderCost: 2500, overstockDays: 120 };
      store(KEYS.settings, JSON.stringify(settings));
      loadSettings();
      if (state.report) recalculate();
      toast('Assumptions reset to defaults.');
    });
  }

  /* ---------------- boot ---------------- */
  function init() {
    initTheme();
    loadSettings();
    initDrawer();
    initFiles();

    ['#f-status', '#f-abc', '#f-supplier'].forEach(function (s) {
      $(s).addEventListener('change', renderSkus);
    });
    $('#f-search').addEventListener('input', renderSkus);
    $('#btn-export-actions').addEventListener('click', exportActions);
    $('#btn-export-skus').addEventListener('click', exportSkus);
    $('#btn-more-actions').addEventListener('click', function () {
      state.showAllActions = !state.showAllActions;
      renderActions(state.report);
    });

    if (!XlsxReader.supported()) {
      $('#btn-download-xlsx').setAttribute('title',
        'This browser cannot unzip Excel files — the CSV path still works.');
    }

    window.addEventListener('resize', function () {
      if (state.report) renderConcentration(state.report);
    });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
}());
