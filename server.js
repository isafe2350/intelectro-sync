require('dotenv').config();

const express = require('express');
const axios = require('axios');
const cors = require('cors');

const app = express();

app.use(cors());
app.use(express.json());

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// ─── Retry wrapper ────────────────────────────────────────────────────────────
async function withRetry(fn, retries = 3, delay = 1000, label = '') {
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      return await fn();
    } catch (e) {
      console.warn(`[RETRY] ${label} attempt ${attempt}/${retries} failed: ${e.message}`);
      if (attempt === retries) throw e;
      await sleep(delay * attempt);
    }
  }
}

// ─── WooCommerce UPDATE helper ────────────────────────────────────────────────
async function updateWcProduct(wcId, data) {
  await withRetry(() =>
    axios.put(`${process.env.WC_URL}/wp-json/wc/v3/products/${wcId}`, data, {
      auth: { username: process.env.WC_KEY, password: process.env.WC_SECRET },
      timeout: 30000
    }),
    3, 1000, `WC update ${wcId}`
  );
}

// ─── Core logic ───────────────────────────────────────────────────────────────
async function buildProductList() {
  const apiResponse = await withRetry(() =>
    axios.post('https://intelectro.ge/api/v1/products', {}, {
      headers: {
        'api-key': '7f9e0bfcfa4d603db378ca6bb9d0dcd2',
        'Accept': 'application/json',
        'Content-Type': 'application/json',
        'User-Agent': 'Mozilla/5.0'
      },
      timeout: 90000
    }),
    3, 2000, 'Intelectro /products'
  );

  const apiProducts = apiResponse.data.products || [];
  const apiMap = new Map();
  apiProducts.forEach(p => apiMap.set(String(p.code), p));

  let wcProducts = [], page = 1;
  while (true) {
    const wcRes = await withRetry(() =>
      axios.get(`${process.env.WC_URL}/wp-json/wc/v3/products`, {
        auth: { username: process.env.WC_KEY, password: process.env.WC_SECRET },
        params: { per_page: 100, page },
        timeout: 30000
      }),
      3, 1000, `WC page ${page}`
    );
    if (wcRes.data.length === 0) break;
    wcProducts = wcProducts.concat(wcRes.data);
    page++;
    await sleep(200);
  }

  const filtered = wcProducts.filter(p =>
    p.meta_data?.some(m => m.key === 'source' && m.value === 'intelectro')
  );

  const result = [];
  for (let i = 0; i < filtered.length; i += 5) {
    const batch = filtered.slice(i, i + 5);
    const batchResults = await Promise.all(batch.map(async (p) => {
      const sku = String(p.sku || '');
      const apiSku = sku.startsWith('IEL-') ? sku.slice(4) : sku;
      const apiItem = apiMap.get(apiSku);
      if (apiItem) {
        return { wcId: p.id, name: p.name, sku, status: 'MATCHED', price: apiItem.price, instock: apiItem.instock, reserved: 0, brand: apiItem.brand };
      }
      try {
        const stockRes = await withRetry(() =>
          axios.get(`https://intelectro.ge/api/v1/productstock/${apiSku}`, {
            headers: {
              'api-key': '7f9e0bfcfa4d603db378ca6bb9d0dcd2',
              'Accept': 'application/json', 'Content-Type': 'application/json', 'User-Agent': 'Mozilla/5.0'
            },
            timeout: 30000
          }),
          3, 1000, `stock ${sku}`
        );
        const sp = stockRes.data?.products;
        if (!sp || sp.length === 0) return { wcId: p.id, name: p.name, sku, status: 'UNMATCHED', price: p.price || '0', instock: 0, reserved: 0, brand: null };
        const sd = sp.find(s => String(s.code) === apiSku) || sp[0];
        return { wcId: p.id, name: p.name, sku, status: 'UNMATCHED', price: sd.price ?? p.price ?? '0', instock: sd.instock ?? 0, reserved: sd.reserved ?? 0, brand: null };
      } catch (e) {
        return { wcId: p.id, name: p.name, sku, status: 'UNMATCHED', price: p.price || '0', instock: 0, reserved: 0, brand: null };
      }
    }));
    result.push(...batchResults);
    await sleep(300);
  }
  return result;
}

