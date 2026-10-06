/* Plat Book: a private deal analyzer and OKC map for two people.
   No build step. Edit this file, push to GitHub, done. */
(() => {
'use strict';

const CFG = window.PLATBOOK_CONFIG || {};
const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const sum = a => a.reduce((x, y) => x + y, 0);
const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n));
const num = v => (Number.isFinite(+v) ? +v : 0);
const debounce = (fn, ms) => { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; };
const uid = () => (crypto.randomUUID ? crypto.randomUUID() : 'id-' + Date.now() + '-' + Math.random().toString(16).slice(2));

const usd = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 });
const money = n => (Number.isFinite(n) ? usd.format(Math.round(n)) : '—');
const signed = n => (Number.isFinite(n) ? (n < 0 ? '−' + usd.format(Math.abs(Math.round(n))) : usd.format(Math.round(n))) : '—');
const pct = (n, d = 1) => (Number.isFinite(n) ? n.toFixed(d) + '%' : '—');
const tone = n => (n > 0.5 ? 'pos' : n < -0.5 ? 'neg' : '');

const APP = CFG.appName || 'Plat Book';
document.title = APP; $('#appName').textContent = APP;

const configured = !!(CFG.supabaseUrl && CFG.supabaseAnonKey && window.supabase);
const sb = configured ? window.supabase.createClient(CFG.supabaseUrl, CFG.supabaseAnonKey, { auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true } }) : null;
const LS_KEY = 'platbook.deals.v1';

let deals = [];          // [{ id, data, updated_at }]
let currentId = null;
let pending = new Set(); // ids waiting to save

/* =====================================================================
   THE MATH
   Everything below is plain arithmetic, monthly unless it says otherwise.
   ===================================================================== */
const STAGES = [['watching', 'Watching'], ['analyzing', 'Running numbers'], ['offer', 'Offer made'], ['contract', 'Under contract'], ['owned', 'Owned'], ['passed', 'Passed']];
const KIND = u => ['house', 'house', 'duplex', 'triplex', 'fourplex'][clamp(u, 1, 4)];

function blankDeal(over = {}) {
  return Object.assign({
    name: 'Untitled deal', address: '', lat: null, lng: null, stage: 'watching', mode: 'rent', example: true,
    price: 185000, closingPct: 3, rehab: 8000, arv: 0,
    units: 1, rents: [1550, 1450, 1450, 1450], otherIncome: 0, myRentNow: 1100,
    downPct: 20, rate: 6.75, term: 30, miPct: 0.55,
    taxPct: 1.2, insurance: 2600, hoa: 0, utilities: 0,
    vacancyPct: 6, repairsPct: 6, capexPct: 6, mgmtPct: 8,
    appreciationPct: 3, notes: ''
  }, over);
}

function calc(d, t = {}) {
  const k = { rentMul: 1, rateAdd: 0, vacMul: 1, ...t };
  const price = num(d.price), rehab = num(d.rehab);
  const units = clamp(Math.round(num(d.units)) || 1, 1, 4);
  const hack = d.mode === 'hack' && units > 1;

  // purchase + loan
  const closing = price * num(d.closingPct) / 100;
  const down = price * num(d.downPct) / 100;
  const loan = Math.max(price - down, 0);
  const r = (num(d.rate) + k.rateAdd) / 100 / 12, n = Math.max(num(d.term), 1) * 12;
  const pi = loan > 0 ? (r > 0 ? loan * r / (1 - Math.pow(1 + r, -n)) : loan / n) : 0;
  const mi = num(d.downPct) < 20 ? loan * num(d.miPct) / 100 / 12 : 0;
  const debt = pi + mi;

  // income
  const rents = (d.rents || []).slice(0, units).map(x => num(x) * k.rentMul);
  while (rents.length < units) rents.push(0);
  const other = num(d.otherIncome) * k.rentMul;
  const fullRent = sum(rents) + other;                 // every unit rented at market
  const rentIn = hack ? fullRent - rents[0] : fullRent; // what actually comes in
  const vacancy = rentIn * num(d.vacancyPct) * k.vacMul / 100;
  const egi = rentIn - vacancy;

  // costs (repairs + big replacements apply to the whole building, even the unit you live in)
  const tax = price * num(d.taxPct) / 100 / 12;
  const ins = num(d.insurance) / 12;
  const repairs = fullRent * num(d.repairsPct) / 100;
  const capex = fullRent * num(d.capexPct) / 100;
  const mgmt = rentIn * num(d.mgmtPct) / 100;
  const hoa = num(d.hoa), util = num(d.utilities);
  const opex = tax + ins + repairs + capex + mgmt + hoa + util;

  const noi = egi - opex;
  const cashflow = noi - debt;
  const invested = down + closing + rehab;
  const allIn = price + rehab;

  return {
    price, rehab, units, hack, closing, down, loan, r, pi, mi, debt, rents, fullRent, rentIn, vacancy, egi,
    tax, ins, repairs, capex, mgmt, hoa, util, opex, noi, cashflow, invested, allIn,
    capRate: allIn > 0 ? noi * 12 / allIn * 100 : NaN,
    coc: invested > 0 ? cashflow * 12 / invested * 100 : NaN,
    dscr: debt > 0 ? noi / debt : Infinity,
    onePct: allIn > 0 ? fullRent / allIn * 100 : NaN,
    breakEvenOcc: fullRent > 0 ? (opex + debt) / fullRent * 100 : NaN
  };
}

function balanceAfter(c, months) {
  if (c.loan <= 0) return 0;
  if (c.r === 0) return Math.max(c.loan - c.pi * months, 0);
  const g = Math.pow(1 + c.r, months);
  return Math.max(c.loan * g - c.pi * (g - 1) / c.r, 0);
}

function bisect(f, lo, hi) { // f decreasing; find x where f(x) = 0
  if (f(lo) < 0 || f(hi) > 0) return null;
  for (let i = 0; i < 50; i++) { const m = (lo + hi) / 2; if (f(m) > 0) lo = m; else hi = m; }
  return (lo + hi) / 2;
}

function analyze(d) {
  const now = calc(d);
  const asRental = calc({ ...d, mode: 'rent' });
  const value0 = num(d.arv) > 0 ? num(d.arv) : now.price;
  const g = num(d.appreciationPct) / 100;
  const paydown5 = now.loan - balanceAfter(now, 60);
  const appreciation5 = value0 * (Math.pow(1 + g, 5) - 1);
  const instant = num(d.arv) > 0 ? num(d.arv) - now.allIn : 0;
  let cash5, cashLabel;
  if (now.hack) {
    const myCost = -now.cashflow, saved = num(d.myRentNow) - myCost;
    cash5 = saved * 12 + asRental.cashflow * 48;
    cashLabel = 'Rent saved in year one, then 4 years of rental cash flow';
  } else {
    cash5 = now.cashflow * 60;
    cashLabel = 'Cash flow, 5 years';
  }
  const rentalForBE = { ...d, mode: 'rent' };
  const beRentMul = bisect(m => -calc(rentalForBE, { rentMul: m }).cashflow, 0, 6); // cash flow rises with rent, so flip the sign
  const bePrice = bisect(p => calc({ ...rentalForBE, price: p }).cashflow, 0, Math.max(now.price * 3, 1));
  const stress = [
    ['As entered', {}],
    ['Rents 10% lower', { rentMul: 0.9 }],
    ['Rate 1 point higher', { rateAdd: 1 }],
    ['Vacancy doubled', { vacMul: 2 }],
    ['All three at once', { rentMul: 0.9, rateAdd: 1, vacMul: 2 }]
  ].map(([label, t]) => [label, calc(d, t).cashflow]);
  return {
    now, asRental, paydown5, appreciation5, instant, cash5, cashLabel, stress,
    total5: cash5 + paydown5 + appreciation5 + instant,
    beRent: beRentMul == null ? null : sum(asRental.rents) * beRentMul + num(d.otherIncome) * beRentMul,
    bePrice
  };
}

