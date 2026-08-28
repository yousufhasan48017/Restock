/**
 * Engine tests — run with:  node test/engine.test.js
 *
 * The sample file is generated from a fixed seed, so these assertions are
 * exact. If the generator changes, these numbers are expected to move.
 */
var fs = require('fs');
var path = require('path');
var R = require('../engine.js');

var passed = 0, failed = 0;
function check(name, cond, detail) {
  if (cond) { passed++; console.log('  PASS  ' + name); }
  else { failed++; console.log('  FAIL  ' + name + (detail ? '  → ' + detail : '')); }
}
function section(t) { console.log('\n' + t); }
function near(a, b, tol) { return Math.abs(a - b) <= tol; }

/* ------------------------------------------------------------------ */
section('Maths helpers');
var I = R._internals;
check('mean', I.mean([2, 4, 6]) === 4);
check('sample stdev', near(I.stdev([2, 4, 4, 4, 5, 5, 7, 9]), 2.138, 0.01), String(I.stdev([2, 4, 4, 4, 5, 5, 7, 9])));
check('stdev of one value is 0', I.stdev([5]) === 0);
check('parses "1,250.50"', I.toNum('1,250.50') === 1250.5);
check('parses "₨ 900"', I.toNum('₨ 900') === 900);
check('parses "(500)" as negative', I.toNum('(500)') === -500);
check('junk becomes 0', I.toNum('n/a') === 0);
check('z for 95% is 1.6449', I.Z[0.95] === 1.6449);

/* ------------------------------------------------------------------ */
section('Textbook worked example');
/* D = 12,000/yr, S = 2,500, C = 100, H = 22%  →  EOQ = √(2·12000·2500 / 22) = 1,651 */
var one = R.parseCSV(
  'sku,unit_cost,on_hand,on_order,lead_time_days,moq,m1,m2,m3,m4,m5,m6,m7,m8,m9,m10,m11,m12\n' +
  'A-1,100,5000,0,30,0,1000,1000,1000,1000,1000,1000,1000,1000,1000,1000,1000,1000\n');
var r1 = R.analyze(one.headers, one.rows, null, { serviceLevel: 0.95 });
var it = r1.items[0];
check('annual demand = 12,000', it.annualDemand === 12000, String(it.annualDemand));
check('EOQ ≈ 1,651', near(it.eoq, 1651, 3), String(it.eoq));
check('zero variability → zero safety stock', it.safetyStock === 0, String(it.safetyStock));
check('reorder point = 30 days of demand', near(it.reorderPoint, 985, 3), String(it.reorderPoint));
check('turns = annual demand / position', near(it.turns, 2.4, 0.01), String(it.turns));

/* variability must raise safety stock */
var two = R.parseCSV(
  'sku,unit_cost,on_hand,on_order,lead_time_days,moq,m1,m2,m3,m4,m5,m6,m7,m8,m9,m10,m11,m12\n' +
  'B-1,100,5000,0,30,0,200,1800,300,1700,400,1600,500,1500,600,1400,700,1300\n');
var r2 = R.analyze(two.headers, two.rows, null, { serviceLevel: 0.95 });
check('volatile demand → safety stock > 0', r2.items[0].safetyStock > 0, String(r2.items[0].safetyStock));
check('cv 0.5–1.0 classes as Y', r2.items[0].xyz === 'Y', r2.items[0].xyz + ' cv=' + r2.items[0].cv);

/* intermittent, lumpy demand — the classic Z profile */
var lumpy = R.parseCSV(
  'sku,unit_cost,on_hand,on_order,lead_time_days,moq,m1,m2,m3,m4,m5,m6,m7,m8,m9,m10,m11,m12\n' +
  'C-1,100,3000,0,30,0,0,0,0,5000,0,0,0,4000,0,0,0,3000\n');
