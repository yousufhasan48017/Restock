/**
 * Restock — inventory decision engine.
 *
 * Dependency-free and deterministic. The language model in this project maps
 * spreadsheet columns to roles and writes the narrative; every quantity,
 * classification and rupee figure below is computed here, so a buyer can be
 * shown the arithmetic behind any recommendation.
 *
 * Formulas are the standard ones, stated plainly:
 *   σ over lead time   = σ_daily × √LT           (demand variability scales with √time)
 *   safety stock       = z × σ_LT                (z from the target service level)
 *   reorder point      = daily demand × LT + safety stock
 *   EOQ                = √(2DS / H)              (Wilson)
 *   order-up-to level  = reorder point + EOQ
 *
 * Browser: window.Restock — Node: require('./engine.js')
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.Restock = factory();
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var VERSION = '1.0.0';
  var DAYS_PER_MONTH = 30.44;

  /* z-scores for the usual service levels */
  var Z = { 0.90: 1.2816, 0.95: 1.6449, 0.975: 1.96, 0.99: 2.3263 };

  var DEFAULTS = {
    serviceLevel: 0.95,
    holdingRate: 0.22,      // annual carrying cost as a share of unit cost
    orderCost: 2500,        // cost to raise one purchase order, PKR
    currency: 'PKR',
    overstockCoverDays: 120,
    slowDeclineRatio: 0.35, // last 6 months vs the 6 before
    reviewDays: 30          // ordering cycle
  };

  var STATUS = {
    stockout:  { key: 'stockout',  label: 'Stockout risk', severity: 'critical', rank: 1 },
    dead:      { key: 'dead',      label: 'Dead stock',    severity: 'serious',  rank: 2 },
    slow:      { key: 'slow',      label: 'Slow moving',   severity: 'serious',  rank: 3 },
    overstock: { key: 'overstock', label: 'Overstock',     severity: 'warning',  rank: 4 },
    healthy:   { key: 'healthy',   label: 'Healthy',       severity: 'good',     rank: 5 }
  };

  /* ------------------------------------------------------------------ *
   * CSV
   * ------------------------------------------------------------------ */
  function parseCSV(text) {
    var rows = [], field = '', row = [], inQuotes = false;
    text = String(text).replace(/^﻿/, '');
    for (var i = 0; i < text.length; i++) {
      var c = text[i];
      if (inQuotes) {
        if (c === '"') { if (text[i + 1] === '"') { field += '"'; i++; } else inQuotes = false; }
        else field += c;
      } else if (c === '"') inQuotes = true;
      else if (c === ',') { row.push(field); field = ''; }
      else if (c === '\n' || c === '\r') {
        if (c === '\r' && text[i + 1] === '\n') i++;
        row.push(field); rows.push(row); row = []; field = '';
      } else field += c;
    }
    if (field !== '' || row.length) { row.push(field); rows.push(row); }
    rows = rows.filter(function (r) { return r.some(function (v) { return String(v).trim() !== ''; }); });
    if (!rows.length) return { headers: [], rows: [] };
    var headers = rows[0].map(function (h) { return String(h).trim(); });
    return {
      headers: headers,
      rows: rows.slice(1).map(function (r) {
        var o = {};
        headers.forEach(function (h, i) { o[h] = r[i] === undefined ? '' : r[i]; });
        return o;
      })
    };
  }

  /* ------------------------------------------------------------------ *
   * Column mapping — heuristic fallback when no model profile is given
   * ------------------------------------------------------------------ */
  var MONTH_RE = /^(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)/i;

  var ROLE_HINTS = [
    { role: 'sku',         re: /^(sku|item|material|product|part)[_\s-]?(code|no|number|id)?$|^code$|^id$/i },
    { role: 'description', re: /desc|name|title|product/i },
    { role: 'category',    re: /categ|group|family|class|segment|type/i },
    { role: 'supplier',    re: /supplier|vendor|manufacturer|source/i },
    { role: 'unitCost',    re: /unit[_\s-]?(cost|price)|cost|price|rate|value$/i },
    { role: 'onHand',      re: /on[_\s-]?hand|stock|inventory|qty[_\s-]?available|closing|balance/i },
    { role: 'onOrder',     re: /on[_\s-]?order|incoming|in[_\s-]?transit|po[_\s-]?qty|open[_\s-]?po/i },
    { role: 'leadTime',    re: /lead[_\s-]?time|lt[_\s-]?days|replenish/i },
    { role: 'moq',         re: /moq|min[_\s-]?order|minimum|pack[_\s-]?size|lot[_\s-]?size/i }
  ];

  function looksLikeDemand(h) {
    return /demand|sales|usage|consumption|issued|shipped|offtake|qty[_\s-]?sold/i.test(h) ||
           MONTH_RE.test(h) || /^m\d{1,2}$/i.test(h) || /^(period|wk|week)[_\s-]?\d+$/i.test(h);
  }

  function inferProfile(headers, rows) {
    var map = {}, demand = [], taken = {};

    // demand columns first — they are the only role that can claim many columns
    headers.forEach(function (h) {
      if (looksLikeDemand(h)) { demand.push(h); taken[h] = true; }
    });

    ROLE_HINTS.forEach(function (hint) {
      if (map[hint.role]) return;
      for (var i = 0; i < headers.length; i++) {
        var h = headers[i];
        if (taken[h]) continue;
        if (hint.re.test(h)) { map[hint.role] = h; taken[h] = true; return; }
      }
    });

    // If nothing matched as demand, take the trailing run of numeric columns.
    if (demand.length < 3 && rows.length) {
      var trailing = [];
      for (var j = headers.length - 1; j >= 0; j--) {
        var h2 = headers[j];
        if (taken[h2]) break;
        var vals = rows.slice(0, 20).map(function (r) { return String(r[h2] || '').trim(); });
        var numeric = vals.filter(function (v) { return v !== '' && /^-?[\d,]+(\.\d+)?$/.test(v); }).length;
        if (numeric / Math.max(1, vals.length) > 0.8) trailing.unshift(h2); else break;
      }
      if (trailing.length >= 3) { demand = trailing; trailing.forEach(function (h3) { taken[h3] = true; }); }
    }

    if (!map.sku) map.sku = headers[0];
    return { map: map, demand: demand, source: 'heuristic' };
  }

  /* ------------------------------------------------------------------ *
   * Maths helpers
   * ------------------------------------------------------------------ */
  function toNum(v) {
    if (v === null || v === undefined) return 0;
    var n = Number(String(v).replace(/[,\s₨]/g, '').replace(/^\((.*)\)$/, '-$1'));
    return isFinite(n) ? n : 0;
  }
  function sum(a) { return a.reduce(function (s, v) { return s + v; }, 0); }
  function mean(a) { return a.length ? sum(a) / a.length : 0; }
  function stdev(a) {
    if (a.length < 2) return 0;
    var m = mean(a);
    return Math.sqrt(sum(a.map(function (v) { return (v - m) * (v - m); })) / (a.length - 1));
  }
  function round(n, dp) { var f = Math.pow(10, dp || 0); return Math.round(n * f) / f; }
  function roundUpTo(n, step) { return step > 0 ? Math.ceil(n / step) * step : Math.ceil(n); }

  /* ------------------------------------------------------------------ *
   * The analysis
   * ------------------------------------------------------------------ */
  function analyze(headers, rows, profile, options) {
    var o = {};
    Object.keys(DEFAULTS).forEach(function (k) { o[k] = DEFAULTS[k]; });
    Object.keys(options || {}).forEach(function (k) {
      if (options[k] !== undefined && options[k] !== null) o[k] = options[k];
    });
    var z = Z[o.serviceLevel] || Z[0.95];

    profile = profile || inferProfile(headers, rows);
    var m = profile.map, demandCols = profile.demand || [];
    var periods = demandCols.length;

    var items = rows.map(function (r, index) {
      var demand = demandCols.map(function (c) { return Math.max(0, toNum(r[c])); });
      var unitCost = toNum(r[m.unitCost]);
      var onHand = toNum(r[m.onHand]);
      var onOrder = toNum(r[m.onOrder]);
      var leadTime = toNum(r[m.leadTime]) || 14;
      var moq = toNum(r[m.moq]);

      var avgMonthly = mean(demand);
      var sd = stdev(demand);
      var cv = avgMonthly > 0 ? sd / avgMonthly : 0;
      var annualDemand = periods ? sum(demand) * (12 / periods) : 0;
      var annualValue = annualDemand * unitCost;

      var avgDaily = avgMonthly / DAYS_PER_MONTH;
      var sdDaily = sd / Math.sqrt(DAYS_PER_MONTH);
      var sigmaLT = sdDaily * Math.sqrt(leadTime);

      var safetyStock = z * sigmaLT;
      var leadTimeDemand = avgDaily * leadTime;
      var reorderPoint = leadTimeDemand + safetyStock;

      var eoq = (annualDemand > 0 && unitCost > 0)
        ? Math.sqrt((2 * annualDemand * o.orderCost) / (unitCost * o.holdingRate))
        : 0;
      // never order less than a review cycle's worth, nor more than a year's
      eoq = Math.min(Math.max(eoq, avgDaily * o.reviewDays), Math.max(annualDemand, 1));

      var maxLevel = reorderPoint + eoq;
      var position = onHand + onOrder;
      var stockValue = onHand * unitCost;
      var daysOfCover = avgDaily > 0 ? position / avgDaily : (position > 0 ? Infinity : 0);
      var daysToStockout = avgDaily > 0 ? position / avgDaily : Infinity;
      var turns = position > 0 ? annualDemand / position : (annualDemand > 0 ? 12 : 0);

      // demand shape
      var half = Math.floor(periods / 2);
      var prior = demand.slice(0, half), recent = demand.slice(periods - half);
      var priorSum = sum(prior), recentSum = sum(recent);
      var trendPct = priorSum > 0 ? (recentSum - priorSum) / priorSum : (recentSum > 0 ? 1 : 0);

      /* ---- classification ---- */
      var status;
      if (annualDemand <= 0) status = position > 0 ? STATUS.dead : STATUS.healthy;
      else if (position <= reorderPoint) status = STATUS.stockout;
      else if (priorSum > 0 && recentSum <= o.slowDeclineRatio * priorSum) status = STATUS.slow;
      else if (position > maxLevel && daysOfCover > o.overstockCoverDays) status = STATUS.overstock;
      else status = STATUS.healthy;

      // a SKU that will run dry before a replacement can land is the worst case
      var willStockOut = status.key === 'stockout' && position < leadTimeDemand;

      var excessUnits = Math.max(0, position - maxLevel);
      var excessValue = excessUnits * unitCost;

      return {
        index: index,
        sku: String(r[m.sku] || '').trim() || 'ROW-' + (index + 2),
        description: String(r[m.description] || '').trim(),
        category: String(r[m.category] || '').trim() || 'Uncategorised',
        supplier: String(r[m.supplier] || '').trim() || 'Unassigned',
        unitCost: unitCost, onHand: onHand, onOrder: onOrder, position: position,
        leadTime: leadTime, moq: moq,
        demand: demand,
        avgMonthly: round(avgMonthly, 1), sd: round(sd, 1), cv: round(cv, 3),
        annualDemand: Math.round(annualDemand), annualValue: annualValue,
        avgDaily: round(avgDaily, 2),
        safetyStock: Math.round(safetyStock),
        leadTimeDemand: Math.round(leadTimeDemand),
        reorderPoint: Math.round(reorderPoint),
        eoq: Math.round(eoq),
        maxLevel: Math.round(maxLevel),
        stockValue: stockValue,
        daysOfCover: isFinite(daysOfCover) ? Math.round(daysOfCover) : null,
        daysToStockout: isFinite(daysToStockout) ? Math.round(daysToStockout) : null,
        turns: round(turns, 2),
        trendPct: round(trendPct, 3),
        excessUnits: Math.round(excessUnits), excessValue: excessValue,
        status: status.key, statusLabel: status.label, severity: status.severity,
        willStockOut: willStockOut
      };
    });

    /* ---- ABC (value concentration) and XYZ (demand variability) ---- */
    var totalAnnualValue = sum(items.map(function (i) { return i.annualValue; }));
    var byValue = items.slice().sort(function (a, b) { return b.annualValue - a.annualValue; });
    var cumulative = 0;
    byValue.forEach(function (i) {
      cumulative += i.annualValue;
      var pct = totalAnnualValue > 0 ? cumulative / totalAnnualValue : 1;
      i.abc = pct <= 0.80 ? 'A' : pct <= 0.95 ? 'B' : 'C';
      i.cumValuePct = round(pct * 100, 1);
    });
    items.forEach(function (i) {
      i.xyz = i.annualDemand === 0 ? 'Z' : i.cv < 0.5 ? 'X' : i.cv < 1.0 ? 'Y' : 'Z';
    });

    /* ---- recommendations ---- */
    items.forEach(function (i) { i.action = recommend(i, o); });

    /* ---- supplier rollup ---- */
    var suppliers = rollupSuppliers(items);

    /* ---- portfolio KPIs ---- */
    var totalStockValue = sum(items.map(function (i) { return i.stockValue; }));
    var excessValue = sum(items.map(function (i) { return i.status === 'overstock' || i.status === 'slow' ? i.excessValue : 0; }));
    var deadValue = sum(items.filter(function (i) { return i.status === 'dead'; }).map(function (i) { return i.stockValue; }));
    var atRisk = items.filter(function (i) { return i.status === 'stockout'; });
    var orderValue = sum(items.map(function (i) { return i.action.code === 'ORDER_NOW' ? i.action.value : 0; }));
    var salesAtRisk = sum(atRisk.map(function (i) { return i.annualValue; }));

    var statusTotals = {};
    Object.keys(STATUS).forEach(function (k) { statusTotals[k] = { count: 0, value: 0, label: STATUS[k].label, severity: STATUS[k].severity }; });
    items.forEach(function (i) { statusTotals[i.status].count++; statusTotals[i.status].value += i.stockValue; });

    var abcTotals = { A: { count: 0, value: 0 }, B: { count: 0, value: 0 }, C: { count: 0, value: 0 } };
    items.forEach(function (i) { abcTotals[i.abc].count++; abcTotals[i.abc].value += i.stockValue; });

    /* value concentration curve — one measure, so it needs one axis */
    var concentration = [{ pctSkus: 0, pctValue: 0 }];
    var run = 0;
    byValue.forEach(function (i, n) {
      run += i.annualValue;
      concentration.push({
        pctSkus: round(100 * (n + 1) / byValue.length, 2),
        pctValue: round(totalAnnualValue > 0 ? 100 * run / totalAnnualValue : 0, 2)
      });
    });

    /* ABC × status matrix — where the money actually sits */
    var matrix = ['A', 'B', 'C'].map(function (cls) {
      var cells = Object.keys(STATUS).map(function (st) {
        var subset = items.filter(function (i) { return i.abc === cls && i.status === st; });
        return { status: st, label: STATUS[st].label, count: subset.length, value: sum(subset.map(function (i) { return i.stockValue; })) };
      });
      return { abc: cls, cells: cells, total: sum(cells.map(function (c) { return c.count; })) };
    });

    items.sort(function (a, b) {
      return (STATUS[a.status].rank - STATUS[b.status].rank) ||
             (b.action.value - a.action.value) ||
             (b.annualValue - a.annualValue);
    });

    return {
      version: VERSION,
      meta: {
        skuCount: items.length,
        periods: periods,
        demandColumns: demandCols,
        profileSource: profile.source || 'heuristic',
        assumptions: {
          serviceLevel: o.serviceLevel, z: z,
          holdingRate: o.holdingRate, orderCost: o.orderCost,
          currency: o.currency, overstockCoverDays: o.overstockCoverDays
        }
      },
      kpis: {
        totalStockValue: totalStockValue,
        excessValue: excessValue,
        deadValue: deadValue,
        releasable: excessValue + deadValue,
        orderValue: orderValue,
        salesAtRisk: salesAtRisk,
        atRiskCount: atRisk.length,
        turns: totalStockValue > 0 ? round(totalAnnualValue / totalStockValue, 2) : 0,
        totalAnnualValue: totalAnnualValue
      },
      statusTotals: statusTotals,
      abcTotals: abcTotals,
      concentration: concentration,
      matrix: matrix,
      suppliers: suppliers,
      items: items
    };
  }

  /* ------------------------------------------------------------------ *
   * One decision per SKU, with the quantity and the money attached.
   * ------------------------------------------------------------------ */
  function recommend(i, o) {
    var qty, value;

    if (i.status === 'stockout') {
      qty = Math.max(i.maxLevel - i.position, i.moq || 0);
      qty = roundUpTo(Math.max(qty, 1), i.moq || 1);
      value = qty * i.unitCost;
      return {
        code: 'ORDER_NOW',
        label: 'Raise a purchase order',
        detail: 'Position ' + Math.round(i.position) + ' is at or below the reorder point of ' + i.reorderPoint +
          '. Order ' + qty + ' units from ' + i.supplier + ' (lead time ' + i.leadTime + ' days)' +
          (i.daysToStockout !== null ? '; stock runs out in about ' + i.daysToStockout + ' days' : '') +
          (i.willStockOut ? ' — that is sooner than the supplier can deliver.' : '.'),
        qty: qty, value: value, urgency: i.willStockOut ? 'critical' : 'serious'
      };
    }

    if (i.status === 'dead') {
      return {
        code: 'LIQUIDATE',
        label: 'Write off or liquidate',
        detail: 'No demand recorded in the last ' + i.demand.length + ' months while ' + Math.round(i.onHand) +
          ' units sit in stock. Clear it and stop carrying the cost.',
        qty: Math.round(i.onHand), value: i.stockValue, urgency: 'serious'
      };
    }

    if (i.status === 'slow') {
      var target = Math.round(i.avgDaily * 60);
      return {
        code: 'REDUCE_STOCK',
        label: 'Reduce safety stock',
        detail: 'Demand fell ' + Math.abs(Math.round(i.trendPct * 100)) + '% between the first and second half of the period. ' +
          'Cut the reorder point toward ' + target + ' units (about 60 days of the new run rate) and let stock draw down.',
        qty: Math.max(0, Math.round(i.position - target)), value: Math.max(0, (i.position - target) * i.unitCost),
        urgency: 'serious'
      };
    }

    if (i.status === 'overstock') {
      return {
        code: 'STOP_ORDERING',
        label: 'Stop ordering',
        detail: 'Holding ' + (i.daysOfCover === null ? 'more than a year' : i.daysOfCover + ' days') +
          ' of cover against a max level of ' + i.maxLevel + ' units. ' + i.excessUnits +
          ' units are excess. Suspend replenishment until cover drops below ' + o.overstockCoverDays + ' days.',
        qty: i.excessUnits, value: i.excessValue, urgency: 'warning'
      };
    }

    if (i.trendPct >= 0.25 && (i.abc === 'A' || i.abc === 'B')) {
      var uplift = Math.round(i.eoq * (1 + Math.min(i.trendPct, 1)));
      return {
        code: 'INCREASE_ORDER_QTY',
        label: 'Increase order quantity',
        detail: 'Demand is up ' + Math.round(i.trendPct * 100) + '% across the period on a class ' + i.abc +
          ' item. Raise the standard order from ' + i.eoq + ' to about ' + uplift +
          ' units and revisit the supply agreement with ' + i.supplier + '.',
        qty: uplift, value: uplift * i.unitCost, urgency: 'warning'
      };
    }

    if (i.xyz === 'Z' && i.annualDemand > 0) {
      var extra = Math.round(i.safetyStock * 0.5);
      return {
        code: 'RAISE_SAFETY_STOCK',
        label: 'Raise safety stock',
        detail: 'Demand is volatile (coefficient of variation ' + i.cv.toFixed(2) +
          '). Add roughly ' + extra + ' units of buffer, or shorten the review cycle, to hold the service level.',
        qty: extra, value: extra * i.unitCost, urgency: 'warning'
      };
    }

    return {
      code: 'HOLD',
      label: 'No action',
      detail: 'Cover of ' + (i.daysOfCover === null ? '—' : i.daysOfCover + ' days') +
        ' sits between the reorder point and the max level. Continue the current policy.',
      qty: 0, value: 0, urgency: 'good'
    };
  }

  /* ------------------------------------------------------------------ *
   * Which supplier should the buyer call first?
   * ------------------------------------------------------------------ */
  function rollupSuppliers(items) {
    var by = {};
    items.forEach(function (i) {
      var s = by[i.supplier] || (by[i.supplier] = {
        supplier: i.supplier, skus: 0, atRisk: 0, orderLines: 0, orderValue: 0,
        excessValue: 0, annualSpend: 0, leadTimes: [], criticalLines: 0
      });
      s.skus++;
      s.annualSpend += i.annualValue;
      s.leadTimes.push(i.leadTime);
      if (i.status === 'stockout') s.atRisk++;
      if (i.willStockOut) s.criticalLines++;
      if (i.action.code === 'ORDER_NOW') { s.orderLines++; s.orderValue += i.action.value; }
      if (i.status === 'overstock' || i.status === 'slow') s.excessValue += i.excessValue;
    });

    return Object.keys(by).map(function (k) {
      var s = by[k];
      s.avgLeadTime = Math.round(mean(s.leadTimes));
      delete s.leadTimes;
      // Priority favours money on the line, then lines that cannot wait, then long lead times.
      s.priority = s.orderValue + (s.criticalLines * 250000) + (s.avgLeadTime * 5000 * s.orderLines);
      s.recommendation = s.orderLines
        ? 'Consolidate one purchase order covering ' + s.orderLines + ' line' + (s.orderLines === 1 ? '' : 's') +
          ' worth ' + Math.round(s.orderValue).toLocaleString('en-US') + '. Average lead time ' + s.avgLeadTime + ' days' +
          (s.criticalLines ? ', and ' + s.criticalLines + ' line' + (s.criticalLines === 1 ? '' : 's') +
            ' will run out before delivery — expedite those.' : '.')
        : (s.excessValue > 0
            ? 'No orders needed. ' + Math.round(s.excessValue).toLocaleString('en-US') +
              ' of excess stock sits against this supplier — pause replenishment and discuss returns.'
            : 'No action required this cycle.');
      return s;
    }).sort(function (a, b) { return b.priority - a.priority; });
  }

  return {
    version: VERSION,
    STATUS: STATUS,
    DEFAULTS: DEFAULTS,
    parseCSV: parseCSV,
    inferProfile: inferProfile,
    analyze: analyze,
    _internals: { mean: mean, stdev: stdev, toNum: toNum, Z: Z, recommend: recommend }
  };
}));