/* =====================================================================
   INPUTS
   ===================================================================== */
const SECTIONS = [
  { title: 'Purchase', fields: [
    ['price', 'Purchase price', '$', { step: 1000 }],
    ['closingPct', 'Closing costs', '%', { hint: 'Lender, title and inspection fees. Usually 2–4% of the price.' }],
    ['rehab', 'Repairs before renting', '$', { step: 500, hint: 'Anything you fix or upgrade up front.' }],
    ['arv', 'Value after repairs', '$', { step: 1000, hint: 'Optional. What it would appraise for once fixed up. Leave at 0 to skip.' }]
  ] },
  { title: 'Rent', rents: true, fields: [
    ['otherIncome', 'Other income', '$/mo', { hint: 'Laundry, parking or storage. Usually 0.' }],
    ['myRentNow', 'What you pay to live now', '$/mo', { hint: 'Your rent or housing cost today, for comparison.', hackOnly: true }]
  ] },
  { title: 'Loan', fields: [
    ['downPct', 'Down payment', '%', { step: 0.5, hint: 'Investor loans usually need 20–25%. An FHA loan on a home you live in can be 3.5%.' }],
    ['rate', 'Interest rate', '%', { step: 0.125, hint: 'Ask a lender for today’s rate. A quarter point changes the payment.' }],
    ['term', 'Loan length', 'years', {}],
    ['miPct', 'Mortgage insurance', '%/yr', { step: 0.05, hint: 'Charged when you put down less than 20%. FHA runs about 0.55% a year.', showIf: d => num(d.downPct) < 20 }]
  ] },
  { title: 'Ongoing costs', fields: [
    ['taxPct', 'Property tax', '%/yr', { step: 0.05, hint: 'Share of the price paid in tax each year. Check the real bill on the county assessor site.' }],
    ['insurance', 'Insurance', '$/yr', { step: 100, hint: 'Oklahoma premiums run high because of hail and wind. Get a real quote.' }],
    ['vacancyPct', 'Empty between tenants', '%', { hint: 'Share of the year a unit sits empty. 5–8% is typical.' }],
    ['repairsPct', 'Repairs', '% of rent', { hint: 'Small fixes: leaks, appliances, paint between tenants.' }],
    ['capexPct', 'Big replacements', '% of rent', { hint: 'Saving up for a roof, HVAC or water heater. Older houses need more.' }],
    ['mgmtPct', 'Property manager', '% of rent', { hint: '0 if you two manage it yourselves. Managers usually charge 8–10%.' }],
    ['hoa', 'HOA dues', '$/mo', {}],
    ['utilities', 'Utilities you pay', '$/mo', { hint: 'Water, trash or gas the owner covers. Common in duplexes.' }]
  ] },
  { title: 'Looking ahead', fields: [
    ['appreciationPct', 'Yearly value growth', '%', { step: 0.5, hint: 'A guess, not a promise. 2–4% a year is a middle-of-the-road assumption.' }]
  ] }
];

function fieldHTML(key, label, unit, o, d, extraAttr = '') {
  const pre = unit === '$';
  const v = key.startsWith('rent') ? d.rents[+key.slice(4)] : d[key];
  return `<div class="row" data-row="${key}" ${o.showIf && !o.showIf(d) ? 'hidden' : ''}>
    <label for="f-${key}">${label}${o.tag ? ` <span class="unit-tag">${o.tag}</span>` : ''}${o.hint ? `<span class="hint">${o.hint}</span>` : ''}</label>
    <div class="field">${pre ? '<span>$</span>' : ''}<input id="f-${key}" data-k="${key}" type="number" inputmode="decimal" step="${o.step || 'any'}" min="0" value="${esc(v)}" ${extraAttr}>${pre ? '' : `<span>${unit}</span>`}</div>
  </div>`;
}

function inputsHTML(d) {
  const hack = d.mode === 'hack';
  return SECTIONS.map(s => {
    let rows = '';
    if (s.rents) {
      rows += `<div class="row"><label>Units<span class="hint">1 for a house, up to 4 for a fourplex. Loans on 1–4 units count as residential.</span></label>
        <div class="units"><button type="button" data-units="-1" aria-label="Fewer units">−</button><output id="unitsOut">${d.units}</output><button type="button" data-units="1" aria-label="More units">+</button></div></div>`;
      for (let i = 0; i < d.units; i++) {
        const mine = hack && i === 0;
        rows += fieldHTML('rent' + i, mine ? 'Your unit' : `Unit ${i + 1} rent`, '$/mo',
          { step: 25, tag: mine ? 'you live here' : '', hint: mine ? 'What it would rent for once you move out.' : (i === 0 ? 'Look at what similar places nearby rent for.' : '') }, d);
      }
    }
    rows += s.fields.filter(([, , , o]) => !o.hackOnly || hack).map(([k, l, u, o]) => fieldHTML(k, l, u, o, d)).join('');
    return `<fieldset><legend>${s.title}</legend>${rows}</fieldset>`;
  }).join('');
}

/* =====================================================================
   RESULTS
   ===================================================================== */
function metric(label, value, why, cls = '') {
  return `<details class="metric"><summary><span>${label}</span><span class="v ${cls}">${value}</span></summary><p class="why">${why}</p></details>`;
}