function getHint(err) {
  if (err.code === 'ECONNRESET')   return 'კავშირი გაწყდა — სერვერმა კავშირი გაწყვიტა.';
  if (err.code === 'ETIMEDOUT')    return 'მოთხოვნის დრო ამოიწურა — სცადეთ მოგვიანებით.';
  if (err.code === 'ECONNREFUSED') return 'კავშირი უარყოფილია — შეამოწმეთ WooCommerce სერვერი.';
  return null;
}

// ─── HTML Shell ───────────────────────────────────────────────────────────────
function htmlShell(bodyContent, { autoFetch } = {}) {
  return `<!DOCTYPE html>
<html lang="ka">
<head>
  <meta charset="UTF-8"/>
  <meta name="viewport" content="width=device-width, initial-scale=1.0"/>
  <title>Intelectro სინქრონიზაცია</title>
  <link href="https://fonts.googleapis.com/css2?family=Outfit:wght@300;400;500;600;700&display=swap" rel="stylesheet"/>
  <style>
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
    :root {
      --bg: #0a0c10; --surface: #111318; --surface2: #181b22; --border: #1f2330;
      --accent: #4f8ef7; --accent2: #7c3aed; --green: #22c55e; --yellow: #f59e0b;
      --red: #ef4444; --text: #e8eaf0; --muted: #6b7280; --radius: 14px;
    }
    body { background: var(--bg); color: var(--text); font-family: 'Outfit', sans-serif; min-height: 100vh; }
    body::before {
      content: ''; position: fixed; inset: 0;
      background:
        radial-gradient(ellipse 80% 50% at 10% 0%, rgba(79,142,247,0.07) 0%, transparent 60%),
        radial-gradient(ellipse 60% 40% at 90% 100%, rgba(124,58,237,0.06) 0%, transparent 60%);
      pointer-events: none; z-index: 0;
    }
    .wrapper { position: relative; z-index: 1; max-width: 1100px; margin: 0 auto; padding: 40px 24px; }

    /* ── Loading overlay ── */
    .loading-overlay {
      position: fixed; inset: 0; z-index: 999;
      background: rgba(10,12,16,0.97);
      backdrop-filter: blur(10px);
      display: flex; flex-direction: column;
      align-items: center; justify-content: center; gap: 22px;
      transition: opacity 0.5s ease;
    }
    .loading-overlay.fade-out { opacity: 0; pointer-events: none; }
    .loading-overlay.hidden { display: none; }
    .spinner-wrap { position: relative; width: 64px; height: 64px; }
    .spinner-outer { width: 64px; height: 64px; border-radius: 50%; border: 2px solid var(--border); border-top-color: var(--accent); animation: spin 0.9s linear infinite; position: absolute; inset: 0; }
    .spinner-inner { width: 44px; height: 44px; border-radius: 50%; border: 2px solid var(--border); border-bottom-color: var(--accent2); animation: spin 1.3s linear infinite reverse; position: absolute; top: 10px; left: 10px; }
    .spinner-dot   { width: 8px; height: 8px; border-radius: 50%; background: var(--accent); position: absolute; top: 28px; left: 28px; animation: pulse 1s ease-in-out infinite; }
    .loading-title { font-size: 18px; font-weight: 600; }
    .loading-sub   { font-size: 13px; color: var(--muted); }
    .loading-dots span { animation: blink 1.4s infinite; }
    .loading-dots span:nth-child(2) { animation-delay: 0.2s; }
    .loading-dots span:nth-child(3) { animation-delay: 0.4s; }
    .progress-track { width: 280px; height: 3px; background: var(--border); border-radius: 99px; overflow: hidden; }
    .progress-fill  { height: 100%; background: linear-gradient(90deg, var(--accent), var(--accent2)); border-radius: 99px; animation: indeterminate 1.8s ease-in-out infinite; }

    /* ── Header ── */
    .header { display: flex; align-items: center; justify-content: space-between; margin-bottom: 40px; flex-wrap: wrap; gap: 16px; }
    .logo { display: flex; align-items: center; gap: 14px; }
    .logo-icon { width: 46px; height: 46px; border-radius: 12px; background: linear-gradient(135deg, var(--accent), var(--accent2)); display: flex; align-items: center; justify-content: center; font-size: 22px; box-shadow: 0 0 24px rgba(79,142,247,0.3); }
    .logo-text h1 { font-size: 20px; font-weight: 700; }
    .logo-text p  { font-size: 13px; color: var(--muted); margin-top: 2px; }

    /* ── Stats ── */
    .stats { display: flex; gap: 12px; flex-wrap: wrap; margin-bottom: 32px; }
    .stat-card { background: var(--surface); border: 1px solid var(--border); border-radius: var(--radius); padding: 16px 22px; flex: 1; min-width: 130px; animation: fadeUp 0.4s ease both; }
    .stat-card:nth-child(1){animation-delay:.05s} .stat-card:nth-child(2){animation-delay:.1s}
    .stat-card:nth-child(3){animation-delay:.15s} .stat-card:nth-child(4){animation-delay:.2s}
    .stat-label { font-size: 12px; color: var(--muted); text-transform: uppercase; letter-spacing: .8px; margin-bottom: 6px; }
    .stat-value { font-size: 28px; font-weight: 700; }
    .stat-value.green{color:var(--green)} .stat-value.yellow{color:var(--yellow)}
    .stat-value.red{color:var(--red)}     .stat-value.blue{color:var(--accent)}

    /* ── Buttons ── */
    .btn { display: inline-flex; align-items: center; gap: 8px; padding: 11px 22px; border-radius: 10px; border: none; font-family: 'Outfit', sans-serif; font-size: 14px; font-weight: 600; cursor: pointer; text-decoration: none; transition: all 0.2s; }
    .btn-primary { background: linear-gradient(135deg, var(--accent), var(--accent2)); color: #fff; box-shadow: 0 4px 15px rgba(79,142,247,0.25); }
    .btn-primary:hover { transform: translateY(-1px); box-shadow: 0 6px 20px rgba(79,142,247,0.35); }
    .btn-secondary { background: var(--surface2); color: var(--text); border: 1px solid var(--border); }
    .btn-secondary:hover { background: var(--border); }

    /* ── Grid / Cards ── */
    .grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(320px, 1fr)); gap: 14px; }
    .card { background: var(--surface); border: 1px solid var(--border); border-radius: var(--radius); padding: 18px 20px; transition: transform 0.2s, box-shadow 0.2s; animation: fadeUp 0.4s ease both; position: relative; overflow: hidden; }
    .card:hover { transform: translateY(-2px); box-shadow: 0 8px 30px rgba(0,0,0,0.4); }
    .card::before { content: ''; position: absolute; top: 0; left: 0; right: 0; height: 3px; border-radius: var(--radius) var(--radius) 0 0; }
    .card.matched::before  { background: linear-gradient(90deg, var(--green), #16a34a); }
    .card.unmatched::before{ background: linear-gradient(90deg, var(--yellow), #d97706); }
    .card.updated::before  { background: linear-gradient(90deg, var(--accent), var(--accent2)); }
    .card.failed::before   { background: var(--red); }
    .card.skipped::before  { background: var(--muted); }
    .card-header { display: flex; align-items: flex-start; justify-content: space-between; gap: 10px; margin-bottom: 14px; }
    .card-name   { font-size: 14px; font-weight: 600; line-height: 1.4; }
    .badge { font-size: 11px; font-weight: 600; padding: 3px 10px; border-radius: 20px; white-space: nowrap; flex-shrink: 0; }
    .badge.matched  { background: rgba(34,197,94,0.15);  color: var(--green); }
    .badge.unmatched{ background: rgba(245,158,11,0.15); color: var(--yellow); }
    .badge.updated  { background: rgba(79,142,247,0.15); color: var(--accent); }
    .badge.failed   { background: rgba(239,68,68,0.15);  color: var(--red); }
    .badge.skipped  { background: rgba(107,114,128,0.15);color: var(--muted); }
    .card-meta { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; }
    .meta-key  { font-size: 11px; color: var(--muted); text-transform: uppercase; letter-spacing: .6px; margin-bottom: 3px; }
    .meta-val  { font-size: 15px; font-weight: 600; }
    .meta-val.price-val { color: var(--accent); }
    .sku-line  { font-size: 12px; color: var(--muted); margin-bottom: 12px; }
    .sku-line span { background: var(--surface2); border: 1px solid var(--border); padding: 2px 8px; border-radius: 6px; font-family: monospace; }
    .section-heading { font-size: 13px; font-weight: 600; color: var(--muted); text-transform: uppercase; letter-spacing: 1px; margin-bottom: 14px; margin-top: 32px; display: flex; align-items: center; gap: 8px; }
    .section-heading::after { content: ''; flex: 1; height: 1px; background: var(--border); }
    .error-box { background: rgba(239,68,68,0.1); border: 1px solid rgba(239,68,68,0.3); border-radius: var(--radius); padding: 20px 24px; margin-top: 20px; }
    .error-box h2 { color: var(--red); font-size: 16px; margin-bottom: 8px; }
    .error-box p  { color: var(--muted); font-size: 14px; }

    /* ── Sync panel (inline, on main page) ── */
    #sync-panel { margin-top: 40px; }
    #sync-panel .sync-loading { display: flex; align-items: center; gap: 14px; padding: 20px; background: var(--surface); border: 1px solid var(--border); border-radius: var(--radius); margin-bottom: 20px; }
    #sync-panel .sync-loading .mini-spin { width: 22px; height: 22px; border: 2px solid var(--border); border-top-color: var(--accent); border-radius: 50%; animation: spin 0.8s linear infinite; flex-shrink: 0; }
    #sync-panel .sync-loading p { font-size: 14px; color: var(--muted); }

    #content { opacity: 0; transition: opacity 0.5s ease; }
    #content.visible { opacity: 1; }

    @keyframes spin         { to { transform: rotate(360deg); } }
    @keyframes pulse        { 0%,100%{transform:scale(1);opacity:1} 50%{transform:scale(1.4);opacity:.6} }
    @keyframes blink        { 0%,80%,100%{opacity:0} 40%{opacity:1} }
    @keyframes indeterminate{ 0%{transform:translateX(-100%) scaleX(.3)} 50%{transform:translateX(60%) scaleX(.6)} 100%{transform:translateX(300%) scaleX(.3)} }
    @keyframes fadeUp       { from{opacity:0;transform:translateY(12px)} to{opacity:1;transform:translateY(0)} }
  </style>
</head>
<body>

<div class="loading-overlay" id="loading-overlay">
  <div class="spinner-wrap">
    <div class="spinner-outer"></div>
    <div class="spinner-inner"></div>
    <div class="spinner-dot"></div>
  </div>
  <div class="loading-title">იტვირთება მონაცემები<span class="loading-dots"><span>.</span><span>.</span><span>.</span></span></div>
  <div class="progress-track"><div class="progress-fill"></div></div>
  <div class="loading-sub" id="loading-sub">გთხოვთ დაელოდოთ</div>
</div>

<div class="wrapper">
  <div class="header">
    <div class="logo">
      <div class="logo-icon">⚡</div>
      <div class="logo-text">
        <h1>Intelectro სინქრონიზაცია</h1>
        <p>WooCommerce პროდუქტების მართვა</p>
      </div>
    </div>
  </div>
  <div id="content">${bodyContent}</div>
</div>

<script>
  const overlay    = document.getElementById('loading-overlay');
  const loadingSub = document.getElementById('loading-sub');
  const content    = document.getElementById('content');

  function hideOverlay() {
    overlay.classList.add('fade-out');
    setTimeout(() => { overlay.classList.add('hidden'); content.classList.add('visible'); }, 500);
  }

  function showOverlay(sub) {
    loadingSub.textContent = sub || 'გთხოვთ დაელოდოთ';
    overlay.classList.remove('hidden', 'fade-out');
  }

  ${autoFetch ? `
  // Auto-fetch on page load
  const steps = [
    'Intelectro API-სთან კავშირი...',
    'WooCommerce პროდუქტები იტვირთება...',
    'მონაცემები მუშავდება...',
    'თითქმის დასრულდა...'
  ];
  let step = 0;
  const stepTimer = setInterval(() => {
    if (step < steps.length) loadingSub.textContent = steps[step++];
  }, 3000);

  fetch('${autoFetch}')
    .then(r => r.text())
    .then(html => {
      clearInterval(stepTimer);
      const doc = new DOMParser().parseFromString(html, 'text/html');
      const newContent = doc.getElementById('content');
      if (newContent) content.innerHTML = newContent.innerHTML;
      bindSyncButton();
      hideOverlay();
    })
    .catch(err => {
      clearInterval(stepTimer);
      content.innerHTML = '<div class="error-box"><h2>⚠ შეცდომა</h2><p>' + err.message + '</p></div>';
      hideOverlay();
    });
  ` : `hideOverlay();`}

  function bindSyncButton() {
    const btn = document.getElementById('sync-btn');
    if (!btn) return;
    btn.addEventListener('click', async () => {
      btn.disabled = true;
      btn.textContent = 'მიმდინარეობს...';

      // Show inline sync loading panel
      const panel = document.getElementById('sync-panel');
      panel.innerHTML = \`
        <div class="sync-loading">
          <div class="mini-spin"></div>
          <p>სინქრონიზება მიმდინარეობს — პროდუქტების განახლება WooCommerce-ში<span class="loading-dots"><span>.</span><span>.</span><span>.</span></span></p>
        </div>\`;
      panel.style.display = 'block';

      // Scroll to panel
      panel.scrollIntoView({ behavior: 'smooth', block: 'start' });

      try {
        const res  = await fetch('/api/sync');
        const html = await res.text();
        const doc  = new DOMParser().parseFromString(html, 'text/html');
        const newContent = doc.getElementById('content');
        if (newContent) panel.innerHTML = newContent.innerHTML;
        else panel.innerHTML = html;
      } catch (err) {
        panel.innerHTML = '<div class="error-box"><h2>⚠ შეცდომა</h2><p>' + err.message + '</p></div>';
      }
    });
  }

  // Bind on load if content already present (non-autoFetch pages)
  bindSyncButton();
</script>
</body>
</html>`;
}

