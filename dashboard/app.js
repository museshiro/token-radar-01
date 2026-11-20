// Token Radar dashboard: reads window.RADAR and renders the board, detail and filters. No network.
(function () {
  'use strict';

  var DATA = window.RADAR;
  if (!DATA) return;
  var app = document.getElementById('board');
  var state = { q: '', category: 'all', chain: 'all', watchlistOnly: false, tab: 'pre-token', sort: 'implied', dir: -1, selected: null, sandbox: null, compare: [], compareView: false, focused: -1 };

  var usd = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 });
  function fmtUsd(n) {
    if (n === null || n === undefined || !isFinite(n)) return 'n/a';
    if (Math.abs(n) >= 1e9) return '$' + (n / 1e9).toFixed(2) + 'B';
    if (Math.abs(n) >= 1e6) return '$' + (n / 1e6).toFixed(1) + 'M';
    if (Math.abs(n) >= 1e3) return '$' + Math.round(n / 1e3) + 'K';
    return usd.format(n);
  }
  function fmtPct(n) {
    if (n === null || n === undefined || !isFinite(n)) return 'n/a';
    return (n > 0 ? '+' : '') + n.toFixed(2) + '%';
  }
  function fmtAge(days) {
    if (days === null || days === undefined) return 'unknown';
    if (days >= 365) return (days / 365).toFixed(1) + 'y';
    return Math.max(0, Math.round(days)) + 'd';
  }
  // The model in one function: the page recomputes a row and checks the number board.json carries.
  function impliedOf(row, model) {
    var growth = Math.min(model.growth_cap, Math.max(model.growth_floor, row.change_7d === null || row.change_7d === undefined ? 0 : row.change_7d));
    var growthMult = 1 + (growth / 100) * model.growth_weight;
    var age = row.age_days === null || row.age_days === undefined ? model.unknown_age_days : row.age_days;
    var maturity = model.maturity_floor + (Math.min(Math.max(age, 0), model.maturity_days) / model.maturity_days) * model.maturity_range;
    var chains = row.chains && row.chains.length ? row.chains.length : 1;
    var chainsMult = 1 + Math.min(Math.max(chains - 1, 0), model.chains_cap) * model.chains_weight;
    var curve = Math.exp(model.curve_intercept + model.curve_slope * Math.log(Math.max(1, row.tvl_usd)));
    return Math.max(1, Math.round(curve * growthMult * maturity * chainsMult * model.calibration));
  }
  function effectiveModel() {
    if (!state.sandbox) return DATA.model;
    return {
      curve_intercept: DATA.model.curve_intercept,
      curve_slope: state.sandbox.curve_slope,
      calibration: state.sandbox.calibration,
      growth_weight: state.sandbox.growth_weight,
      chains_weight: DATA.model.chains_weight,
      growth_floor: DATA.model.growth_floor,
      growth_cap: DATA.model.growth_cap,
      maturity_floor: DATA.model.maturity_floor,
      maturity_range: DATA.model.maturity_range,
      maturity_days: DATA.model.maturity_days,
      unknown_age_days: DATA.model.unknown_age_days,
      chains_cap: DATA.model.chains_cap
    };
  }
  function effectiveImplied(row) { return state.sandbox ? impliedOf(row, effectiveModel()) : row.implied_value_usd; }

  function el(tag, attrs) {
    var node = document.createElement(tag);
    if (attrs) {
      Object.keys(attrs).forEach(function (k) {
        if (k === 'class') node.className = attrs[k];
        else if (k === 'text') node.textContent = attrs[k];
        else if (k === 'html') node.innerHTML = attrs[k];
        else if (k.slice(0, 2) === 'on') node.addEventListener(k.slice(2), attrs[k]);
        else if (attrs[k] !== null && attrs[k] !== undefined) node.setAttribute(k, attrs[k]);
      });
    }
    for (var i = 2; i < arguments.length; i++) {
      var child = arguments[i];
      if (child === null || child === undefined) continue;
      if (Array.isArray(child)) child.forEach(function (c) { if (c) node.appendChild(c); });
      else if (typeof child === 'string') node.appendChild(document.createTextNode(child));
      else node.appendChild(child);
    }
    return node;
  }

  function chainOf(p) { return p.chains && p.chains.length > 0 ? p.chains[0] : 'its main chain'; }
  function capitalFor(p) {
    if (p.tvl_usd >= 5e9) return 250;
    if (p.tvl_usd >= 1e9) return 150;
    if (p.tvl_usd >= 1e8) return 100;
    return 50;
  }
  function holdDaysFor(age) {
    if (age === null || age === undefined) return 30;
    if (age < 180) return 60;
    if (age < 365) return 45;
    return 30;
  }
  function actionFor(p, capital, chain) {
    var c = (p.category || '').toLowerCase();
    var name = p.name;
    if (c.indexOf('lend') >= 0 || c.indexOf('cdp') >= 0 || c.indexOf('collateral') >= 0) return 'Supply $' + capital + ' of USDC to ' + name + ' on ' + chain + ' and keep the position open.';
    if (c.indexOf('dex') >= 0 || c.indexOf('yield') >= 0 || c.indexOf('leveraged farm') >= 0) return 'Provide $' + capital + ' of liquidity to ' + name + "'s main pool on " + chain + ' and keep the position open.';
    if (c.indexOf('bridge') >= 0) return 'Bridge $' + capital + ' of USDC to ' + chain + ' through ' + name + ' and use the bridged funds in its app.';
    if (c.indexOf('staking') >= 0 || c.indexOf('restak') >= 0) return "Stake $" + capital + " of the chain's staking asset through " + name + ' and keep the receipt.';
    if (c.indexOf('perpetual') >= 0 || c.indexOf('derivative') >= 0) return 'Deposit $' + capital + ' of USDC as margin on ' + name + ' and open one small hedge.';
    if (c.indexOf('prediction') >= 0) return 'Fund $' + capital + ' and place one market position on ' + name + '.';
    if (c.indexOf('curator') >= 0 || c.indexOf('allocator') >= 0) return 'Deposit $' + capital + ' into a ' + name + ' vault on ' + chain + ' and keep the shares.';
    if (c.indexOf('stable') >= 0) return 'Mint or deposit $' + capital + ' of the stable asset through ' + name + ' on ' + chain + '.';
    if (c.indexOf('rwa') >= 0) return "Mint $" + capital + " of the protocol's yield asset on " + chain + ' and hold it.';
    if (c.indexOf('insurance') >= 0) return 'Buy $' + capital + ' of cover from ' + name + ' on ' + chain + ' and keep the policy.';
    return 'Deposit $' + capital + ' of USDC into ' + name + ' on ' + chain + ' and keep the position open.';
  }
  function stepText(step) {
    var s = step.text + ' Cost: ' + step.cost + '. Time: ' + step.time + '.';
    if (s.length > 600) s = s.slice(0, 596) + '...';
    if (s.length < 20) s = s + " Hold the position and check the protocol's own page.";
    return s;
  }
  function weeklyFor(p, capital, chain) {
    var c = (p.category || '').toLowerCase();
    var name = p.name;
    if (c.indexOf('lend') >= 0 || c.indexOf('cdp') >= 0 || c.indexOf('collateral') >= 0) return 'Borrow $10 against the supply on ' + name + ' and repay it the same week, so the wallet shows both sides.';
    if (c.indexOf('dex') >= 0 || c.indexOf('yield') >= 0 || c.indexOf('leveraged farm') >= 0) return 'Swap $10 through ' + name + "'s main pool on " + chain + ' once a week, in and out of the pool token.';
    if (c.indexOf('bridge') >= 0) return 'Bridge $10 to ' + chain + ' and back through ' + name + ' once a week, keeping the route in use.';
    if (c.indexOf('staking') >= 0 || c.indexOf('restak') >= 0) return 'Top up the stake by $10 through ' + name + ' once a week and keep the receipt.';
    if (c.indexOf('perpetual') >= 0 || c.indexOf('derivative') >= 0) return 'Open and close one $10 hedge on ' + name + ' each week, keeping the margin position alive.';
    if (c.indexOf('prediction') >= 0) return 'Place one $10 market position on ' + name + ' each week and settle it.';
    if (c.indexOf('curator') >= 0 || c.indexOf('allocator') >= 0) return 'Add $10 to the ' + name + ' vault on ' + chain + ' once a week and keep the shares.';
    if (c.indexOf('stable') >= 0) return 'Mint or redeem $10 of the stable asset through ' + name + ' on ' + chain + ' once a week.';
    if (c.indexOf('rwa') >= 0) return 'Buy $10 more of the yield asset on ' + chain + ' through ' + name + ' once a week and hold it.';
    if (c.indexOf('insurance') >= 0) return 'Renew or top up $10 of cover from ' + name + ' on ' + chain + ' once a week while the policy runs.';
    return 'Do one $10 action on ' + name + ' each week, such as a deposit, a swap or a vote, and keep the wallet active.';
  }
  function farmSteps(p) {
    var chain = chainOf(p);
    var capital = capitalFor(p);
    var hold = holdDaysFor(p.age_days);
    var steps = [
      { text: 'Use a fresh wallet that holds only the funds you plan to farm, and keep its seed phrase offline.', cost: 'under $3 of gas for the first transaction', time: '5 minutes' },
      { text: actionFor(p, capital, chain), cost: '$' + capital + ' of capital and about $' + (capital >= 150 ? 8 : 4) + ' of gas', time: '15 minutes to set up' },
      { text: weeklyFor(p, capital, chain), cost: 'about $2 of gas a week', time: '10 minutes a week' }
    ];
    if (p.chains && p.chains.length >= 2) {
      steps.push({ text: 'Repeat the position on ' + p.chains[1] + ' too, so the wallet is active on both ' + chain + ' and ' + p.chains[1] + '.', cost: '$' + Math.max(25, Math.round(capital / 4)) + ' of capital and about $4 of gas', time: '15 minutes to set up' });
    }
    steps.push(
      { text: 'Hold the position for at least ' + hold + ' days so the activity is counted in more than one snapshot.', cost: 'the $' + capital + ' stays in the position', time: hold + ' days' },
      { text: "Before you withdraw, open the protocol's own points or rewards page and claim only from the link it publishes.", cost: 'no fee to check, and never pay to claim', time: '10 minutes' },
      { text: 'Write the wallet, the dates and every transaction in a farm log so you can repeat the position or unwind it.', cost: 'nothing but the log', time: '5 minutes' }
    );
    return steps.map(stepText);
  }

  function readHash() {
    var hash = window.location.hash.replace(/^#/, '');
    if (!hash) return;
    var params = new URLSearchParams(hash);
    if (params.get('q')) state.q = params.get('q');
    if (params.get('p')) state.selected = params.get('p');
    if (params.get('category')) state.category = params.get('category');
    if (params.get('chain')) state.chain = params.get('chain');
    if (params.get('watchlist') === '1') state.watchlistOnly = true;
    if (params.get('cmp')) {
      var wanted = params.get('cmp').split(',').filter(function (s) { return s.length > 0; }).slice(0, 3);
      var known = DATA.rows.filter(function (r) { return wanted.indexOf(r.slug) >= 0; }).map(function (r) { return r.slug; });
      if (known.length > 0) { state.compare = known; state.compareView = true; }
    }
  }
  function writeHash() {
    var params = new URLSearchParams();
    if (state.q) params.set('q', state.q);
    if (state.category !== 'all') params.set('category', state.category);
    if (state.chain !== 'all') params.set('chain', state.chain);
    if (state.watchlistOnly) params.set('watchlist', '1');
    if (state.compare.length > 0) params.set('cmp', state.compare.join(','));
    if (state.selected) params.set('p', state.selected);
    var next = params.toString();
    if (next) window.history.replaceState(null, '', '#' + next);
    else window.history.replaceState(null, '', window.location.pathname + window.location.search);
  }

  function rows() {
    var q = state.q.trim().toLowerCase();
    return DATA.rows.filter(function (r) {
      if (state.category !== 'all' && r.category !== state.category) return false;
      if (state.chain !== 'all' && (!r.chains || r.chains.indexOf(state.chain) < 0)) return false;
      if (state.watchlistOnly && !r.watchlist) return false;
      if (!q) return true;
      var hay = [r.name, r.slug, r.category, (r.chains || []).join(' ')].join(' ').toLowerCase();
      return hay.indexOf(q) >= 0;
    });
  }
  function sortedRows(list) {
    var key = state.sort;
    return list.slice().sort(function (a, b) {
      var av, bv;
      if (key === 'name') { av = a.name.toLowerCase(); bv = b.name.toLowerCase(); }
      else if (key === 'tvl') { av = a.tvl_usd; bv = b.tvl_usd; }
      else if (key === 'growth') { av = a.change_7d === null ? -Infinity : a.change_7d; bv = b.change_7d === null ? -Infinity : b.change_7d; }
      else if (key === 'age') { av = a.age_days === null ? Infinity : a.age_days; bv = b.age_days === null ? Infinity : b.age_days; }
      else if (key === 'verdict') { var order = { farm: 0, marginal: 1, skip: 2 }; av = order[a.verdict]; bv = order[b.verdict]; }
      else { av = effectiveImplied(a); bv = effectiveImplied(b); }
      if (av < bv) return -state.dir;
      if (av > bv) return state.dir;
      return a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0;
    });
  }

  function rowBySlug(slug) {
    var found = DATA.rows.filter(function (r) { return r.slug === slug; });
    return found.length > 0 ? found[0] : null;
  }
  function comparePicked() {
    return state.compare.map(rowBySlug).filter(function (r) { return r !== null; });
  }
  function toggleCompare(slug) {
    var at = state.compare.indexOf(slug);
    if (at >= 0) { state.compare.splice(at, 1); if (state.compare.length === 0) state.compareView = false; }
    else if (state.compare.length < 3) { state.compare.push(slug); }
    writeHash(); render();
  }
  function clearCompare() {
    state.compare = [];
    state.compareView = false;
    writeHash(); render();
  }
  function compareCell(row, kind) {
    if (kind === 'implied') return fmtUsd(effectiveImplied(row));
    if (kind === 'tvl') return fmtUsd(row.tvl_usd);
    if (kind === 'growth') return fmtPct(row.change_7d);
    if (kind === 'age') return fmtAge(row.age_days);
    if (kind === 'chains') return (row.chains || []).join(', ') || 'an unnamed chain';
    if (kind === 'category') return row.category || 'Other';
    if (kind === 'watchlist') return row.watchlist ? 'On the watchlist' : 'Early radar';
    if (kind === 'verdict') return row.verdict;
    if (kind === 'launchOdds') return Math.round(row.launch_odds * 100) + '%';
    if (kind === 'farmNet') return (row.farm_net_usd >= 0 ? '+' : '') + '$' + row.farm_net_usd.toFixed(2);
    if (kind === 'growthMult') return String(row.growth_multiplier);
    if (kind === 'maturityMult') return String(row.maturity_multiplier);
    if (kind === 'chainsMult') return String(row.chains_multiplier);
    if (kind === 'steps') return String(farmSteps(row).length) + ' steps';
    return '';
  }
  var COMPARE_LINES = [
    ['implied', 'Implied value'],
    ['tvl', 'TVL'],
    ['growth', 'Seven-day growth'],
    ['age', 'Age with no token'],
    ['chains', 'Chains'],
    ['category', 'Category'],
    ['watchlist', 'Radar row'],
    ['verdict', 'Verdict'],
    ['launchOdds', 'Launch odds'],
    ['farmNet', 'Farm net of gas'],
    ['growthMult', 'Growth multiplier'],
    ['maturityMult', 'Maturity multiplier'],
    ['chainsMult', 'Chains multiplier'],
    ['steps', 'Farm plan']
  ];
  function bestSlugFor(kind, picked) {
    if (kind !== 'implied' && kind !== 'tvl' && kind !== 'growth') return null;
    var best = null;
    var bestVal = -Infinity;
    picked.forEach(function (row) {
      var v = kind === 'implied' ? effectiveImplied(row) : kind === 'tvl' ? row.tvl_usd : (row.change_7d === null ? -Infinity : row.change_7d);
      if (v > bestVal) { bestVal = v; best = row.slug; }
    });
    return best;
  }

  function csvEscape(value) {
    var s = String(value === null || value === undefined ? '' : value);
    var needsQuotes = s.indexOf(',') >= 0 || s.indexOf('"') >= 0 || s.indexOf('\n') >= 0;
    return needsQuotes ? '"' + s.replace(/"/g, '""') + '"' : s;
  }
  function boardCsv(list) {
    var head = ['rank', 'name', 'slug', 'category', 'chains', 'tvl_usd', 'change_7d_pct', 'age_days', 'implied_value_usd', 'watchlist', 'verdict', 'launch_odds'];
    var out = [head.join(',')];
    list.forEach(function (row) {
      out.push([
        row.rank, row.name, row.slug, row.category || '', (row.chains || []).join(' '), row.tvl_usd,
        row.change_7d === null ? '' : row.change_7d, row.age_days === null ? '' : row.age_days,
        effectiveImplied(row), row.watchlist ? 'yes' : 'no', row.verdict, row.launch_odds
      ].map(csvEscape).join(','));
    });
    return out.join('\n') + '\n';
  }
  function downloadCsv() {
    var visible = sortedRows(rows());
    if (visible.length === 0) return;
    var blob = new Blob([boardCsv(visible)], { type: 'text/csv;charset=utf-8' });
    var url = URL.createObjectURL(blob);
    var link = document.createElement('a');
    link.href = url;
    link.download = 'token-radar-board.csv';
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    setTimeout(function () { URL.revokeObjectURL(url); }, 500);
  }
  function downloadJson() {
    var exported = sortedRows(rows());
    if (exported.length === 0) return;
    var slim = exported.map(function (r) {
      return { rank: r.rank, slug: r.slug, name: r.name, category: r.category, chains: r.chains, tvl_usd: r.tvl_usd, change_7d: r.change_7d, age_days: r.age_days, implied_value_usd: effectiveImplied(r), watchlist: r.watchlist, verdict: r.verdict, launch_odds: r.launch_odds };
    });
    var blob = new Blob([JSON.stringify({ as_of: DATA.as_of, model: DATA.model_version, rows: slim }, null, 2)], { type: 'application/json;charset=utf-8' });
    var url = URL.createObjectURL(blob);
    var link = document.createElement('a');
    link.href = url;
    link.download = 'token-radar-board.json';
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    setTimeout(function () { URL.revokeObjectURL(url); }, 500);
  }

  function fastestMovers() {
    return DATA.rows
      .filter(function (r) { return r.change_7d !== null && r.change_7d !== undefined; })
      .slice()
      .sort(function (a, b) { return b.change_7d - a.change_7d || (a.slug < b.slug ? -1 : 1); })
      .slice(0, 5);
  }
  function biggestTvls() {
    return DATA.rows.slice().sort(function (a, b) { return b.tvl_usd - a.tvl_usd || (a.slug < b.slug ? -1 : 1); }).slice(0, 5);
  }
  function visibleSummary(list) {
    var total = 0;
    var implieds = [];
    var watch = 0;
    list.forEach(function (entry) {
      total += entry.tvl_usd;
      implieds.push(effectiveImplied(entry));
      if (entry.watchlist) watch += 1;
    });
    implieds.sort(function (a, b) { return a - b; });
    var mid = implieds.length === 0 ? null : implieds.length % 2 === 1 ? implieds[(implieds.length - 1) / 2] : Math.round((implieds[implieds.length / 2 - 1] + implieds[implieds.length / 2]) / 2);
    return { rows: list.length, tvl: total, medianImplied: mid, watchlist: watch };
  }
  function chainMix(list) {
    var counts = {};
    list.forEach(function (item) {
      (item.chains || []).forEach(function (c) { counts[c] = (counts[c] || 0) + 1; });
    });
    return Object.keys(counts).map(function (c) { return { chain: c, rows: counts[c] }; }).sort(function (a, b) { return b.rows - a.rows || (a.chain < b.chain ? -1 : 1); }).slice(0, 3);
  }
  function categoryMix(list) {
    var counts = {};
    for (var i = 0; i < list.length; i++) {
      var key = list[i].category || 'Other';
      counts[key] = (counts[key] || 0) + 1;
    }
    return Object.keys(counts).map(function (c) { return { category: c, rows: counts[c] }; }).sort(function (a, b) { return b.rows - a.rows || (a.category < b.category ? -1 : 1); }).slice(0, 4);
  }
  function snapshotAgeDays() {
    var then = Date.parse(DATA.as_of + 'T00:00:00Z');
    if (!Number.isFinite(then)) return null;
    return Math.max(0, Math.floor((Date.now() - then) / 86400000));
  }

  function visibleRowSlugs() {
    return sortedRows(rows()).map(function (r) { return r.slug; });
  }
  function moveFocus(step) {
    var slugs = visibleRowSlugs();
    if (slugs.length === 0) return;
    var current = state.focused < 0 ? (step > 0 ? -1 : 0) : state.focused;
    var next = Math.max(0, Math.min(slugs.length - 1, current + step));
    state.focused = next;
    render(); // repaint, then move the keyboard focus onto the new row
    var rowEl = document.querySelector('tr[data-slug="' + slugs[next] + '"]');
    if (rowEl) rowEl.focus();
  }
  function focusFirstRow() {
    var slugs = visibleRowSlugs();
    if (slugs.length === 0) return;
    state.focused = 0;
    render(); // repaint, then move the keyboard focus onto the first row
    var rowEl = document.querySelector('tr[data-slug="' + slugs[0] + '"]');
    if (rowEl) rowEl.focus();
  }

  function header() {
    return el('header', { class: 'top' },
      el('div', { class: 'brand' }, el('span', { class: 'mark' }), el('span', { class: 'brand-name', text: 'Token Radar' })),
      el('div', { class: 'top-meta' },
        el('span', { text: 'Snapshot ' + DATA.as_of }),
        el('span', { text: 'DefiLlama protocol index' }),
        el('span', { text: DATA.model_version + ' model' })
      )
    );
  }

  function lede() {
    return el('section', { class: 'lede' },
      el('div', null,
        el('h1', { text: DATA.watchlist_size + ' watchlist protocols, ranked by implied value' }),
        el('p', { text: 'The watchlist is the floor ($' + Math.round(DATA.floor_usd / 1e6) + 'M TVL, no token on record); the early radar adds ' + DATA.early_size + ' pre-token protocols below it. Implied value is a model, not a promise.' }),
        el('p', { class: 'sub', text: snapshotAgeDays() === null ? 'Snapshot date ' + DATA.as_of + '.' : 'Snapshot from ' + DATA.as_of + ', ' + snapshotAgeDays() + ' days ago: a launch after that date is not in this board.' })
      ),
      el('div', { class: 'facts' },
        el('div', { class: 'fact' }, el('span', { text: 'Watchlist covered' }), el('b', { text: DATA.watchlist_size + ' / ' + DATA.watchlist_size })),
        el('div', { class: 'fact' }, el('span', { text: 'Pre-token rows scored' }), el('b', { text: String(DATA.board_size) })),
        el('div', { class: 'fact' }, el('span', { text: 'Early rows below the floor' }), el('b', { text: String(DATA.early_size) })),
        el('div', { class: 'fact' }, el('span', { text: 'Live-token protocols set aside' }), el('b', { text: String(DATA.live_size) }))
      )
    );
  }

  // The model, tested against the traded tokens: every comp was priced from a fit that never saw it.
  function validationStrip() {
    var v = DATA.validation;
    function kpi(label, value, note) {
      return el('div', { class: 'kpi' }, el('span', { text: label }), el('b', { text: value }), el('span', { class: 'sub', text: note }));
    }
    return el('section', { class: 'panel kpis', 'aria-label': 'How well the model prices the traded tokens' },
      el('h2', { text: 'The model, tested against the traded tokens' }),
      el('div', { class: 'kpi-row' },
        kpi('Typical miss (LOO)', 'x' + v.loo_miss.toFixed(2), 'median over ' + v.comps + ' traded comps'),
        kpi('Miss, newer half', 'x' + v.newer_half_miss.toFixed(2), 'newer ' + v.newer_half_n + ' comps by listing date'),
        kpi('In P25-P75, held out', Math.round(v.coverage_2575 * 100) + '%', v.coverage_2575_n + ' of ' + v.comps + ' comps'),
        kpi('In P10-P90, held out', Math.round(v.coverage_1090 * 100) + '%', v.coverage_1090_n + ' of ' + v.comps + ' comps'),
        kpi('Launch odds, held out', Math.round(v.launch_accuracy * 100) + '%', v.launch_correct + ' of ' + v.launch_total + ' right, 5-fold')
      ),
      el('p', { class: 'sub', text: 'A P25-P75 band should hold the real cap about half the time, P10-P90 about four times in five. The ranges are the model\u2019s own miss spread, printed on every row.' })
    );
  }

  function controls() {
    var categories = Array.from(new Set(DATA.rows.map(function (r) { return r.category || 'Other'; }))).sort();
    var chains = Array.from(new Set(DATA.rows.reduce(function (acc, r) { return acc.concat(r.chains || []); }, []))).sort();
    var search = el('input', { type: 'search', id: 'q', placeholder: 'Search name, category or chain', value: state.q, 'aria-label': 'Search the board' });
    search.addEventListener('input', function () { state.q = search.value; writeHash(); render(); });
    var select = el('select', { id: 'category', 'aria-label': 'Filter by category' },
      el('option', { value: 'all', text: 'All categories' }),
      categories.map(function (c) { return el('option', { value: c, text: c, selected: c === state.category ? 'selected' : null }); })
    );
    select.addEventListener('change', function () { state.category = select.value; writeHash(); render(); });
    var chainSelect = el('select', { id: 'chain', 'aria-label': 'Filter by chain' },
      el('option', { value: 'all', text: 'All chains' }),
      chains.map(function (c) { return el('option', { value: c, text: c, selected: c === state.chain ? 'selected' : null }); })
    );
    chainSelect.addEventListener('change', function () { state.chain = chainSelect.value; writeHash(); render(); });
    var watchToggle = el('button', { type: 'button', 'aria-pressed': state.watchlistOnly ? 'true' : 'false', text: 'Watchlist only', onclick: function () { state.watchlistOnly = !state.watchlistOnly; writeHash(); render(); } });
    var pre = el('button', { type: 'button', 'aria-pressed': state.tab === 'pre-token' ? 'true' : 'false', text: 'Pre-token', onclick: function () { state.tab = 'pre-token'; render(); } });
    var live = el('button', { type: 'button', 'aria-pressed': state.tab === 'live' ? 'true' : 'false', text: 'Live token', onclick: function () { state.tab = 'live'; render(); } });
    return el('div', { class: 'controls' },
      el('div', { class: 'field' }, el('label', { for: 'q', text: 'Search' }), search),
      el('div', { class: 'field' }, el('label', { for: 'category', text: 'Category' }), select),
      el('div', { class: 'field' }, el('label', { for: 'chain', text: 'Chain' }), chainSelect),
      el('div', { class: 'field' }, el('span', { class: 'sub', text: 'Watchlist' }), el('div', { class: 'tabs' }, watchToggle)),
      el('div', { class: 'field' }, el('span', { class: 'sub', text: 'Token status' }), el('div', { class: 'tabs' }, pre, live)),
      el('div', { class: 'field' }, el('span', { class: 'sub', text: 'Take the board with you' }), el('div', { class: 'tabs' },
        el('button', { type: 'button', text: 'CSV', onclick: downloadCsv }),
        el('button', { type: 'button', text: 'JSON', onclick: downloadJson })
      )),
      el('div', { class: 'field' }, el('span', { class: 'sub', text: 'Start over' }), el('button', { class: 'button', type: 'button', text: 'Reset filters', onclick: function () { state.q = ''; state.category = 'all'; state.chain = 'all'; state.watchlistOnly = false; state.focused = -1; writeHash(); render(); } })),
      el('span', { class: 'count', text: state.tab === 'pre-token' ? rows().length + ' rows shown' : DATA.live.length + ' live-token protocols' })
    );
  }

  function sortHeader(key, label) {
    return el('th', { scope: 'col' },
      el('button', { type: 'button', onclick: function () { if (state.sort === key) state.dir = -state.dir; else { state.sort = key; state.dir = -1; } render(); } },
        label,
        state.sort === key ? el('span', { 'aria-hidden': 'true', text: state.dir < 0 ? ' v' : ' ^' }) : null
      )
    );
  }

  function boardTable() {
    var list = sortedRows(rows());
    if (list.length === 0) {
      return el('div', { class: 'panel' }, el('div', { class: 'empty' },
        el('h2', { text: 'No protocol matches that filter' }),
        el('p', { text: 'Clear the search or pick another category to see the board again.' }),
        el('button', { class: 'button primary', type: 'button', text: 'Clear filters', onclick: function () { state.q = ''; state.category = 'all'; writeHash(); render(); } })
      ));
    }
    var max = 1;
    list.forEach(function (r) { var v = effectiveImplied(r); if (v > max) max = v; });
    var tbody = el('tbody');
    list.forEach(function (r, idx) {
      var growth = r.change_7d === null ? 'n/a' : fmtPct(r.change_7d);
      var growthClass = r.change_7d === null ? '' : r.change_7d >= 0 ? 'pos' : 'neg';
      var implied = effectiveImplied(r);
      var tr = el('tr', {
        'data-selected': state.selected === r.slug ? 'true' : 'false',
        'data-slug': r.slug,
        'data-focused': state.focused === idx ? 'true' : 'false',
        tabindex: '0',
        onclick: function () { openDetail(r.slug); },
        onkeydown: function (e) { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openDetail(r.slug); } }
      },
        el('td', { class: 'cmp-cell' },
          el('input', { type: 'checkbox', class: 'cmp-check', 'aria-label': 'Compare ' + r.name, checked: state.compare.indexOf(r.slug) >= 0 ? 'checked' : null, onclick: function (e) { e.stopPropagation(); toggleCompare(r.slug); } })
        ),
        el('td', { class: 'num', text: String(r.rank) }),
        el('td', null, el('div', { class: 'name' },
          el('b', { text: r.name }),
          r.watchlist ? el('span', { class: 'badge', text: 'watchlist' }) : null,
          el('span', { class: 'sub', text: (r.category || 'Other') + ' on ' + (r.chains && r.chains.length ? r.chains.slice(0, 2).join(', ') : 'an unnamed chain') })
        )),
        el('td', { class: 'num', text: fmtUsd(r.tvl_usd) }),
        el('td', { class: 'num ' + growthClass, text: growth }),
        el('td', { class: 'num', text: fmtAge(r.age_days) }),
        el('td', null, el('div', { class: 'implied' },
          el('div', { class: 'bar', 'aria-hidden': 'true' }, el('i', { style: 'width:' + Math.max(3, Math.round((implied / max) * 100)) + '%' })),
          el('span', { class: 'num', text: fmtUsd(implied) })
        )),
        el('td', null, el('span', { class: 'verdict-' + r.verdict, text: r.verdict })),
        el('td', null, el('span', { class: 'status', text: 'no token' }))
      );
      tbody.appendChild(tr);
    });
    return el('div', { class: 'panel' },
      el('div', { class: 'table-wrap' },
        el('table', null,
          el('caption', { class: 'sub', text: state.sandbox ? 'Sandbox model active: values and order follow your constants below, not the submitted radar-3 numbers. Select a row for its model and farm plan.' : 'Pre-token protocols, strongest implied value first. Select a row for its model and farm plan.' }),
          el('thead', null, el('tr', null,
            el('th', { scope: 'col', text: 'Compare' }),
            sortHeader('implied', 'Rank'),
            sortHeader('name', 'Protocol'),
            sortHeader('tvl', 'TVL'),
            sortHeader('growth', '7d'),
            sortHeader('age', 'Age'),
            sortHeader('implied', 'Implied value'),
            sortHeader('verdict', 'Verdict'),
            el('th', { scope: 'col', text: 'Token' })
          )),
          tbody
        )
      )
    );
  }

  function liveTable() {
    var tbody = el('tbody');
    DATA.live.forEach(function (r) {
      tbody.appendChild(el('tr', null,
        el('td', { class: 'num', text: 'live' }),
        el('td', null, el('div', { class: 'name' }, el('b', { text: r.name }), el('span', { class: 'sub', text: (r.category || 'Other') + ' on ' + (r.chains && r.chains.length ? r.chains.slice(0, 2).join(', ') : 'an unnamed chain') }))),
        el('td', { class: 'num', text: fmtUsd(r.tvl_usd) }),
        el('td', { class: 'num ' + (r.change_7d !== null && r.change_7d >= 0 ? 'pos' : 'neg'), text: fmtPct(r.change_7d) }),
        el('td', { class: 'num', text: fmtUsd(r.mcap_usd) }),
        el('td', null, el('span', { class: 'status', text: 'already trades' }))
      ));
    });
    return el('div', { class: 'panel' },
      el('div', { class: 'table-wrap' },
        el('table', null,
          el('caption', { class: 'sub', text: 'Already trading: their market cap is a fact, not a model. Set aside from the pre-token ranking.' }),
          el('thead', null, el('tr', null, el('th', { scope: 'col', text: 'Status' }), el('th', { scope: 'col', text: 'Protocol' }), el('th', { scope: 'col', text: 'TVL' }), el('th', { scope: 'col', text: '7d' }), el('th', { scope: 'col', text: 'Market cap' }), el('th', { scope: 'col', text: 'Token' }))),
          tbody
        )
      )
    );
  }

  function modelPanel() {
    var m = DATA.model;
    var sb = state.sandbox || m;
    function slider(id, label, min, max, step, value, fmt) {
      var input = el('input', { type: 'range', id: id, min: String(min), max: String(max), step: String(step), value: String(value), 'aria-label': label });
      var out = el('output', { for: id, text: fmt(value) });
      input.addEventListener('input', function () { out.textContent = fmt(parseFloat(input.value)); });
      return el('div', { class: 'sandbox-field' }, el('label', { for: id, text: label }), input, out);
    }
    var calInput = slider('sb-cal', 'Calibration (percentile of comps)', 0.3, 1, 0.02, sb.calibration, function (v) { return v.toFixed(2); });
    var slopeInput = slider('sb-slope', 'Comps-curve slope (log-log)', 0.3, 0.5, 0.01, sb.curve_slope, function (v) { return v.toFixed(2); });
    var growthInput = slider('sb-growth', 'Growth weight', 0, 1, 0.05, sb.growth_weight, function (v) { return v.toFixed(2); });
    var apply = el('button', { class: 'button primary', type: 'button', text: state.sandbox ? 'Apply sandbox' : 'Try these constants', onclick: function () {
      state.sandbox = {
        calibration: parseFloat(calInput.querySelector('input').value),
        curve_slope: parseFloat(slopeInput.querySelector('input').value),
        growth_weight: parseFloat(growthInput.querySelector('input').value)
      };
      render();
    } });
    var reset = el('button', { class: 'button', type: 'button', text: 'Back to radar-3', onclick: function () { state.sandbox = null; render(); } });
    return el('section', { class: 'panel model' },
      el('h2', { text: 'How implied value is computed' }),
      el('p', { class: 'sub', text: 'Every row is scored by one function of the snapshot figures. No protocol name is special-cased, and no row is hand-picked.' }),
      el('div', { class: 'formula' },
        'implied = round( exp(' + m.curve_intercept + ' + ' + m.curve_slope + ' x ln(tvl_usd)) x (1 + clamp(change_7d, ' + m.growth_floor + ', ' + m.growth_cap + ') / 100 x ' + m.growth_weight + ') x (' + m.maturity_floor + ' + min(age_days, ' + m.maturity_days + ') / ' + m.maturity_days + ' x ' + m.maturity_range + ') x (1 + min(chains - 1, ' + m.chains_cap + ') x ' + m.chains_weight + ') x ' + m.calibration + ' )'
      ),
      el('p', { class: 'sub', text: 'The curve is fitted to the ' + DATA.validation.comps + ' traded tokens that are clean comparables, least squares on log(market cap / multipliers) against log(TVL). A market cap grows slower than the TVL behind it, so the curve is concave and the largest protocols are compressed. The ' + m.calibration + ' calibration prices at the 40th percentile of those comps, below the median on purpose. Age is the time since first listing; an unlisted age uses ' + m.unknown_age_days + ' days. Chain count is reach.' }),
      methodNote(),
      el('div', { class: 'sandbox' },
        el('h3', { text: state.sandbox ? 'Sandbox: your constants are live in the table' : 'Sandbox: change the model, re-rank the board' }),
        el('p', { class: 'sub', text: 'Move a constant and apply it: the table re-sorts. The submitted board.json keeps the radar-3 numbers; this only re-ranks the page.' }),
        calInput, slopeInput, growthInput,
        el('div', { class: 'sandbox-actions' }, apply, state.sandbox ? reset : null)
      )
    );
  }

  function setAsidePanel() {
    var s = DATA.set_aside;
    return el('section', { class: 'panel set-aside' },
      el('h2', { text: 'All ' + s.total + ' protocols, accounted for' }),
      el('p', { class: 'sub', text: s.ranked + ' ranked on the board. The rest are set aside, by reason:' }),
      el('ul', { class: 'reasons' }, s.reasons.map(function (r) {
        return el('li', null, el('b', { class: 'num', text: String(r.count) }), el('span', { text: ' ' + r.reason + ' (e.g. ' + r.examples.join(', ') + ')' }));
      }))
    );
  }

  var dialog = el('dialog', { class: 'detail', id: 'detail', 'aria-labelledby': 'detail-title' });
  dialog.addEventListener('close', function () { state.selected = null; writeHash(); });

  function openDetail(slug) {
    var row = DATA.rows.filter(function (r) { return r.slug === slug; })[0];
    if (!row) return;
    state.selected = slug;
    writeHash();
    dialog.textContent = '';
    var steps = farmSteps(row);
    dialog.appendChild(el('div', { class: 'detail-head' },
      el('div', null,
        el('span', { class: 'brand-name', text: 'Rank ' + row.rank + ' of ' + DATA.board_size }),
        el('h2', { id: 'detail-title', text: row.name }),
        el('p', { class: 'sub', text: (row.category || 'Other') + ' on ' + (row.chains && row.chains.length ? row.chains.join(', ') : 'an unnamed chain') + (row.watchlist ? ' · On the watchlist' : ' · Early radar') })
      ),
      el('button', { class: 'close', type: 'button', 'aria-label': 'Close details', text: 'Close', onclick: function () { dialog.close(); } })
    ));
    var rowLink = window.location.href.split('#')[0] + '#p=' + row.slug;
    dialog.appendChild(el('div', { class: 'detail-actions' },
      el('button', { class: 'button', type: 'button', text: 'Copy link to this protocol', onclick: function () { if (navigator.clipboard) navigator.clipboard.writeText(rowLink); } }),
      el('span', { class: 'sub', text: 'The link reopens this detail from the board.' })
    ));
    dialog.appendChild(el('section', { class: 'detail-section' },
      el('h3', { text: 'Implied value' }),
      el('div', { class: 'equation' },
        el('div', null, el('span', { text: 'TVL' }), el('b', { class: 'num', text: fmtUsd(row.tvl_usd) })),
        el('div', null, el('span', { text: 'Seven-day growth' }), el('b', { class: 'num', text: fmtPct(row.change_7d) })),
        el('div', null, el('span', { text: 'Age with no token' }), el('b', { class: 'num', text: fmtAge(row.age_days) })),
        el('div', null, el('span', { text: 'Growth multiplier' }), el('b', { class: 'num', text: String(row.growth_multiplier) })),
        el('div', null, el('span', { text: 'Maturity multiplier' }), el('b', { class: 'num', text: String(row.maturity_multiplier) })),
        el('div', null, el('span', { text: 'Chains multiplier (' + (row.chains ? row.chains.length : 1) + ' chains)' }), el('b', { class: 'num', text: String(row.chains_multiplier) })),
        el('div', null, el('span', { text: 'Implied value' }), el('b', { class: 'num', text: fmtUsd(row.implied_value_usd) }))
      ),
      el('p', { class: 'sub', text: 'Model ' + DATA.model_version + ': the same function scores every protocol. The page recomputes this row as ' + fmtUsd(impliedOf(row, DATA.model)) + (impliedOf(row, DATA.model) === row.implied_value_usd ? ', the same number board.json carries.' : ', which differs from the board: the data would be stale.') + ' This is an estimate, not a price.' })
    ));
    dialog.appendChild(el('section', { class: 'detail-section' },
      el('h3', { text: 'Farm verdict: ' + row.verdict }),
      el('div', { class: 'equation' },
        el('div', null, el('span', { text: 'Launch odds' }), el('b', { class: 'num', text: Math.round(row.launch_odds * 100) + '%' })),
        el('div', null, el('span', { text: 'Expected airdrop value' }), el('b', { class: 'num', text: '$' + row.farm_value_usd.toFixed(2) })),
        el('div', null, el('span', { text: 'Farm cost (gas, a month)' }), el('b', { class: 'num', text: '$' + DATA.model.farm_cost_usd })),
        el('div', null, el('span', { text: 'Net of gas' }), el('b', { class: 'num', text: (row.farm_net_usd >= 0 ? '+' : '') + '$' + row.farm_net_usd.toFixed(2) })),
        el('div', null, el('span', { text: 'Plausible range (P25-P75)' }), el('b', { class: 'num', text: fmtUsd(row.range_lo_usd) + ' - ' + fmtUsd(row.range_hi_usd) }))
      ),
      el('p', { class: 'sub', text: 'Farm value is the implied value times a 7% drop share, times the launch odds, split among the farmers the TVL implies. Farm clears $50 net, marginal clears $0. The hour of time is not priced. The range is the model\u2019s own miss spread.' })
    ));
    dialog.appendChild(el('section', { class: 'detail-section' },
      el('h3', { text: 'Farm plan' }),
      el('ol', { class: 'steps' }, steps.map(function (s) {
        var at = s.indexOf(' Cost: ');
        var action = at >= 0 ? s.slice(0, at) : s;
        var tail = at >= 0 ? s.slice(at + 1) : '';
        return el('li', null, el('b', { text: action }), el('span', { class: 'cost', text: tail }));
      }))
    ));
    if (typeof dialog.showModal === 'function') {
      if (!dialog.open) dialog.showModal();
    } else {
      dialog.setAttribute('open', '');
    }
  }

  function moversStrip() {
    var movers = fastestMovers();
    var big = biggestTvls();
    function chipList(title, list, fmt) {
      return el('div', { class: 'movers-group' },
        el('span', { class: 'movers-title', text: title }),
        el('div', { class: 'movers-chips' }, list.map(function (r) {
          return el('button', { type: 'button', class: 'mover', onclick: function () { openDetail(r.slug); } },
            el('b', { text: r.name }), el('span', { class: 'num', text: fmt(r) }));
        }))
      );
    }
    return el('section', { class: 'movers', 'aria-label': 'Fastest movers and largest protocols' },
      chipList('Fastest growing this week', movers, function (r) { return fmtPct(r.change_7d); }),
      chipList('Largest by TVL', big, function (r) { return fmtUsd(r.tvl_usd); })
    );
  }

  function summaryFooter() {
    var shown = sortedRows(rows());
    var sum = visibleSummary(shown);
    var mix = chainMix(shown);
    var mixText = mix.length === 0 ? 'no chain mix to show' : mix.map(function (m) { return m.chain + ' ' + m.rows; }).join(' · ');
    var cats = categoryMix(shown);
    var catText = cats.length === 0 ? 'no category mix to show' : cats.map(function (m) { return m.category + ' ' + m.rows; }).join(' · ');
    return el('p', { class: 'summary' },
      sum.rows + ' rows shown · combined TVL ' + fmtUsd(sum.tvl) + ' · median implied value ' + (sum.medianImplied === null ? 'n/a' : fmtUsd(sum.medianImplied)) + ' · ' + sum.watchlist + ' on the watchlist · most rows on ' + mixText + ' · biggest categories: ' + catText + '.'
    );
  }
  function sortNote() {
    var label = state.sort === 'name' ? 'name' : state.sort === 'tvl' ? 'TVL' : state.sort === 'growth' ? 'seven-day growth' : state.sort === 'age' ? 'age' : state.sort === 'verdict' ? 'verdict' : 'implied value';
    var dir = state.dir < 0 ? 'highest first' : 'lowest first';
    return el('p', { class: 'sort-note', text: 'Sorted by ' + label + ', ' + dir + '. Click a column heading to change the sort.' });
  }

  function compareTray() {
    var picked = comparePicked();
    if (picked.length === 0) return null;
    return el('div', { class: 'tray', role: 'region', 'aria-label': 'Protocols picked for comparison' },
      el('span', { class: 'tray-label', text: picked.length + (picked.length === 1 ? ' protocol picked' : ' protocols picked') + ' (up to 3):' }),
      picked.map(function (r) {
        return el('span', { class: 'tray-pick' }, el('b', { text: r.name }),
          el('button', { type: 'button', 'aria-label': 'Remove ' + r.name + ' from comparison', text: '×', onclick: function () { toggleCompare(r.slug); } }));
      }),
      el('button', { class: 'button primary', type: 'button', text: 'Compare side by side', onclick: function () { state.compareView = true; writeHash(); render(); } }),
      el('button', { class: 'button', type: 'button', text: 'Clear', onclick: clearCompare })
    );
  }

  function verdictLine(picked) {
    var best = bestSlugFor('implied', picked);
    if (!best) return null;
    var leader = rowBySlug(best);
    var runner = null;
    var runnerVal = -Infinity;
    picked.forEach(function (r) {
      if (r.slug === best) return;
      var v = effectiveImplied(r);
      if (v > runnerVal) { runnerVal = v; runner = r; }
    });
    if (!runner || !leader) return null;
    var gap = effectiveImplied(leader) - runnerVal;
    var pct = runnerVal > 0 ? Math.round((gap / runnerVal) * 100) : 0;
    return el('p', { class: 'verdict', text: leader.name + ' leads on implied value by ' + fmtUsd(gap) + ' (' + pct + '% over ' + runner.name + '). The gap is a model gap, not a market one: it moves with TVL, growth and age.' });
  }

  function compareView() {
    var picked = comparePicked();
    if (picked.length < 2) {
      return el('section', { class: 'panel' }, el('div', { class: 'empty' },
        el('h2', { text: 'Pick at least two protocols to compare' }),
        el('p', { text: 'Use the compare box on a board row, or the c key on a highlighted row, to pick up to three.' }),
        el('button', { class: 'button primary', type: 'button', text: 'Back to the board', onclick: function () { state.compareView = false; writeHash(); render(); } })
      ));
    }
    var head = el('tr', null, el('th', { scope: 'col', text: 'Figure' }), picked.map(function (r) { return el('th', { scope: 'col', text: r.name }); }));
    var body = el('tbody');
    COMPARE_LINES.forEach(function (line) {
      var kind = line[0];
      var label = line[1];
      var best = bestSlugFor(kind, picked);
      var cells = picked.map(function (r) {
        return el('td', { class: 'num' + (best === r.slug ? ' best' : ''), text: compareCell(r, kind) });
      });
      body.appendChild(el('tr', null, el('th', { scope: 'row', text: label }), cells));
    });
    var costRow = el('tr', null, el('th', { scope: 'row', text: 'Farm capital' }), picked.map(function (r) {
      var cap = capitalFor(r);
      return el('td', { class: 'num', text: '$' + cap + ' plus about $2 a week' });
    }));
    body.appendChild(costRow);
    var stepHead = el('tr', null, el('th', { scope: 'col', text: 'Farm plan' }), picked.map(function (r) { return el('th', { scope: 'col', text: r.name }); }));
    var stepBody = el('tbody');
    var maxSteps = 0;
    picked.forEach(function (r) { var n = farmSteps(r).length; if (n > maxSteps) maxSteps = n; });
    for (var i = 0; i < maxSteps; i++) {
      var rowCells = picked.map(function (r) {
        var steps = farmSteps(r);
        return el('td', null, el('span', { class: 'sub', text: steps[i] ? steps[i] : '—' }));
      });
      stepBody.appendChild(el('tr', null, el('th', { scope: 'row', text: 'Step ' + (i + 1) }), rowCells));
    }
    var link = window.location.href.split('#')[0] + '#cmp=' + state.compare.join(',');
    return el('section', { class: 'panel compare-panel' },
      el('div', { class: 'compare-head' },
        el('h2', { text: 'Side by side: ' + picked.map(function (r) { return r.name; }).join(' vs ') }),
        el('div', { class: 'compare-actions' },
          el('button', { class: 'button', type: 'button', text: 'Copy link to this comparison', onclick: function () { if (navigator.clipboard) navigator.clipboard.writeText(link); } }),
          el('button', { class: 'button primary', type: 'button', text: 'Back to the board', onclick: function () { state.compareView = false; writeHash(); render(); } })
        )
      ),
      verdictLine(picked),
      el('div', { class: 'table-wrap compare-wrap' },
        el('table', { class: 'compare-table' }, el('thead', null, head), body)
      ),
      el('div', { class: 'table-wrap compare-wrap' },
        el('table', { class: 'compare-table' }, el('thead', null, stepHead), stepBody)
      )
    );
  }

  function methodNote() {
    var open = el('div', { class: 'method-note', hidden: 'hidden' },
      el('p', { text: 'Implied value is a ranking device, not a price target. It asks: if this protocol launched a token today, how large would the market plausibly value it, given its TVL, growth, age with no token, and chain count?' }),
      el('p', { text: 'Farm plans follow the protocol record, never a hand-written list: the category picks the action, the TVL picks the capital, the age picks the hold, a second chain adds a step. The verdict is the plan\u2019s economics: implied value times a 7% drop share, times the launch odds, split among the farmers the TVL implies, against $16 of gas a month.' }),
      el('p', { text: 'A worked example: $100M of TVL reads $15.4M off the comps curve; 20% growth lifts it 10% to $17.0M; three years with no token sets maturity at 1.00; three chains add 0.06 to $18.0M; the 0.68 calibration prices it at $12.2M. Nothing here is advice, and a protocol can be valuable and never launch.' })
    );
    var toggle = el('button', { class: 'button', type: 'button', 'aria-expanded': 'false', text: 'How to read this radar', onclick: function () {
      var shown = open.hasAttribute('hidden');
      if (shown) { open.removeAttribute('hidden'); toggle.setAttribute('aria-expanded', 'true'); toggle.textContent = 'Hide the method note'; }
      else { open.setAttribute('hidden', 'hidden'); toggle.setAttribute('aria-expanded', 'false'); toggle.textContent = 'How to read this radar'; }
    } });
    return el('div', { class: 'method' }, toggle, open);
  }

  function render() {
    app.textContent = '';
    var shell = el('div', { class: 'shell' });
    shell.appendChild(header());
    shell.appendChild(lede());
    if (state.tab === 'pre-token') shell.appendChild(validationStrip());
    if (state.tab === 'pre-token') shell.appendChild(moversStrip());
    shell.appendChild(controls());
    if (state.tab === 'pre-token' && state.compareView && state.compare.length >= 1) shell.appendChild(compareView());
    else shell.appendChild(state.tab === 'pre-token' ? boardTable() : liveTable());
    if (state.tab === 'pre-token') {
      shell.appendChild(summaryFooter());
      shell.appendChild(sortNote());
      shell.appendChild(el('div', { class: 'visually-hidden', 'aria-live': 'polite', text: rows().length + ' rows shown, sorted by ' + state.sort }));
      var tray = compareTray();
      if (tray) shell.appendChild(tray);
      shell.appendChild(modelPanel());
      shell.appendChild(setAsidePanel());
    }
    app.appendChild(shell);
    app.setAttribute('aria-busy', 'false');
    if (!dialog.isConnected) app.appendChild(dialog);
    if (state.selected) openDetail(state.selected);
  }

  readHash();
  render();
  window.addEventListener('keydown', function (e) {
    if (e.key === 'Escape' && dialog.open) { dialog.close(); return; }
    var tag = (document.activeElement && document.activeElement.tagName) || '';
    if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA') return;
    if (dialog.open) return;
    if (e.key === 'j') { e.preventDefault(); moveFocus(1); }
    else if (e.key === 'k') { e.preventDefault(); moveFocus(-1); }
    else if (e.key === 'Enter' && state.focused >= 0 && tag !== 'TR') {
      var slugs = visibleRowSlugs();
      if (slugs[state.focused]) openDetail(slugs[state.focused]);
    }
    else if (e.key === 'c' && state.focused >= 0) {
      var picked = visibleRowSlugs();
      if (picked[state.focused]) toggleCompare(picked[state.focused]);
    }
    else if (e.key === '/') {
      var q = document.getElementById('q');
      if (q) { e.preventDefault(); q.focus(); }
    }
  });
})();