function resultsHTML(d) {
  const a = analyze(d), c = a.now, rc = a.asRental, kind = KIND(c.units);
  let say, sub, list = '';

  const why = {
    cash: `Down payment (${money(c.down)}), closing costs (${money(c.closing)}) and repairs (${money(c.rehab)}). Plan to keep a separate cushion on top of this, often 3–6 months of expenses, for surprises.`,
    pay: `Principal and interest on a ${money(c.loan)} loan${c.mi ? `, plus ${money(c.mi)} a month of mortgage insurance` : ''}. Taxes and insurance are counted separately below.`,
    cf: 'What’s left each month after the mortgage and every expense, including money set aside for repairs and vacancy. Positive means the property pays you.',
    coc: 'Your yearly cash flow divided by the cash you put in. Compare it to what that money would earn elsewhere; a savings account pays a few percent with no tenants.',
    cap: 'The yearly profit before the mortgage, divided by the total cost. It describes the property itself, ignoring how you financed it, so you can compare deals fairly. Higher means more income for the price.',
    dscr: 'Rent after expenses divided by the mortgage payment. 1.0 means rent exactly covers the mortgage. Lenders and careful investors usually want 1.25 or more as a safety margin.',
    one: 'A quick screening rule: monthly rent at or above 1% of the total cost tends to cash flow. Most OKC houses land under it now, so treat it as a rough first filter, not a verdict.',
    beo: 'How full the building has to be, on average, just to cover every cost. Lower is safer. Above about 90% leaves little room for error.'
  };

  if (c.hack) {
    const myCost = -c.cashflow, saved = num(d.myRentNow) - myCost;
    if (myCost <= 0) {
      say = `You’d live here for free, and the other ${c.units === 2 ? 'unit pays' : 'units pay'} you ${money(-myCost)} a month on top.`;
    } else {
      say = `Living here would cost you ${money(myCost)} a month.`;
    }
    sub = (myCost > 0 ? (saved >= 0
      ? `That’s ${money(saved)} less than the ${money(num(d.myRentNow))} you pay now, and you’d be building equity instead of paying a landlord.`
      : `That’s ${money(-saved)} more than you pay now. The trade: you build equity, and you own a rental when you move out.`) : 'You’d be building equity while your tenants cover the costs.')
      + ` Once you move out and rent your unit for ${money(c.rents[0])}, the ${kind} would ${rc.cashflow >= 0 ? `pay you ${money(rc.cashflow)}` : `cost you ${money(-rc.cashflow)}`} a month.`;
    list = metric('Cash needed to buy', money(c.invested), why.cash)
      + metric('Mortgage payment', money(c.debt) + '/mo', why.pay)
      + metric('Your cost to live here', signed(myCost) + '/mo', 'Everything you pay each month (mortgage, taxes, insurance, upkeep) minus the rent your tenants pay you.', myCost <= 0 ? 'pos' : '')
      + metric('Compared with now', (saved >= 0 ? 'saves ' : 'costs ') + money(Math.abs(saved)) + '/mo', 'Your current housing cost minus your cost to live here.', tone(saved))
      + metric('Cash flow after you move out', signed(rc.cashflow) + '/mo', why.cf, tone(rc.cashflow))
      + metric('Cash-on-cash after you move out', pct(rc.coc), why.coc, tone(rc.coc))
      + metric('Cap rate', pct(rc.capRate), why.cap)
      + metric('Rent covers the mortgage', Number.isFinite(rc.dscr) ? rc.dscr.toFixed(2) + '×' : 'no loan', why.dscr, rc.dscr >= 1.25 ? 'pos' : rc.dscr >= 1 ? 'thin' : 'neg');
  } else {
    const cf = c.cashflow;
    if (cf >= 0 && c.dscr >= 1.25) {
      say = `This ${kind} pays you ${money(cf)} a month after every expense.`;
      sub = `That’s a ${pct(c.coc)} yearly return on the ${money(c.invested)} you’d put in, and rent covers the mortgage ${Number.isFinite(c.dscr) ? c.dscr.toFixed(2) + ' times' : 'easily'}, a comfortable cushion.`;
    } else if (cf >= 0) {
      say = `This ${kind} pays you ${money(cf)} a month, but the margin is thin.`;
      sub = `One vacancy or a broken water heater could erase several months of profit. Rent covers the mortgage ${c.dscr.toFixed(2)} times; lenders like to see about 1.25.`;
    } else {
      say = `This ${kind} would cost you ${money(-cf)} a month to hold.`;
      const bits = [];
      if (a.beRent != null) bits.push(`total rent of about ${money(a.beRent)} a month`);
      if (a.bePrice != null && a.bePrice > 0) bits.push(`a price near ${money(Math.round(a.bePrice / 500) * 500)}`);
      sub = bits.length ? `To break even at these terms, it would need ${bits.join(', or ')}. That gives you a starting point for an offer or tells you to keep looking.` : 'The costs outrun the rent at almost any price. Check the numbers or keep looking.';
    }
    list = metric('Cash needed to buy', money(c.invested), why.cash)
      + metric('Mortgage payment', money(c.debt) + '/mo', why.pay)
      + metric('Monthly cash flow', signed(cf), why.cf, tone(cf))
      + metric('Cash-on-cash return', pct(c.coc), why.coc, tone(c.coc))
      + metric('Cap rate', pct(c.capRate), why.cap)
      + metric('Rent covers the mortgage', Number.isFinite(c.dscr) ? c.dscr.toFixed(2) + '×' : 'no loan', why.dscr, c.dscr >= 1.25 ? 'pos' : c.dscr >= 1 ? 'thin' : 'neg')
      + metric('1% rule', pct(c.onePct, 2), why.one, c.onePct >= 1 ? 'pos' : '')
      + metric('Break-even occupancy', pct(c.breakEvenOcc, 0), why.beo, c.breakEvenOcc <= 85 ? 'pos' : c.breakEvenOcc <= 95 ? 'thin' : 'neg');
  }

  // where each rent dollar goes (building fully rented)
  const R = rc.fullRent || 1;
  const parts = [
    ['Mortgage', rc.debt, 'var(--ink)'],
    ['Taxes & insurance', rc.tax + rc.ins, 'var(--muted)'],
    ['Upkeep', rc.repairs + rc.capex, 'var(--faint)'],
    ['Vacancy, manager, other', rc.vacancy + rc.mgmt + rc.hoa + rc.util, 'var(--line)'],
    ['Left over', Math.max(rc.cashflow, 0), 'var(--good)']
  ];
  const short = rc.cashflow < 0;
  const scale = short ? (rc.fullRent - rc.cashflow) || 1 : R; // when short, the bar is total costs
  const bars = parts.map(([, v, col]) => `<i style="width:${Math.max(v, 0) / scale * 100}%;background:${col}"></i>`).join('');
  const legend = parts.filter(p => p[1] > 0.5).map(([l, v, col]) => `<span><b style="background:${col}"></b>${l} ${money(v)}</span>`).join('');
  const barNote = short ? `<p class="fine neg" style="margin:6px 0 0">Rent covers ${pct(rc.fullRent / scale * 100, 0)} of these costs. The other ${money(-rc.cashflow)} a month would come from you.</p>` : '';

  // monthly line items
  const lines = (x) => [
    ['Rent collected', x.rentIn], ['Empty-unit allowance', -x.vacancy], ['Property tax', -x.tax], ['Insurance', -x.ins],
    ['Repairs', -x.repairs], ['Big replacements', -x.capex], ['Property manager', -x.mgmt], ['HOA and utilities', -(x.hoa + x.util)],
    ['Before the mortgage', x.noi, true], ['Mortgage', -x.debt], [c.hack ? 'Net' : 'Cash flow', x.cashflow, true]
  ];
  const L1 = lines(c), L2 = c.hack ? lines(rc) : null;
  const table = `<table><thead><tr><th>Each month</th><th>${c.hack ? 'Living there' : 'Amount'}</th>${c.hack ? '<th>After move-out</th>' : ''}</tr></thead><tbody>`
    + L1.map((row, i) => (Math.abs(row[1]) < 0.5 && !row[2] && (!L2 || Math.abs(L2[i][1]) < 0.5)) ? '' :
      `<tr${row[2] ? ' style="font-weight:600"' : ''}><td>${row[0]}</td><td class="${row[2] ? tone(row[1]) : ''}">${signed(row[1])}</td>${L2 ? `<td class="${row[2] ? tone(L2[i][1]) : ''}">${signed(L2[i][1])}</td>` : ''}</tr>`).join('')
    + '</tbody></table>';

  const stressRows = a.stress.map(([l, v]) => {
    const shown = c.hack ? -v : v;
    return `<tr><td>${l}</td><td class="${c.hack ? (shown <= num(d.myRentNow) ? 'pos' : 'neg') : tone(v)}">${signed(shown)}</td></tr>`;
  }).join('');
  const worst = a.stress[a.stress.length - 1][1];
  const stressNote = c.hack
    ? 'Your monthly cost to live there if things go wrong. Green means still at or under what you pay now.'
    : (a.stress[0][1] < 0 ? 'It already loses money as entered. These show how much worse it could get.' : worst >= 0 ? 'Even with all three going wrong at once, it still pays for itself.' : a.stress[1][1] >= 0 ? 'It survives one thing going wrong. All three at once would cost you money each month.' : 'Small changes push it negative, so the margin for error is slim.');

  const fiveRows = [
    [a.cashLabel, a.cash5], ['Loan paid down by rent', a.paydown5], [`Value growth at ${pct(num(d.appreciationPct))} a year`, a.appreciation5]
  ].concat(a.instant ? [['Equity from repairs (value after repairs − total cost)', a.instant]] : [])
    .map(([l, v]) => `<tr><td>${l}</td><td class="${tone(v)}">${signed(v)}</td></tr>`).join('');

  return `<div class="verdict">
      <p class="say">${say}</p><p class="sub">${sub}</p>
      <div class="metrics">${list}</div>
    </div>
    <div class="block"><h3>${short ? 'What it costs each month, fully rented' : 'Where the rent goes, fully rented'}</h3><div class="bars" role="img" aria-label="Breakdown of monthly rent">${bars}</div><div class="legend">${legend}</div>${barNote}</div>
    <div class="block"><h3>If things go wrong</h3><p class="fine">${stressNote}</p><div class="tbl-wrap"><table><thead><tr><th>Scenario</th><th>${c.hack ? 'Your monthly cost' : 'Monthly cash flow'}</th></tr></thead><tbody>${stressRows}</tbody></table></div></div>
    <div class="block"><h3>Five years from now</h3><p class="fine">An estimate that holds rents and costs flat${c.hack ? ' and assumes you live there one year, the usual minimum on owner-occupied loans' : ''}. Real results will differ.</p>
      <div class="tbl-wrap"><table><tbody>${fiveRows}<tr style="font-weight:600"><td>Total gain on ${money(c.invested)} invested</td><td class="${tone(a.total5)}">${signed(a.total5)}</td></tr></tbody></table></div></div>
    <div class="block"><h3>Every number, monthly</h3><div class="tbl-wrap">${table}</div></div>
    <p class="fine" style="margin-top:16px">This is arithmetic on the numbers you entered, not financial advice. Verify taxes, insurance and rents before you offer.</p>`;
}