var rl = R.analyze(lumpy.headers, lumpy.rows, null, {});
check('lumpy demand classes as Z', rl.items[0].xyz === 'Z', rl.items[0].xyz + ' cv=' + rl.items[0].cv);
check('lumpy demand is told to raise the buffer or reorder',
  ['RAISE_SAFETY_STOCK', 'ORDER_NOW'].indexOf(rl.items[0].action.code) > -1, rl.items[0].action.code);
var r3 = R.analyze(two.headers, two.rows, null, { serviceLevel: 0.99 });
check('99% service level demands more buffer than 95%',
  r3.items[0].safetyStock > r2.items[0].safetyStock,
  r2.items[0].safetyStock + ' → ' + r3.items[0].safetyStock);

/* ------------------------------------------------------------------ */
section('Column mapping');
var odd = R.parseCSV('Item Code,Product Name,Vendor,Unit Price,Qty On Hand,Lead Time Days,Jan,Feb,Mar,Apr\n' +
                     'X1,Widget,Acme,50,100,10,10,12,11,13\n');
var prof = R.inferProfile(odd.headers, odd.rows);
check('maps "Item Code" → sku', prof.map.sku === 'Item Code', prof.map.sku);
check('maps "Vendor" → supplier', prof.map.supplier === 'Vendor', prof.map.supplier);
check('maps "Unit Price" → unitCost', prof.map.unitCost === 'Unit Price', prof.map.unitCost);
check('maps "Qty On Hand" → onHand', prof.map.onHand === 'Qty On Hand', prof.map.onHand);
check('finds month columns as demand', prof.demand.join(',') === 'Jan,Feb,Mar,Apr', prof.demand.join(','));

/* ------------------------------------------------------------------ */
section('Full analysis of the sample inventory');
var csv = fs.readFileSync(path.join(__dirname, '..', 'data', 'inventory.csv'), 'utf8');
var parsed = R.parseCSV(csv);
var profile = R.inferProfile(parsed.headers, parsed.rows);
var rep = R.analyze(parsed.headers, parsed.rows, profile);

check('read 60 SKUs', rep.meta.skuCount === 60, String(rep.meta.skuCount));
check('read 12 demand periods', rep.meta.periods === 12, String(rep.meta.periods));
check('did not treat unit_cost as demand', profile.demand.indexOf('unit_cost') < 0);
check('did not treat on_hand as demand', profile.demand.indexOf('on_hand') < 0);
check('did not treat moq as demand', profile.demand.indexOf('moq') < 0);

function count(st) { return rep.items.filter(function (i) { return i.status === st; }).length; }
check('found stockout risks', count('stockout') >= 6, String(count('stockout')));
check('found overstock', count('overstock') >= 5, String(count('overstock')));
check('found dead stock (4 planted)', count('dead') === 4, String(count('dead')));
check('found slow movers', count('slow') >= 4, String(count('slow')));
check('found healthy items', count('healthy') >= 15, String(count('healthy')));
check('every SKU is classified',
  rep.items.every(function (i) { return !!R.STATUS[i.status]; }));

check('ABC covers every SKU', rep.items.every(function (i) { return 'ABC'.indexOf(i.abc) > -1; }));
check('XYZ covers every SKU', rep.items.every(function (i) { return 'XYZ'.indexOf(i.xyz) > -1; }));
var aItems = rep.items.filter(function (i) { return i.abc === 'A'; });
check('class A is a minority of SKUs', aItems.length < rep.meta.skuCount * 0.4,
  aItems.length + ' of ' + rep.meta.skuCount);
var aShare = aItems.reduce(function (s, i) { return s + i.annualValue; }, 0) / rep.kpis.totalAnnualValue;
check('class A holds ~80% of annual value', aShare > 0.6 && aShare <= 0.81, (aShare * 100).toFixed(1) + '%');

check('every SKU has a recommendation', rep.items.every(function (i) { return i.action && i.action.code; }));
check('stockout SKUs are told to order',
  rep.items.filter(function (i) { return i.status === 'stockout'; })
          .every(function (i) { return i.action.code === 'ORDER_NOW' && i.action.qty > 0; }));