// ─── / (main page) — loads products + has inline sync ────────────────────────
app.get('/', (req, res) => {
  res.send(htmlShell('', { autoFetch: '/api/products' }));
});

// ─── /api/products ────────────────────────────────────────────────────────────
app.get('/api/products', async (req, res) => {
  try {
    const result = await buildProductList();
    const matched   = result.filter(p => p.status === 'MATCHED').length;
    const unmatched = result.filter(p => p.status === 'UNMATCHED').length;

    const statsHtml = `
      <div class="stats">
        <div class="stat-card"><div class="stat-label">სულ პროდუქტი</div><div class="stat-value blue">${result.length}</div></div>
        <div class="stat-card"><div class="stat-label">დამთხვეული</div><div class="stat-value green">${matched}</div></div>
        <div class="stat-card"><div class="stat-label">დაუმთხვეველი</div><div class="stat-value yellow">${unmatched}</div></div>
        <div class="stat-card"><div class="stat-label">სინქრონიზება</div><div class="stat-value" style="font-size:16px;padding-top:6px">
          <button id="sync-btn" class="btn btn-primary">▶ სინქრონიზება</button>
        </div></div>
      </div>`;

    let matchedCards = '', unmatchedCards = '';
    result.forEach((p, i) => {
      const cls   = p.status === 'MATCHED' ? 'matched' : 'unmatched';
      const badge = p.status === 'MATCHED' ? 'დამთხვეული' : 'დაუმთხვეველი';
      const card = `
        <div class="card ${cls}" style="animation-delay:${(i % 20) * 0.03}s">
          <div class="card-header">
            <div class="card-name">${p.name}</div>
            <span class="badge ${cls}">${badge}</span>
          </div>
          <div class="sku-line">SKU: <span>${p.sku}</span> &nbsp; ID: <span>${p.wcId}</span></div>
          <div class="card-meta">
            <div class="meta-item"><div class="meta-key">ფასი</div><div class="meta-val price-val">₾${p.price || '—'}</div></div>
            <div class="meta-item"><div class="meta-key">მარაგი</div><div class="meta-val">${p.instock}</div></div>
            <div class="meta-item"><div class="meta-key">დაჯავშნილი</div><div class="meta-val">${p.reserved || 0}</div></div>
            <div class="meta-item"><div class="meta-key">ბრენდი</div><div class="meta-val">${p.brand || '—'}</div></div>
          </div>
        </div>`;
      if (p.status === 'MATCHED') matchedCards += card;
      else unmatchedCards += card;
    });

    const body = statsHtml
      + `<div id="sync-panel" style="display:none"></div>`
      + `<div class="section-heading">დამთხვეული პროდუქტები (${matched})</div><div class="grid">${matchedCards}</div>`
      + `<div class="section-heading">დაუმთხვეველი პროდუქტები (${unmatched})</div><div class="grid">${unmatchedCards}</div>`;

    res.send(htmlShell(body));
  } catch (err) {
    const hint = getHint(err) || '';
    res.send(htmlShell(`<div class="error-box"><h2>⚠ შეცდომა</h2><p>${err.message}</p>${hint ? `<p style="margin-top:8px">${hint}</p>` : ''}</div>`));
  }
});