/* =====================================================================
   SHEET (one deal)
   ===================================================================== */
function current() { return deals.find(x => x.id === currentId); }

function renderSheet() {
  const sheet = $('#sheet'), rec = current();
  if (!rec) {
    sheet.innerHTML = `<div class="verdict"><p class="say">Start with a property you’ve seen.</p><p class="sub">Add a deal, type in the price and what it would rent for, and you’ll know in a minute whether it pays for itself.</p><div class="foot"><button class="btn" id="emptyNew">New deal</button></div></div>`;
    $('#emptyNew').onclick = () => newDeal();
    return;
  }
  const d = rec.data;
  sheet.innerHTML = `
    <div class="sheet-head">
      <div class="title">
        <label class="sr" for="dealName">Deal name</label><input id="dealName" class="name" value="${esc(d.name)}" maxlength="80">
        <label class="sr" for="dealAddr">Address</label><input id="dealAddr" class="addr" value="${esc(d.address)}" placeholder="Add an address" maxlength="140">
      </div>
      <div class="mode" role="group" aria-label="Plan for this property">
        <button type="button" data-mode="rent" aria-pressed="${d.mode !== 'hack'}">Rent it out</button>
        <button type="button" data-mode="hack" aria-pressed="${d.mode === 'hack'}">Live in one unit</button>
      </div>
      <label class="sr" for="dealStage">Stage</label>
      <select id="dealStage" class="stage">${STAGES.map(([v, l]) => `<option value="${v}" ${d.stage === v ? 'selected' : ''}>${l}</option>`).join('')}</select>
    </div>
    ${d.example ? '<p class="example">These are example numbers. Replace them with the real listing as you go, and the verdict updates as you type.</p>' : ''}
    <div class="cols">
      <form class="inputs" id="inputs" onsubmit="return false">${inputsHTML(d)}
        <fieldset class="notes"><legend>Notes</legend><label class="sr" for="dealNotes">Notes</label><textarea id="dealNotes" placeholder="What you noticed on the walk-through, who the agent is, questions to ask…">${esc(d.notes)}</textarea></fieldset>
        <div class="foot">
          <button type="button" class="btn quiet" id="locate">${d.lat != null ? 'Show on map' : 'Find on map'}</button>
          <button type="button" class="btn quiet" id="dupe">Duplicate</button>
          <button type="button" class="btn danger" id="del">Delete deal</button>
        </div>
      </form>
      <div class="results-col" id="results" aria-live="polite">${resultsHTML(d)}</div>
    </div>`;
  wireSheet();
}

function refreshResults() {
  const rec = current(); if (!rec) return;
  $('#results').innerHTML = resultsHTML(rec.data);
  $$('#inputs [data-row]').forEach(row => {
    const f = SECTIONS.flatMap(s => s.fields).find(x => x[0] === row.dataset.row);
    if (f && f[3].showIf) row.hidden = !f[3].showIf(rec.data);
  });
  renderLedger();
}

function wireSheet() {
  const rec = current(), d = rec.data;
  const changed = (rerender) => { touch(rec); if (rerender) { renderSheet(); renderLedger(); } else refreshResults(); };

  $('#inputs').addEventListener('input', e => {
    const k = e.target.dataset.k; if (!k) return;
    const v = e.target.value === '' ? 0 : +e.target.value;
    if (k.startsWith('rent')) d.rents[+k.slice(4)] = v; else d[k] = v;
    if (d.example) { d.example = false; $('.example')?.remove(); }
    changed(false);
  });
  $$('[data-units]').forEach(b => b.onclick = () => {
    d.units = clamp(d.units + +b.dataset.units, 1, 4);
    if (d.units === 1 && d.mode === 'hack') { d.mode = 'rent'; toast('Living in one unit needs at least 2 units, so this switched to Rent it out.'); }
    changed(true);
  });
  $$('[data-mode]').forEach(b => b.onclick = () => {
    const m = b.dataset.mode; if (m === d.mode) return;
    d.mode = m;
    if (m === 'hack') {
      const notes = [];
      if (d.units < 2) { d.units = 2; notes.push('2 units'); }
      if (num(d.downPct) === 20) { d.downPct = 3.5; notes.push('3.5% down, FHA style'); }
      if (num(d.mgmtPct) === 8) { d.mgmtPct = 0; notes.push('no property manager'); }
      if (notes.length) toast('Set to ' + notes.join(', ') + '. Change anything that doesn’t fit.');
    } else {
      if (num(d.downPct) === 3.5) d.downPct = 20;
    }
    changed(true);
  });
  $('#dealName').addEventListener('input', e => { d.name = e.target.value || 'Untitled deal'; changed(false); });
  $('#dealAddr').addEventListener('input', e => { d.address = e.target.value; d.lat = d.lng = null; changed(false); $('#locate').textContent = 'Find on map'; });
  $('#dealStage').onchange = e => { d.stage = e.target.value; changed(false); drawPins(); };
  $('#dealNotes').addEventListener('input', e => { d.notes = e.target.value; touch(rec); });
  $('#dupe').onclick = () => newDeal({ ...structuredClone(d), name: d.name + ' (copy)', example: false });
  $('#del').onclick = () => removeDeal(rec);
  $('#locate').onclick = async () => {
    if (d.lat == null) {
      if (!d.address.trim()) { toast('Add an address first, or tap the spot on the map.'); return; }
      const hit = (await geocode(d.address))[0];
      if (!hit) { toast('Couldn’t find that address in the OKC area. Try adding the ZIP code.'); return; }
      d.lat = +hit.lat; d.lng = +hit.lon; touch(rec);
    }
    show('map'); map.setView([d.lat, d.lng], 17); drawPins();
  };
}

