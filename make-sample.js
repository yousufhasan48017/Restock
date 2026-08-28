/**
 * Generates data/inventory.csv — a realistic distributor inventory file.
 *
 * Seeded and deterministic: the same seed always produces the same file, so
 * the tests can assert exact figures. Each SKU is built from an archetype
 * (healthy, stockout risk, overstock, slow, dead, seasonal, trending) so the
 * demo has clear, explainable signals in it rather than noise.
 *
 *   node tools/make-sample.js
 */
var fs = require('fs');
var path = require('path');

/* deterministic PRNG — no Math.random, so the file never churns */
function rng(seed) {
  var s = seed >>> 0;
  return function () {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}
var rand = rng(20260828);
function between(lo, hi) { return lo + rand() * (hi - lo); }
/* Log-uniform: many cheap/low-volume lines, a few expensive/high-volume ones.
   Real inventories are Pareto-skewed, and a uniform draw flattens ABC into
   meaninglessness — 40% of SKUs came out class A before this was added. */
function logBetween(lo, hi) { return Math.exp(between(Math.log(lo), Math.log(hi))); }
function pick(arr) { return arr[Math.floor(rand() * arr.length)]; }
function round(n) { return Math.max(0, Math.round(n)); }

/* Suppliers are assigned by category — a tea company does not supply face wash. */
var SUPPLIERS_BY_CATEGORY = {
  Pharma:          [{ name: 'Searle Pakistan', lead: 21 }, { name: 'Getz Pharma', lead: 28 }],
  'FMCG Food':     [{ name: 'National Foods', lead: 10 }, { name: 'Shan Foods', lead: 9 }, { name: 'Bisconi Foods', lead: 7 }],
  Beverages:       [{ name: 'Tapal Tea', lead: 12 }, { name: 'Nestle Pakistan', lead: 16 }],
  'Home Care':     [{ name: 'Unilever Pakistan', lead: 14 }, { name: 'Colgate-Palmolive', lead: 18 }],
  'Personal Care': [{ name: 'Unilever Pakistan', lead: 14 }, { name: 'Colgate-Palmolive', lead: 18 }],
  Packaging:       [{ name: 'Packages Limited', lead: 25 }, { name: 'Roshan Packages', lead: 20 }]
};

var CATALOGUE = {
  Pharma: ['Paracetamol 500mg 10x10', 'Amoxicillin 250mg Caps', 'ORS Sachets 21g', 'Cough Syrup 120ml',
           'Antacid Suspension 200ml', 'Multivitamin Tabs 30s', 'Ibuprofen 400mg 20s', 'Cetirizine 10mg 10s'],
  'FMCG Food': ['Basmati Rice 5kg', 'Cooking Oil 5L Tin', 'Wheat Flour 10kg', 'Red Chilli Powder 200g',
                'Turmeric Powder 200g', 'Biryani Masala 50g', 'Tea Whitener 1L', 'Salt Iodised 800g'],
  Beverages: ['Black Tea 950g', 'Green Tea 100 Bags', 'Mango Juice 1L', 'Carbonated Cola 1.5L',
              'Mineral Water 1.5L x6', 'Energy Drink 250ml'],
  'Home Care': ['Detergent Powder 1kg', 'Dishwash Liquid 500ml', 'Floor Cleaner 1L', 'Bleach 500ml',
                'Air Freshener 300ml'],
  'Personal Care': ['Toothpaste 150g', 'Bath Soap 100g x3', 'Shampoo 400ml', 'Hand Sanitiser 250ml',
                    'Face Wash 100ml', 'Shaving Cream 70g'],
  Packaging: ['Corrugated Box 12x8x6', 'Stretch Film 500mm', 'Adhesive Tape 2in', 'Shrink Wrap Roll',
              'Carton Label Roll 1000s']
};

/* Archetypes. `cover` is the target days of stock on hand — the lever that
   decides whether a SKU reads as short, healthy or drowning in stock. */
var ARCHETYPES = [
  { key: 'healthy',    n: 16, base: [200, 900],  cv: [0.10, 0.28], cover: [55, 85],   trend: 0 },
  { key: 'stockout',   n: 8,  base: [300, 1200], cv: [0.15, 0.40], cover: [3, 14],    trend: 0.15 },
  { key: 'overstock',  n: 8,  base: [80, 400],   cv: [0.10, 0.30], cover: [260, 520], trend: -0.1 },
  { key: 'slow',       n: 6,  base: [40, 160],   cv: [0.35, 0.70], cover: [150, 300], trend: -0.55 },
  { key: 'dead',       n: 4,  base: [0, 0],      cv: [0, 0],       cover: [0, 0],     trend: 0 },
  { key: 'seasonal',   n: 6,  base: [150, 700],  cv: [0, 0],       cover: [45, 110],  trend: 0 },
  { key: 'trendingUp', n: 6,  base: [150, 600],  cv: [0.12, 0.25], cover: [40, 70],   trend: 0.9 },
  { key: 'trendingDn', n: 6,  base: [200, 800],  cv: [0.12, 0.25], cover: [110, 220], trend: -0.7 }
];

var rows = [];
var used = {};
var counter = 1000;

function makeDemand(a) {
  // volume itself is skewed too — a handful of lines carry the throughput
  var base = between(a.base[0], a.base[1]) * logBetween(0.25, 4.5);
  var cv = between(a.cv[0], a.cv[1]);
  var d = [];
  for (var m = 0; m < 12; m++) {
    var v;
    if (a.key === 'dead') {
      v = 0;
    } else if (a.key === 'seasonal') {
      // two peaks — Ramadan-style pull forward and a year-end lift
      var season = 1 + 0.85 * Math.sin((m / 12) * 2 * Math.PI * 2 - 1.1);
      v = base * season * (1 + between(-0.08, 0.08));
    } else {
      var drift = 1 + a.trend * (m / 11);          // linear trend across the year
      var noise = 1 + between(-cv, cv);
      v = base * drift * noise;
    }
    d.push(round(v));
  }
  if (a.key === 'slow') {                            // dries up in the second half
    for (var k = 6; k < 12; k++) d[k] = round(d[k] * between(0.05, 0.25));
  }
  return d;
}

ARCHETYPES.forEach(function (a) {
  for (var i = 0; i < a.n; i++) {
    var category = pick(Object.keys(CATALOGUE));
    var desc;
    var guard = 0;
    do { desc = pick(CATALOGUE[category]); guard++; } while (used[category + desc] && guard < 40);
    used[category + desc] = true;

    var supplier = pick(SUPPLIERS_BY_CATEGORY[category]);
    var demand = makeDemand(a);
    var avgMonthly = demand.reduce(function (s, v) { return s + v; }, 0) / 12;
    var avgDaily = avgMonthly / 30.44;

    var unitCost = category === 'Pharma' ? logBetween(18, 3200)
                 : category === 'Packaging' ? logBetween(8, 420)
                 : logBetween(22, 2400);
    unitCost = Math.round(unitCost * 100) / 100;

    var cover = between(a.cover[0], a.cover[1]);
    var onHand = a.key === 'dead' ? round(between(60, 400)) : round(avgDaily * cover);
    // a few short SKUs already have replenishment moving
    var onOrder = (a.key === 'stockout' && rand() < 0.4) ? round(avgMonthly * between(0.3, 0.8)) : 0;

    var moq = round(Math.max(10, avgMonthly * between(0.25, 0.8) / 10) * 10);

    rows.push({
      sku: category.slice(0, 2).toUpperCase() + '-' + (++counter),
      description: desc,
      category: category,
      supplier: supplier.name,
      unit_cost: unitCost.toFixed(2),
      on_hand: onHand,
      on_order: onOrder,
      lead_time_days: supplier.lead + Math.round(between(-3, 5)),
      moq: moq,
      demand: demand,
      _archetype: a.key
    });
  }
});

var MONTHS = ['sep', 'oct', 'nov', 'dec', 'jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug'];
var header = ['sku', 'description', 'category', 'supplier', 'unit_cost', 'on_hand', 'on_order',
              'lead_time_days', 'moq'].concat(MONTHS.map(function (m) { return 'demand_' + m; }));

var lines = [header.join(',')];
rows.forEach(function (r) {
  var cells = [r.sku, r.description, r.category, r.supplier, r.unit_cost, r.on_hand, r.on_order,
               r.lead_time_days, r.moq].concat(r.demand);
  lines.push(cells.map(function (c) {
    var s = String(c);
    return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  }).join(','));
});

var out = lines.join('\n') + '\n';
fs.writeFileSync(path.join(__dirname, '..', 'data', 'inventory.csv'), out, 'utf8');

var byType = {};
rows.forEach(function (r) { byType[r._archetype] = (byType[r._archetype] || 0) + 1; });
console.log('Wrote data/inventory.csv — ' + rows.length + ' SKUs, ' + out.length + ' bytes');
console.log('Archetypes: ' + Object.keys(byType).map(function (k) { return k + '=' + byType[k]; }).join(', '));