check('order quantities respect MOQ',
  rep.items.filter(function (i) { return i.action.code === 'ORDER_NOW' && i.moq > 0; })
          .every(function (i) { return i.action.qty % i.moq === 0; }));
check('dead stock is told to liquidate',
  rep.items.filter(function (i) { return i.status === 'dead'; })
          .every(function (i) { return i.action.code === 'LIQUIDATE'; }));
check('healthy items are never told to order now',
  rep.items.filter(function (i) { return i.status === 'healthy'; })
          .every(function (i) { return i.action.code !== 'ORDER_NOW'; }));

var codes = {};
rep.items.forEach(function (i) { codes[i.action.code] = (codes[i.action.code] || 0) + 1; });
check('"increase order quantity" appears', !!codes.INCREASE_ORDER_QTY, JSON.stringify(codes));
check('"reduce safety stock" appears', !!codes.REDUCE_STOCK, JSON.stringify(codes));

check('KPIs are non-negative', rep.kpis.totalStockValue > 0 && rep.kpis.excessValue >= 0 && rep.kpis.deadValue >= 0);
check('releasable = excess + dead',
  near(rep.kpis.releasable, rep.kpis.excessValue + rep.kpis.deadValue, 0.01));
check('supplier rollup covers every supplier',
  rep.suppliers.reduce(function (s, x) { return s + x.skus; }, 0) === rep.meta.skuCount);
check('suppliers are ranked by priority',
  rep.suppliers.every(function (s, n) { return n === 0 || rep.suppliers[n - 1].priority >= s.priority; }));
check('every supplier has a recommendation', rep.suppliers.every(function (s) { return !!s.recommendation; }));

check('concentration curve starts at 0 and ends at 100',
  rep.concentration[0].pctValue === 0 &&
  near(rep.concentration[rep.concentration.length - 1].pctValue, 100, 0.05),
  rep.concentration[rep.concentration.length - 1].pctValue + '');
check('concentration curve is monotonic',
  rep.concentration.every(function (p, n) { return n === 0 || p.pctValue >= rep.concentration[n - 1].pctValue; }));
check('matrix counts reconcile to the SKU total',
  rep.matrix.reduce(function (s, row) { return s + row.total; }, 0) === rep.meta.skuCount);

/* determinism + sensitivity */
var again = R.analyze(parsed.headers, parsed.rows, profile);
check('same input → same order value', again.kpis.orderValue === rep.kpis.orderValue);
var strict = R.analyze(parsed.headers, parsed.rows, profile, { serviceLevel: 0.99 });
check('a higher service level increases the buy',
  strict.kpis.orderValue >= rep.kpis.orderValue,
  Math.round(rep.kpis.orderValue) + ' → ' + Math.round(strict.kpis.orderValue));

/* ------------------------------------------------------------------ */
section('Portfolio summary (sample file)');
function money(n) { return 'PKR ' + Math.round(n).toLocaleString('en-US'); }
console.log('  SKUs                ' + rep.meta.skuCount + ' over ' + rep.meta.periods + ' months');
console.log('  Stock on hand       ' + money(rep.kpis.totalStockValue));
console.log('  Inventory turns     ' + rep.kpis.turns + 'x');
console.log('  Suggested buy       ' + money(rep.kpis.orderValue) + '  across ' + rep.kpis.atRiskCount + ' SKUs');
console.log('  Sales at risk       ' + money(rep.kpis.salesAtRisk));
console.log('  Excess stock        ' + money(rep.kpis.excessValue));
console.log('  Dead stock          ' + money(rep.kpis.deadValue));
console.log('  Cash releasable     ' + money(rep.kpis.releasable));
console.log('  Status mix          ' + Object.keys(rep.statusTotals).map(function (k) {
  return k + '=' + rep.statusTotals[k].count;
}).join(', '));
console.log('  Top supplier        ' + rep.suppliers[0].supplier + ' — ' + rep.suppliers[0].recommendation);

console.log('\n' + passed + ' passed, ' + failed + ' failed\n');
process.exit(failed ? 1 : 0);