/* =====================================================================
   LEDGER (list of deals)
   ===================================================================== */
function renderLedger() {
  const list = $('#dealList');
  $('#ledgerEmpty').hidden = deals.length > 0;
  list.innerHTML = deals.map(rec => {
    const d = rec.data, c = calc(d);
    const v = c.hack ? -c.cashflow : c.cashflow;
    const stage = (STAGES.find(s => s[0] === d.stage) || STAGES[0])[1];
    return `<li><button data-id="${rec.id}" aria-current="${rec.id === currentId}">
      <span class="stake" data-stage="${esc(d.stage)}" aria-hidden="true"></span>
      <span class="nm">${esc(d.name)}</span>
      <span class="cf ${c.hack ? '' : tone(v)}">${c.hack ? money(v) + ' to live' : signed(v) + '/mo'}</span>
      <span class="meta">${stage}, ${KIND(c.units)}, ${money(c.price)}</span>
    </button></li>`;
  }).join('');
  $$('button[data-id]', list).forEach(b => b.onclick = () => { currentId = b.dataset.id; renderSheet(); renderLedger(); if (innerWidth < 760) $('#analyzer').scrollIntoView({ behavior: 'smooth' }); });
}

function newDeal(data = {}) {
  const rec = { id: uid(), data: blankDeal(data), updated_at: new Date().toISOString() };
  deals.unshift(rec); currentId = rec.id;
  touch(rec); renderLedger(); renderSheet(); show('deals');
  setTimeout(() => $('#dealName')?.select(), 50);
  return rec;
}

async function removeDeal(rec) {
  if (!confirm(`Delete “${rec.data.name}”? ${configured ? 'This removes it for both of you. ' : ''}This can’t be undone.\n\nTip: setting the stage to “Passed” keeps it for reference instead.`)) return;
  deals = deals.filter(x => x !== rec);
  currentId = deals[0]?.id || null;
  if (configured) {
    const { error } = await sb.from('deals').delete().eq('id', rec.id);
    if (error) toast('Couldn’t delete on the server: ' + error.message);
  } else saveLocal();
  renderLedger(); renderSheet(); drawPins();
}

/* =====================================================================
   SAVING
   Local mode: this browser only. Cloud mode: Supabase, shared by the team.
   ===================================================================== */
function setSync(t) { $('#syncState').textContent = t; }
function saveLocal() { try { localStorage.setItem(LS_KEY, JSON.stringify(deals)); } catch (e) { setSync('Couldn’t save in this browser'); } }
function loadLocal() { try { deals = JSON.parse(localStorage.getItem(LS_KEY) || '[]').map(r => ({ ...r, data: blankDeal(r.data) })); } catch (e) { deals = []; } }

const flush = debounce(async () => {
  if (!configured) { saveLocal(); return; }
  const ids = [...pending]; pending.clear();
  const rows = deals.filter(r => ids.includes(r.id)).map(r => ({ id: r.id, data: r.data, updated_at: r.updated_at }));
  if (!rows.length) return;
  setSync('Saving…');
  const { error } = await sb.from('deals').upsert(rows);
  if (error) { ids.forEach(i => pending.add(i)); setSync('Not saved yet, retrying'); setTimeout(flush, 4000); }
  else if (!pending.size) setSync('Saved');
}, 700);

function touch(rec) {
  rec.updated_at = new Date().toISOString();
  pending.add(rec.id);
  if (!configured) saveLocal(); else setSync('Saving…');
  flush();
}

async function loadCloud() {
  const { data, error } = await sb.from('deals').select('id,data,updated_at').order('updated_at', { ascending: false });
  if (error) { setSync('Couldn’t load: ' + error.message); return false; }
  // keep local edits that haven't reached the server yet
  const mine = new Map(deals.filter(r => pending.has(r.id)).map(r => [r.id, r]));
  deals = data.map(r => mine.get(r.id) || { ...r, data: blankDeal(r.data) });
  mine.forEach((r, id) => { if (!deals.some(x => x.id === id)) deals.unshift(r); });
  if (!deals.some(r => r.id === currentId)) currentId = deals[0]?.id || null;
  setSync('Saved'); return true;
}

document.addEventListener('visibilitychange', async () => {
  if (document.visibilityState !== 'visible' || !configured || pending.size || !signedIn) return;
  const focused = document.activeElement && $('#sheet').contains(document.activeElement);
  if (await loadCloud()) { renderLedger(); if (!focused) renderSheet(); drawPins(); }
});

/* =====================================================================
   SIGN-IN (only when Supabase is connected)
   ===================================================================== */
let signedIn = false;

function showSignIn(mode, note = '') {
  const f = $('#signin'); $('#veil').hidden = false;
  const email = esc(CFG.email || '');
  const forms = {
    in: `<h1>${esc(APP)}</h1><p>Sign in to your shared workspace.</p>
      <label for="siEmail">Email</label><input id="siEmail" type="email" autocomplete="username" value="${email}" required>
      <label for="siPw">Password</label><input id="siPw" type="password" autocomplete="current-password" required>
      <button class="btn" id="siGo">Sign in</button><p class="err" id="siErr">${esc(note)}</p>
      <div class="alt"><button type="button" class="link" id="siForgot">Forgot password?</button></div>`,
    forgot: `<h1>Reset password</h1><p>We’ll email you a link to choose a new one.</p>
      <label for="siEmail">Email</label><input id="siEmail" type="email" autocomplete="username" value="${email}" required>
      <button class="btn" id="siGo">Send reset link</button><p class="err" id="siErr">${esc(note)}</p>
      <div class="alt"><button type="button" class="link" id="siBack">Back to sign in</button></div>`,
    reset: `<h1>New password</h1><p>Choose a password with at least 8 characters.</p>
      <label for="siPw">New password</label><input id="siPw" type="password" autocomplete="new-password" minlength="8" required>
      <button class="btn" id="siGo">Save password</button><p class="err" id="siErr">${esc(note)}</p>`
  };
  f.innerHTML = forms[mode];
  f.onsubmit = async e => {
    e.preventDefault();
    const go = $('#siGo'), err = $('#siErr'); go.disabled = true; err.textContent = '';
    const em = $('#siEmail')?.value.trim(), pw = $('#siPw')?.value;
    let res;
    if (mode === 'in') res = await sb.auth.signInWithPassword({ email: em, password: pw });
    else if (mode === 'forgot') res = await sb.auth.resetPasswordForEmail(em, { redirectTo: location.origin + location.pathname });
    else res = await sb.auth.updateUser({ password: pw });
    go.disabled = false;
    if (res.error) {
      err.textContent = /invalid login/i.test(res.error.message) ? 'That email and password don’t match. Check both and try again.' : res.error.message;
      return;
    }
    if (mode === 'forgot') { err.style.color = 'var(--good)'; err.textContent = 'Check your email for the reset link.'; return; }
    if (mode === 'reset') { history.replaceState(null, '', location.pathname); toast('Password saved'); }
    enter();
  };
  $('#siForgot') && ($('#siForgot').onclick = () => showSignIn('forgot'));
  $('#siBack') && ($('#siBack').onclick = () => showSignIn('in'));
  setTimeout(() => f.querySelector('input')?.focus(), 30);
}