// ─── /api/sync ────────────────────────────────────────────────────────────────
app.get('/api/sync', async (req, res) => {
  try {
    const result = await buildProductList();
    let updated = 0, skipped = 0, failed = 0;
    const log = [];

    for (let i = 0; i < result.length; i += 3) {
      const batch = result.slice(i, i + 3);
      await Promise.all(batch.map(async (p) => {
        if (!p.price && p.instock === 0) {
          skipped++;
          log.push({ ...p, result: 'SKIPPED', reason: 'ფასი და მარაგი არ არის' });
          return;
        }
        try {
          await updateWcProduct(p.wcId, {
            regular_price: String(p.price),
            stock_quantity: Number(p.instock),
            manage_stock: true,
            stock_status: Number(p.instock) > 0 ? 'instock' : 'outofstock'
          });
          updated++;
          log.push({ ...p, result: 'UPDATED' });
        } catch (e) {
          failed++;
          log.push({ ...p, result: 'FAILED', reason: e.message });
        }
      }));
      await sleep(500);
    }

    const statsHtml = `
      <div class="stats" style="margin-top:0">
        <div class="stat-card"><div class="stat-label">განახლებული</div><div class="stat-value green">${updated}</div></div>
        <div class="stat-card"><div class="stat-label">გამოტოვებული</div><div class="stat-value yellow">${skipped}</div></div>
        <div class="stat-card"><div class="stat-label">შეცდომა</div><div class="stat-value red">${failed}</div></div>
      </div>`;

    let updCards = '', skipCards = '', failCards = '';
    log.forEach((p, i) => {
      const labelMap = { UPDATED: 'განახლდა', SKIPPED: 'გამოტოვდა', FAILED: 'შეცდომა' };
      const card = `
        <div class="card ${p.result.toLowerCase()}" style="animation-delay:${(i % 20) * 0.03}s">
          <div class="card-header">
            <div class="card-name">${p.name}</div>
            <span class="badge ${p.result.toLowerCase()}">${labelMap[p.result]}</span>
          </div>
          <div class="sku-line">SKU: <span>${p.sku}</span></div>
          <div class="card-meta">
            <div class="meta-item"><div class="meta-key">ფასი</div><div class="meta-val price-val">₾${p.price || '—'}</div></div>
            <div class="meta-item"><div class="meta-key">მარაგი</div><div class="meta-val">${p.instock ?? '—'}</div></div>
            ${p.reason ? `<div class="meta-item" style="grid-column:1/-1"><div class="meta-key">მიზეზი</div><div class="meta-val" style="font-size:13px;color:var(--muted)">${p.reason}</div></div>` : ''}
          </div>
        </div>`;
      if (p.result === 'UPDATED') updCards  += card;
      else if (p.result === 'SKIPPED') skipCards += card;
      else failCards += card;
    });

    const body = statsHtml
      + (updCards  ? `<div class="section-heading">განახლებული (${updated})</div><div class="grid">${updCards}</div>` : '')
      + (failCards ? `<div class="section-heading">შეცდომები (${failed})</div><div class="grid">${failCards}</div>` : '')
      + (skipCards ? `<div class="section-heading">გამოტოვებული (${skipped})</div><div class="grid">${skipCards}</div>` : '');

    res.send(htmlShell(body));
  } catch (err) {
    const hint = getHint(err) || '';
    res.send(htmlShell(`<div class="error-box"><h2>⚠ შეცდომა</h2><p>${err.message}</p>${hint ? `<p style="margin-top:8px">${hint}</p>` : ''}</div>`));
  }
});

app.listen(process.env.PORT || 3000, () => {
  console.log(`Server running at http://localhost:${process.env.PORT || 3000}`);
});
