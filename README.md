# Restock — inventory decision assistant

**Which SKUs to buy, and which to stop buying.**

Most inventory reporting tells you what you have. It rarely tells you what to do. Restock reads an
inventory export — Excel or CSV — works out the reorder point, safety stock and economic order
quantity for every line, and turns that into decisions with quantities and rupee figures attached:
order this today, stop ordering that, this one stopped selling six months ago, call this supplier
first.

**Live demo:** https://yousufhasan48017.github.io/restock/
*(Press "Analyse the sample inventory" — 60 SKUs of a Pakistani distributor's stock, generated with
planted patterns. There is a downloadable `.xlsx` too, to exercise the Excel path.)*

---

## The design decision that matters

The same split as [Cleanroom](https://github.com/yousufhasan48017/cleanroom):

| | Who does it | Why |
|---|---|---|
| **Column mapping** — which column is the SKU? which are demand history? | Language model | Every client's export has different headers. Hard to hardcode, easy for a model. |
| **The mathematics** — safety stock, reorder point, EOQ, classification | Deterministic code | A buyer will be asked to justify a purchase order. "The model said so" is not an answer. |

The model never produces a quantity. Every number can be traced to a formula, which is why the
settings panel lets you change the service level and watch the whole plan recalculate. With no
model endpoint configured, a built-in heuristic mapper takes over and the tool still works
end to end — which is why the public demo needs no API key.

---

## The mathematics

Standard formulas, stated plainly rather than hidden:

```
σ over lead time   = σ_daily × √LT           demand variability scales with the square root of time
safety stock       = z × σ_LT                z from the target service level (95% → 1.645)
reorder point      = daily demand × LT + safety stock
EOQ                = √(2DS / H)              Wilson: D annual demand, S order cost, H holding cost
order-up-to level  = reorder point + EOQ
```

Then each SKU is classified twice:

- **ABC** by cumulative share of annual value — A to 80%, B to 95%, C the tail. On the sample file,
  27% of SKUs carry 79.8% of the value.
- **XYZ** by coefficient of variation of demand — X below 0.5 (steady), Y to 1.0, Z above (lumpy,
  hard to forecast simply).

And assigned exactly one status, in priority order:

| Status | Test |
|---|---|
| **Stockout risk** | position ≤ reorder point. Flagged *critical* if stock runs out before the supplier's lead time — the order is already late. |
| **Dead stock** | no demand at all across the period, but stock on the shelf |
| **Slow moving** | second half of the period ≤ 35% of the first half — demand has collapsed |
| **Overstock** | position above the max level *and* more than 120 days of cover |
| **Healthy** | none of the above |

### What comes out

- **Six portfolio KPIs** — stock on hand, suggested buy, sales at risk, excess, dead stock, turns
- **An action queue** — every SKU needing a decision, ranked by urgency then by money, each with a
  quantity rounded up to the MOQ and a value
- **Value concentration curve** — cumulative share of value against share of SKUs, with the class A
  cut-off marked
- **Stock value by status** — how much of the money on the shelf is actually working
- **Class against status matrix** — a problem in class A costs far more than the same problem in
  class C, and this is where you look first
- **Supplier priority** — who to call first, ranked by order value, lines that cannot wait, and
  lead time, with a recommendation per supplier
- **Every SKU** — demand sparkline, cover, and the policy numbers behind its recommendation
- CSV export of both the action list and the full SKU table

On the sample file: **PKR 30.9M** on the shelf, **PKR 4.0M** to buy across 6 short lines, **PKR
32.2M** of annual sales at risk, and **PKR 11.1M** of working capital sitting in excess and dead
stock.

---

## Reading Excel without a library

`.xlsx` is a ZIP of XML. Rather than pull in a spreadsheet dependency, `xlsx.js` walks the ZIP
central directory itself and inflates the two entries that matter — `xl/worksheets/sheet1.xml` and
`xl/sharedStrings.xml` — using the browser's built-in `DecompressionStream`. Around 200 lines, no
dependencies, and it handles shared strings, inline strings, sparse rows and column references past
Z.

It needs `DecompressionStream`, so very old browsers fall back to a clear message pointing at the
CSV path.

`tools/make-xlsx.js` writes a genuine `.xlsx` — ZIP headers, central directory, CRC32 — so the demo
can offer a real Excel file and the reader can be tested against one.

---

## Running it

No build step, no dependencies.

```bash
git clone https://github.com/yousufhasan48017/restock.git
cd restock
# open index.html, or serve the folder
```

Tests — 76 assertions, no framework:

```bash
npm test          # engine (55) + xlsx reader (21)
```

The engine tests include a worked textbook example (D=12,000, S=2,500, C=100, H=22% → EOQ 1,651) so
the formulas are pinned, not just the outputs.

Regenerate the sample data:

```bash
npm run build:sample   # CSV → embedded JS → .xlsx
```

The generator is seeded, so the sample file never churns between runs.

---

## Your file needs

| Column | Required | Notes |
|---|---|---|
| SKU / item code | yes | anything identifying the line |
| On-hand quantity | yes | |
| Unit cost | yes | for any value figure to mean anything |
| Demand history | yes | **at least two periods** in separate columns — `demand_jan`, `Jan`, `m1`, `period_1` are all recognised |
| Lead time (days) | no | defaults to 14 |
| Supplier, description, category, on-order, MOQ | no | improves the output |

Headers are matched case-insensitively against a list of patterns; anything unrecognised is ignored
rather than guessed at.

---

## Limitations

- **Single-echelon.** One location. No transfers between warehouses, no distribution planning.
- **Demand is treated as normally distributed**, which is the standard assumption behind the z-score
  safety stock formula and a poor one for genuinely intermittent demand. Z-class items are flagged
  precisely because that assumption is weakest there; Croston's method would be the right answer and
  is not implemented.
- **No seasonality decomposition.** Seasonal SKUs show up in the sparkline and inflate the variability
  measure, which raises their safety stock. That is safe but not optimal.
- **No supplier reliability data.** Lead time is treated as fixed; in reality lead time variance often
  matters more than demand variance.
- **Browser-side**, so it suits files up to a few thousand SKUs rather than a full enterprise master.

---

Built by [Yousuf Hasan](https://yousufhasan48017.github.io) — business analyst, Karachi.
Supply chain management and data science background, which is where the formulas come from.