async function enter() {
  const { data: ok, error } = await sb.rpc('is_member');
  if (error) { showSignIn('in', 'Signed in, but the database isn’t set up yet. Run supabase/setup.sql (README, step 2).'); await sb.auth.signOut(); return; }
  if (!ok) { await sb.auth.signOut(); showSignIn('in', 'This account isn’t on the team list. Add its email to public.members in Supabase.'); return; }
  signedIn = true; $('#veil').hidden = true; $('#signOut').hidden = false;
  setSync('Loading…');
  await loadCloud();
  renderLedger(); renderSheet(); drawPins();
}

$('#signOut').onclick = async () => {
  if (pending.size && !confirm('Some changes haven’t saved yet. Sign out anyway?')) return;
  await sb.auth.signOut(); signedIn = false; deals = []; currentId = null; renderLedger(); renderSheet(); showSignIn('in');
};

/* =====================================================================
   TABS
   ===================================================================== */
function show(which) {
  ['deals', 'map'].forEach(w => {
    $('#view-' + w).hidden = w !== which;
    $('#tab-' + w).setAttribute('aria-selected', w === which);
  });
  if (which === 'map') { initMap(); setTimeout(() => map.invalidateSize(), 0); }
  if (location.hash !== '#' + which && !/access_token|type=|error=/.test(location.hash)) history.replaceState(null, '', '#' + which);
}
$('#tab-deals').onclick = () => show('deals');
$('#tab-map').onclick = () => show('map');
$('#newDeal').onclick = () => newDeal();

/* =====================================================================
   SAVE TO / LOAD FROM A FILE
   For backups, and for handing deals to each other without a database.
   Loading merges: new deals are added, and a deal you both have keeps
   whichever copy was edited most recently.
   ===================================================================== */
$('.ledger').insertAdjacentHTML('beforeend', `<div class="ledger-foot">
  <p class="fine">${configured ? 'Deals are shared with your team.' : 'Deals live in this browser only. Save them to a file to back up or send to Will.'}</p>
  <div class="filebtns"><button type="button" class="btn quiet" id="exportDeals">Save to file</button><button type="button" class="btn quiet" id="importDeals">Load a file</button></div>
  <input type="file" id="importFile" accept=".json,application/json" hidden>
</div>`);

$('#exportDeals').onclick = () => {
  if (!deals.length) { toast('There are no deals to save yet.'); return; }
  const stamp = new Date().toISOString().slice(0, 10);
  const blob = new Blob([JSON.stringify({ app: 'platbook', version: 1, saved: new Date().toISOString(), deals }, null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob); a.download = `platbook-deals-${stamp}.json`;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  toast(`Saved ${deals.length} deal${deals.length === 1 ? '' : 's'} to a file.`);
};

$('#importDeals').onclick = () => $('#importFile').click();
$('#importFile').onchange = async e => {
  const file = e.target.files[0]; e.target.value = '';
  if (!file) return;
  let incoming;
  try {
    const j = JSON.parse(await file.text());
    incoming = Array.isArray(j) ? j : j.deals;
    if (!Array.isArray(incoming)) throw new Error();
    incoming = incoming.filter(r => r && r.id && r.data && typeof r.data === 'object');
  } catch (err) { toast('That file isn’t a Plat Book deals file.'); return; }
  let added = 0, updated = 0, kept = 0;
  incoming.forEach(r => {
    const rec = { id: String(r.id), data: blankDeal(r.data), updated_at: r.updated_at || new Date(0).toISOString() };
    const have = deals.find(x => x.id === rec.id);
    if (!have) { deals.push(rec); added++; pending.add(rec.id); }
    else if (rec.updated_at > have.updated_at) { have.data = rec.data; have.updated_at = rec.updated_at; updated++; pending.add(rec.id); }
    else kept++;
  });
  deals.sort((a, b) => (b.updated_at > a.updated_at ? 1 : -1));
  if (!currentId) currentId = deals[0]?.id || null;
  if (configured) flush(); else { saveLocal(); pending.clear(); }
  renderLedger(); renderSheet(); drawPins();
  const bits = [];
  if (added) bits.push(`added ${added}`);
  if (updated) bits.push(`updated ${updated}`);
  if (kept) bits.push(`kept your newer copy of ${kept}`);
  toast(bits.length ? 'Loaded: ' + bits.join(', ') + '.' : 'That file had no deals in it.');
};

function toast(t) {
  const el = $('#toast'); el.textContent = t; el.classList.add('show');
  clearTimeout(toast.t); toast.t = setTimeout(() => el.classList.remove('show'), 3800);
}

/* =====================================================================
   MAP
   City of OKC and FEMA publish their layers as public ArcGIS map services.
   We ask them for a transparent picture of whatever is on screen and lay it
   over the base map, so there's nothing to download or pay for.
   ===================================================================== */
const OKC = 'https://gis.okc.gov/arcgis/rest/services/Public/Data_OKC_Gov_Application_Service/MapServer';
const FEMA = 'https://hazards.fema.gov/arcgis/rest/services/public/NFHL/MapServer';
const LAYERS = [
  { key: 'zoning', label: 'Zoning', svc: 'okc', ids: [6], on: true },
  { key: 'overlay', label: 'Zoning overlays and special districts', svc: 'okc', ids: [2, 1], on: false },
  { key: 'lots', label: 'Lot lines', svc: 'okc', ids: [4], on: true },
  { key: 'plats', label: 'Subdivision plats', svc: 'okc', ids: [5], on: false },
  { key: 'landuse', label: 'planokc land use plan', svc: 'okc', ids: [11], on: false },
  { key: 'limits', label: 'City limits', svc: 'okc', ids: [7], on: true },
  { key: 'flood', label: 'FEMA flood zones', svc: 'fema', ids: [28], on: true },
  { key: 'deals', label: 'Our deals', svc: 'pins', on: true }
];
const ZONES = [ // City of OKC base districts (plain-English names; always check the code for what's allowed)
  ['SPUD', 'Simplified Planned Unit Development: custom rules for this site'], ['PUD', 'Planned Unit Development: custom rules for this site'],
  ['R-1ZL', 'Single-family, zero lot line'], ['R-1', 'Single-family residential'], ['R-2', 'Medium-low density residential'],
  ['R-3', 'Medium density residential'], ['R-4', 'General residential'], ['R-MH', 'Manufactured home'], ['RA', 'Rural residential'],
  ['AA', 'Agricultural'], ['O-1', 'Limited office'], ['O-2', 'General office'], ['NB', 'Neighborhood business'],
  ['C-1', 'Neighborhood commercial'], ['C-3', 'Community commercial'], ['C-4', 'General commercial'], ['C-HC', 'Highway commercial'],
  ['I-1', 'Light industrial'], ['I-2', 'Moderate industrial'], ['I-3', 'Heavy industrial'], ['DBD', 'Downtown business']
];
const zoneName = code => { const c = String(code || '').toUpperCase().trim(); const z = ZONES.find(([k]) => c === k || c.startsWith(k + '-') || c.startsWith(k + ' ') || c.startsWith(k)); return z ? z[1] : ''; };

let map, base, okcLayer, femaLayer, pinGroup, tapMarker;
const layerOn = Object.fromEntries(LAYERS.map(l => [l.key, l.on]));

const ArcPicture = window.L ? L.Layer.extend({
  initialize(url, opacity) { this.url = url; this.opacity = opacity; this.ids = []; this.seq = 0; },
  onAdd(m) { this._m = m; this._go = debounce(() => this.redraw(), 300); m.on('moveend resize', this._go); this.redraw(); },
  onRemove(m) { m.off('moveend resize', this._go); if (this.img) m.removeLayer(this.img); this.img = null; },
  setIds(ids) { this.ids = ids; this.redraw(); },
  redraw() {
    const m = this._m; if (!m) return;
    if (!this.ids.length) { if (this.img) { m.removeLayer(this.img); this.img = null; } return; }
    const b = m.getBounds(), s = m.getSize();
    const sw = L.CRS.EPSG3857.project(b.getSouthWest()), ne = L.CRS.EPSG3857.project(b.getNorthEast());
    const q = new URLSearchParams({ bbox: [sw.x, sw.y, ne.x, ne.y].join(','), bboxSR: 3857, imageSR: 3857, size: s.x + ',' + s.y, dpi: 96, format: 'png32', transparent: true, layers: 'show:' + this.ids.join(','), f: 'image' });
    const mySeq = ++this.seq;
    const img = L.imageOverlay(this.url + '/export?' + q, b, { opacity: this.opacity, className: 'okc-layer', interactive: false });
    img.once('load', () => {
      if (mySeq !== this.seq) { m.removeLayer(img); return; }
      if (this.img && this.img !== img) m.removeLayer(this.img);
      this.img = img;
    });
    img.once('error', () => { m.removeLayer(img); });
    img.addTo(m);
  }
}) : null;

// Base maps that need no API key. Chosen one is remembered in this browser.
const isDark = () => document.documentElement.dataset.theme === 'dark' || (document.documentElement.dataset.theme !== 'light' && matchMedia('(prefers-color-scheme: dark)').matches);
const ESRI = 'https://server.arcgisonline.com/ArcGIS/rest/services/';
const ESRI_ATTR = 'Tiles © <a href="https://www.esri.com/">Esri</a>';
const BASEMAPS = {
  street: { label: 'Street', make: () => L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', { maxNativeZoom: 19, maxZoom: 20, attribution: '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors' }) },
  satellite: { label: 'Satellite', make: () => L.tileLayer(ESRI + 'World_Imagery/MapServer/tile/{z}/{y}/{x}', { maxNativeZoom: 19, maxZoom: 20, attribution: ESRI_ATTR + ', Maxar, Earthstar Geographics' }) },
  quiet: { label: 'Quiet', make: () => L.tileLayer(ESRI + 'Canvas/' + (isDark() ? 'World_Dark_Gray_Base' : 'World_Light_Gray_Base') + '/MapServer/tile/{z}/{y}/{x}', { maxNativeZoom: 16, maxZoom: 20, attribution: ESRI_ATTR }) }
};
let baseKey = 'street';
try { const saved = localStorage.getItem('platbook.basemap'); if (BASEMAPS[saved]) baseKey = saved; } catch (e) {}

function setBase(key) {
  baseKey = key;
  if (base) map.removeLayer(base);
  base = BASEMAPS[key].make().addTo(map);
  base.bringToBack();
  try { localStorage.setItem('platbook.basemap', key); } catch (e) {}
}

function initMap() {
  if (map) return;
  map = L.map('map', { zoomControl: false, attributionControl: true }).setView([35.4676, -97.5164], 12);
  L.control.zoom({ position: 'topright' }).addTo(map);
  map.attributionControl.addAttribution('City of OKC, FEMA');
  setBase(baseKey);
  matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => { if (baseKey === 'quiet') setBase('quiet'); });
  okcLayer = new ArcPicture(OKC, 0.62).addTo(map);
  femaLayer = new ArcPicture(FEMA, 0.5).addTo(map);
  pinGroup = L.layerGroup().addTo(map);
  applyLayers(); drawPins();

  $('#layerList').innerHTML = `<div class="basepick" role="radiogroup" aria-label="Base map">${Object.entries(BASEMAPS).map(([k, b]) =>
      `<label><input type="radio" name="basemap" value="${k}" ${k === baseKey ? 'checked' : ''}><span>${b.label}</span></label>`).join('')}</div>` + LAYERS.map(l => `<label class="layer"><input type="checkbox" data-layer="${l.key}" ${layerOn[l.key] ? 'checked' : ''}>${l.key === 'deals' ? '<i style="background:var(--flag)"></i>' : ''}${l.label}</label>`).join('');
  $('#layerList').insertAdjacentHTML('beforeend', `<p class="fine zoomhint" id="zoomHint" hidden>You’re zoomed out. Zoning, lot lines and plats only draw at street level. <button type="button" class="link" id="zoomIn">Zoom in here</button></p>`);
  $('#zoomIn').onclick = () => map.setZoom(17);
  const hint = () => { $('#zoomHint').hidden = map.getZoom() >= 16; };
  map.on('zoomend', hint); hint();
  $$('input[name="basemap"]').forEach(r => r.onchange = () => setBase(r.value));
  $$('[data-layer]').forEach(cb => cb.onchange = () => { layerOn[cb.dataset.layer] = cb.checked; applyLayers(); });

  map.on('click', e => inspect(e.latlng));
}

function applyLayers() {
  if (!map) return;
  okcLayer.setIds(LAYERS.filter(l => l.svc === 'okc' && layerOn[l.key]).flatMap(l => l.ids));
  femaLayer.setIds(layerOn.flood ? [28] : []);
  if (layerOn.deals) pinGroup.addTo(map); else map.removeLayer(pinGroup);
}

function drawPins() {
  if (!map) return;
  pinGroup.clearLayers();
  deals.filter(r => r.data.lat != null).forEach(rec => {
    const d = rec.data, c = calc(d), v = c.hack ? -c.cashflow : c.cashflow;
    const icon = L.divIcon({ className: '', html: `<div class="pin ${d.stage === 'passed' ? 'passed' : d.stage === 'owned' ? 'owned' : ''}"></div>`, iconSize: [16, 16], iconAnchor: [8, 16] });
    const mk = L.marker([d.lat, d.lng], { icon, title: d.name, keyboard: true }).addTo(pinGroup);
    mk.bindPopup(`<div class="pop"><h4>${esc(d.name)}</h4><div class="addr">${esc(d.address || KIND(c.units))}</div>
      <dl><dt>Price</dt><dd>${money(c.price)}</dd><dt>${c.hack ? 'Cost to live' : 'Cash flow'}</dt><dd class="${c.hack ? '' : tone(v)}">${c.hack ? money(v) : signed(v)}/mo</dd></dl>
      <div class="acts"><button class="btn" data-open="${rec.id}">Open deal</button></div></div>`);
  });
}

document.addEventListener('click', e => {
  const o = e.target.closest('[data-open]');
  if (o) { currentId = o.dataset.open; renderLedger(); renderSheet(); show('deals'); }
});

async function getJSON(url, ms = 9000) {
  const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), ms);
  try { const r = await fetch(url, { signal: ctl.signal }); if (!r.ok) throw new Error(r.status); return await r.json(); }
  finally { clearTimeout(t); }
}

async function identify(url, ids, ll) {
  const b = map.getBounds(), s = map.getSize();
  const q = new URLSearchParams({ geometry: `${ll.lng},${ll.lat}`, geometryType: 'esriGeometryPoint', sr: 4326, layers: 'all:' + ids.join(','), tolerance: 2, mapExtent: [b.getWest(), b.getSouth(), b.getEast(), b.getNorth()].join(','), imageDisplay: `${s.x},${s.y},96`, returnGeometry: false, f: 'json' });
  const j = await getJSON(url + '/identify?' + q);
  if (j.error) throw new Error(j.error.message);
  return j.results || [];
}

function floodText(results) {
  const r = results.find(x => x.attributes && (x.attributes.FLD_ZONE || x.attributes['Flood Zone']));
  if (!r) return { label: 'Not in a mapped flood zone', note: 'Minimal risk on FEMA’s map.' };
  const z = r.attributes.FLD_ZONE || r.attributes['Flood Zone'], sub = String(r.attributes.ZONE_SUBTY || '');
  if (/^(A|V)/i.test(z)) return { label: 'Zone ' + z + ', high risk', note: 'About a 1% chance of flooding each year. Lenders usually require flood insurance here.', bad: true };
  if (/0\.2/.test(sub)) return { label: 'Zone X, moderate risk', note: 'Outside the high-risk area but within the 500-year floodplain.' };
  return { label: 'Zone ' + z + ', minimal risk', note: 'Outside FEMA’s high- and moderate-risk areas.' };
}

async function inspect(ll) {
  if (tapMarker) map.removeLayer(tapMarker);
  tapMarker = L.circleMarker(ll, { radius: 7, color: getComputedStyle(document.documentElement).getPropertyValue('--flag').trim() || '#E0457B', weight: 3, fillOpacity: 0.15 }).addTo(map);
  const pop = L.popup({ maxWidth: 300 }).setLatLng(ll).setContent('<div class="pop"><h4>This spot</h4><div class="addr">Looking it up…</div></div>').openOn(map);

  const [addrR, okcR, femaR] = await Promise.allSettled([
    getJSON(`https://nominatim.openstreetmap.org/reverse?format=jsonv2&zoom=18&addressdetails=1&lat=${ll.lat}&lon=${ll.lng}`),
    identify(OKC, [6, 2], ll),
    identify(FEMA, [28], ll)
  ]);

  let address = '', short = 'This spot';
  if (addrR.status === 'fulfilled' && addrR.value?.address) {
    const a = addrR.value.address;
    short = [a.house_number, a.road].filter(Boolean).join(' ') || a.road || 'This spot';
    address = [short !== 'This spot' ? short : '', a.city || a.town || a.village, a.postcode].filter(Boolean).join(', ');
  }

  let zoningHTML;
  if (okcR.status === 'fulfilled') {
    const straight = okcR.value.find(r => r.layerId === 6), over = okcR.value.filter(r => r.layerId === 2).map(r => r.value).filter(Boolean);
    zoningHTML = straight ? `${esc(straight.value)}${zoneName(straight.value) ? `<small>${esc(zoneName(straight.value))}</small>` : ''}` : 'Outside OKC zoning';
    if (over.length) zoningHTML += `<small>Overlay: ${esc([...new Set(over)].join(', '))}</small>`;
  } else {
    zoningHTML = `Couldn’t read it here<small><a href="https://data.okc.gov/" target="_blank" rel="noopener">Check the city map</a></small>`;
  }
  let floodHTML;
  if (femaR.status === 'fulfilled') { const f = floodText(femaR.value); floodHTML = `<span class="${f.bad ? 'neg' : ''}">${esc(f.label)}</span><small>${esc(f.note)}</small>`; }
  else floodHTML = `Couldn’t read it here<small><a href="https://msc.fema.gov/portal/advanceSearch" target="_blank" rel="noopener">Check FEMA’s map</a></small>`;

  pop.setContent(`<div class="pop"><h4>${esc(short)}</h4><div class="addr">${esc(address || `${ll.lat.toFixed(5)}, ${ll.lng.toFixed(5)}`)}</div>
    <dl><dt>Zoning</dt><dd>${zoningHTML}</dd><dt>Flood</dt><dd>${floodHTML}</dd></dl>
    <div class="acts"><button class="btn" id="popAnalyze">Run numbers here</button>
      <a href="https://www.google.com/maps/@?api=1&map_action=pano&viewpoint=${ll.lat},${ll.lng}" target="_blank" rel="noopener">Street view</a>
      <a href="https://www.oklahomacounty.org/elected-offices/assessor" target="_blank" rel="noopener">County records</a></div></div>`);
  setTimeout(() => {
    const b = $('#popAnalyze'); if (!b) return;
    b.onclick = () => { map.closePopup(); map.removeLayer(tapMarker); newDeal({ name: short !== 'This spot' ? short : 'New deal', address, lat: ll.lat, lng: ll.lng }); drawPins(); };
  }, 0);
}

async function geocode(q) {
  const p = new URLSearchParams({ format: 'jsonv2', q, viewbox: '-97.95,35.75,-97.1,35.25', bounded: 1, limit: 6, countrycodes: 'us' });
  try { return await getJSON('https://nominatim.openstreetmap.org/search?' + p); } catch (e) { return []; }
}

$('#searchForm').onsubmit = async e => {
  e.preventDefault();
  const q = $('#searchBox').value.trim(); if (!q) return;
  const out = $('#searchResults'); out.hidden = false; out.innerHTML = '<li class="fine" style="padding:8px 2px">Searching…</li>';
  const hits = await geocode(q);
  if (!hits.length) { out.innerHTML = '<li class="fine" style="padding:8px 2px">No match in the OKC area. Try a street number and name, or add the ZIP.</li>'; return; }
  out.innerHTML = hits.map((h, i) => `<li><button data-hit="${i}">${esc(h.display_name.replace(/, United States$/, ''))}</button></li>`).join('');
  $$('[data-hit]', out).forEach(b => b.onclick = () => {
    const h = hits[+b.dataset.hit], ll = L.latLng(+h.lat, +h.lon);
    out.hidden = true; map.setView(ll, 18); setTimeout(() => inspect(ll), 350);
  });
};

/* =====================================================================
   START
   ===================================================================== */
async function boot() {
  const want = location.hash === '#map' ? 'map' : 'deals';
  if (!configured) {
    loadLocal(); currentId = deals[0]?.id || null;
    setSync('Saved on this device only');
    renderLedger(); renderSheet(); show(want);
    return;
  }
  const recovering = /type=recovery/.test(location.hash);
  sb.auth.onAuthStateChange(ev => { if (ev === 'PASSWORD_RECOVERY') showSignIn('reset'); });
  const { data: { session } } = await sb.auth.getSession();
  show(want);
  if (recovering) showSignIn('reset');
  else if (session) enter();
  else { setSync(''); showSignIn('in'); }
}
boot();

})();
