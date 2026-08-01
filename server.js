const express = require('express');
const session = require('express-session');
const path    = require('path');
const helmet  = require('helmet');

const app          = express();
app.set('trust proxy', 1); // behind Render's proxy — without this every request
                            // looks like it comes from the same address, which
                            // breaks per-IP rate limiting and secure-cookie detection
const PORT         = process.env.PORT || 3000;
const SESSION_SECRET = process.env.SESSION_SECRET || 'sushant-secret-2026';
const ADMIN_PIN    = process.env.ADMIN_PIN  || '0000';
const CHANGE_PIN   = process.env.CHANGE_PIN || '9999';

/* ─────────────────── HELPERS ─────────────────── */

const MONTHS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
function nowStr() {
  const d = new Date();
  return `${String(d.getDate()).padStart(2,'0')}-${MONTHS[d.getMonth()]}-${d.getFullYear()} `
       + `${String(d.getHours()).padStart(2,'0')}:${String(d.getMinutes()).padStart(2,'0')}`;
}
function todayPrefix() {
  const d = new Date();
  return `${String(d.getDate()).padStart(2,'0')}-${MONTHS[d.getMonth()]}-${d.getFullYear()}`;
}
function parseDateStr(s) {
  if (!s) return null;
  const m = String(s).match(/(\d{1,2})-([A-Za-z]{3})-(\d{4})/);
  if (!m) return null;
  const mo = MONTHS.findIndex(x => x.toLowerCase() === m[2].toLowerCase());
  if (mo < 0) return null;
  return new Date(parseInt(m[3]), mo, parseInt(m[1]));
}
const money = v => { const n = parseFloat(String(v).replace(/[^0-9.\-]/g,'')); return isNaN(n) ? 0 : n; };

/* ─────────────────── RATE LIMITING ─────────────────── */
// Shared by login and by every PIN-protected action (cancel order, reset data).
// Keyed so a run of wrong PINs doesn't also lock out password logins, and vice versa.

const rateAttempts = new Map();
function checkRate(key) {
  const r = rateAttempts.get(key) || { count: 0, first: Date.now() };
  if (Date.now() - r.first > 15 * 60 * 1000) { rateAttempts.delete(key); return { blocked: false }; }
  if (r.count >= 5) return { blocked: true, secs: Math.ceil((r.first + 15*60*1000 - Date.now()) / 1000) };
  return { blocked: false };
}
function failAttempt(key) {
  const r = rateAttempts.get(key) || { count: 0, first: Date.now() };
  rateAttempts.set(key, { count: r.count + 1, first: r.first });
}
function clearAttempts(key) { rateAttempts.delete(key); }

/* ─────────────────── ORDER NUMBER ─────────────────── */

async function nextOrderNo(getFn) {
  const d = new Date();
  const yy = String(d.getFullYear()).slice(-2);
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const prefix = `SP-${yy}${mm}`;

  // Look at what already exists for this month. Orders may have been created
  // before this counter existed (or by an older version), so starting blindly
  // at 1 would regenerate a number that is already taken.
  const maxRow = await getFn(
    `SELECT COALESCE(MAX(CAST(SUBSTRING(order_no FROM '[0-9]+$') AS INTEGER)), 0) AS m
       FROM orders WHERE order_no LIKE $1`, [prefix + '-%']);
  const floor = (parseInt(maxRow && maxRow.m) || 0) + 1;

  // Take whichever is higher: the counter's next value, or one past the highest
  // order that actually exists. Self-healing if the two ever drift apart.
  const r = await getFn(
    `INSERT INTO counters(key,val) VALUES($1,$2)
     ON CONFLICT(key) DO UPDATE SET val = GREATEST(counters.val + 1, $2)
     RETURNING val`,
    [prefix, floor]);
  return `${prefix}-${String(r.val).padStart(4, '0')}`;
}

/* ─────────────────── DATABASE ─────────────────── */

async function initDB() {
  if (!process.env.DATABASE_URL) { console.error('DATABASE_URL not set'); process.exit(1); }

  const { Pool } = require('pg');
  const isLocal = /@(localhost|127\.0\.0\.1)[:\/]/.test(process.env.DATABASE_URL);
  const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: isLocal ? false : { rejectUnauthorized: false } });

  await pool.query('SELECT 1');
  app.locals.pool = pool;
  app.locals.run = (sql, p=[]) => pool.query(sql, p);
  app.locals.get = async (sql, p=[]) => { const r = await pool.query(sql, p); return r.rows[0]; };
  app.locals.all = async (sql, p=[]) => { const r = await pool.query(sql, p); return r.rows; };
  global.dbHelpers = { run: app.locals.run, get: app.locals.get, all: app.locals.all };

  const { run } = app.locals;

  /* ── Core tables ── */
  await run(`CREATE TABLE IF NOT EXISTS designs (
    id           SERIAL PRIMARY KEY,
    name         TEXT UNIQUE NOT NULL,
    default_rate NUMERIC(12,2) NOT NULL DEFAULT 0,
    sort_order   INTEGER NOT NULL DEFAULT 9999
  )`);

  await run(`CREATE TABLE IF NOT EXISTS orders (
    id             SERIAL PRIMARY KEY,
    order_no       TEXT UNIQUE NOT NULL,
    party_name     TEXT NOT NULL DEFAULT '',
    party_address  TEXT DEFAULT '',
    contact_person TEXT DEFAULT '',
    mobile         TEXT NOT NULL DEFAULT '',
    gst_no         TEXT DEFAULT '',
    transport      TEXT DEFAULT '',
    agent_name     TEXT DEFAULT '',
    agent_address  TEXT DEFAULT '',
    line_count     INTEGER NOT NULL DEFAULT 0,
    remarks        TEXT DEFAULT '',
    status         TEXT NOT NULL DEFAULT 'Booked',
    created_at     TEXT NOT NULL,
    updated_at     TEXT DEFAULT '',
    cancelled_at   TEXT DEFAULT '',
    cancel_reason  TEXT DEFAULT ''
  )`);

  /* order_lines: one row per design in an order */
  await run(`CREATE TABLE IF NOT EXISTS order_lines (
    id       SERIAL PRIMARY KEY,
    order_no TEXT NOT NULL,
    design   TEXT NOT NULL,
    qty      TEXT NOT NULL DEFAULT '',
    rate     NUMERIC(12,2) NOT NULL DEFAULT 0,
    remarks  TEXT DEFAULT '',
    line_no  INTEGER NOT NULL DEFAULT 0
  )`);

  await run(`CREATE TABLE IF NOT EXISTS status_log (
    id       SERIAL PRIMARY KEY,
    order_no TEXT NOT NULL,
    status   TEXT NOT NULL,
    note     TEXT DEFAULT '',
    at       TEXT NOT NULL
  )`);

  await run(`CREATE TABLE IF NOT EXISTS parties (
    id             SERIAL PRIMARY KEY,
    name           TEXT UNIQUE NOT NULL,
    address        TEXT DEFAULT '',
    contact_person TEXT DEFAULT '',
    mobile         TEXT DEFAULT '',
    gst_no         TEXT DEFAULT '',
    transport      TEXT DEFAULT '',
    agent_name     TEXT DEFAULT '',
    agent_address  TEXT DEFAULT ''
  )`);

  await run(`CREATE TABLE IF NOT EXISTS agents (
    id      SERIAL PRIMARY KEY,
    name    TEXT UNIQUE NOT NULL,
    address TEXT DEFAULT ''
  )`);

  await run(`CREATE TABLE IF NOT EXISTS counters (key TEXT PRIMARY KEY, val INTEGER NOT NULL DEFAULT 0)`);

  await run(`CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL DEFAULT '')`);

  await run(`CREATE TABLE IF NOT EXISTS session (
    sid TEXT PRIMARY KEY, sess TEXT NOT NULL, expire TIMESTAMPTZ NOT NULL
  )`);

  /* Indexes */
  await run(`CREATE INDEX IF NOT EXISTS idx_orders_no     ON orders(order_no)`);
  await run(`CREATE INDEX IF NOT EXISTS idx_orders_status ON orders(status)`);
  await run(`CREATE INDEX IF NOT EXISTS idx_lines_order   ON order_lines(order_no)`);
  await run(`CREATE INDEX IF NOT EXISTS idx_lines_design  ON order_lines(design)`);

  /* Migrations — safe on every boot */
  await run(`ALTER TABLE designs ADD COLUMN IF NOT EXISTS default_rate NUMERIC(12,2) NOT NULL DEFAULT 0`);
  await run(`ALTER TABLE designs ADD COLUMN IF NOT EXISTS sort_order   INTEGER       NOT NULL DEFAULT 9999`);
  /* orders migrations from v1/v2 schema */
  await run(`ALTER TABLE orders ADD COLUMN IF NOT EXISTS line_count    INTEGER NOT NULL DEFAULT 0`);
  await run(`ALTER TABLE orders ADD COLUMN IF NOT EXISTS remarks       TEXT DEFAULT ''`);
  await run(`ALTER TABLE orders ADD COLUMN IF NOT EXISTS cancelled_at  TEXT DEFAULT ''`);
  await run(`ALTER TABLE orders ADD COLUMN IF NOT EXISTS cancel_reason TEXT DEFAULT ''`);
  /* order_lines — may have old item_code column, leave it, just ensure new cols exist */
  await run(`ALTER TABLE order_lines ADD COLUMN IF NOT EXISTS qty      TEXT DEFAULT ''`);
  await run(`ALTER TABLE order_lines ADD COLUMN IF NOT EXISTS remarks  TEXT DEFAULT ''`);
  /* update old "Billed" status rows to "Booked" so the UI shows them */
  await run(`UPDATE orders SET status='Booked' WHERE status='Billed'`);

  const defaults = {
    company_name:    'Sushant Prints Pvt Ltd',
    company_tagline: 'An Exclusive Product',
    company_address: 'A2/106, Regent Textile Market, Kamela Darwaza, Ring Road, Surat',
    company_gst:     '24AAOCS1354A1ZP',
    company_phone:   '0261-3511456',
    company_mobile:  '9376834617'
  };
  for (const [k, v] of Object.entries(defaults)) {
    await run(`INSERT INTO settings(key,value) VALUES($1,$2) ON CONFLICT(key) DO NOTHING`, [k, v]);
  }

  console.log('DB ready (pg)');
  return pool;
}

/* ─────────────────── SESSION STORE ─────────────────── */

let pgStore = null;
class LazyStore extends session.Store {
  get(sid,cb)        { if(!pgStore) return cb(null,null);  return pgStore.get(sid,cb); }
  set(sid,sess,cb)   { if(!pgStore) return cb(null);        return pgStore.set(sid,sess,cb); }
  destroy(sid,cb)    { if(!pgStore) return cb(null);        return pgStore.destroy(sid,cb); }
  touch(sid,sess,cb) { if(!pgStore||!pgStore.touch) return cb&&cb(null); return pgStore.touch(sid,sess,cb); }
}
function makePgStore(pool) {
  const PgSession = require('connect-pg-simple')(session);
  return new PgSession({ pool, tableName: 'session', createTableIfMissing: false });
}

/* ─────────────────── MIDDLEWARE ─────────────────── */

app.use(helmet({
  // The frontend is one inline <script> block with hundreds of onclick=""
  // handlers and inline styles, and it loads QRious/jsQR from a CDN. A
  // default CSP blocks all of that and would render the app blank. Enabling
  // a real CSP here means first rewriting those inline handlers into
  // addEventListener calls — a frontend project of its own, not a quick
  // header change. Left off deliberately rather than shipped half-broken.
  contentSecurityPolicy: false,
  // Also off: COEP requires cross-origin resources (our QRious/jsQR CDN
  // scripts) to send matching CORP/CORS headers, which those CDNs don't.
  // Turning this on would silently block the QR library from loading.
  crossOriginEmbedderPolicy: false
}));
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true }));
app.use(session({
  store: new LazyStore(),
  secret: SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  cookie: {
    maxAge: 1000*60*60*24*30, httpOnly: true, sameSite: 'lax',
    // Only require HTTPS for the cookie when we're not on localhost, so local
    // testing over plain http still works. Render always serves over HTTPS.
    secure: !/@(localhost|127\.0\.0\.1)[:\/]/.test(process.env.DATABASE_URL || '')
  }
}));
app.use(express.static(path.join(__dirname, 'public')));

function auth(req, res, next) {
  if (req.session && req.session.authenticated) return next();
  res.status(401).json({ error: 'Not authenticated' });
}
function wrap(fn) {
  return (req, res, next) => fn(req, res, next).catch(err => {
    console.error('Route error:', err.message);
    res.status(500).json({ error: 'Server error: ' + err.message });
  });
}

/* ─────────────────── AUTH ─────────────────── */

app.post('/api/login', (req, res) => {
  const ip = req.ip || 'unknown';
  const key = 'login:' + ip;
  const lim = checkRate(key);
  if (lim.blocked) return res.status(429).json({ error: `Too many attempts. Try again in ${lim.secs} seconds.` });
  if (req.body.password === (process.env.APP_PASSWORD || '')) {
    clearAttempts(key);
    req.session.authenticated = true;
    return res.json({ ok: true });
  }
  failAttempt(key);
  const r = rateAttempts.get(key) || { count: 0 };
  res.status(401).json({ error: 'Wrong password', attemptsLeft: Math.max(0, 5 - r.count) });
});
app.post('/api/logout', (req, res) => { if (req.session) req.session.destroy(() => {}); res.json({ ok: true }); });
app.get('/api/me', (req, res) => res.json({ authenticated: !!(req.session && req.session.authenticated) }));

/* ─────────────────── DESIGNS ─────────────────── */

// GET /api/designs — full list for the master, dropdown, and label printing
app.get('/api/designs', auth, wrap(async (req, res) => {
  const rows = await req.app.locals.all(`SELECT * FROM designs ORDER BY sort_order, name`);
  res.json({ designs: rows });
}));

// POST /api/designs — add a design to the master
app.post('/api/designs', auth, wrap(async (req, res) => {
  const { get, run } = req.app.locals;
  const name = String(req.body.name || '').trim();
  const rate = money(req.body.rate);
  if (!name) return res.status(400).json({ error: 'Design name is required' });
  try {
    const m = await get(`SELECT MAX(sort_order) AS m FROM designs`);
    const ord = (m && m.m != null) ? parseInt(m.m) : 0;
    const row = await get(
      `INSERT INTO designs(name,default_rate,sort_order) VALUES($1,$2,$3) RETURNING *`,
      [name, rate, ord + 1]);
    res.json({ ok: true, design: row });
  } catch(e) {
    if (e.code === '23505') return res.status(409).json({ error: 'That design is already in the list' });
    throw e;
  }
}));

// POST /api/designs/rate — update a design's default rate
app.post('/api/designs/rate', auth, wrap(async (req, res) => {
  await req.app.locals.run(`UPDATE designs SET default_rate=$1 WHERE name=$2`,
    [money(req.body.rate), String(req.body.name || '').trim()]);
  res.json({ ok: true });
}));

// DELETE /api/designs/:name
app.delete('/api/designs/:name', auth, wrap(async (req, res) => {
  await req.app.locals.run(`DELETE FROM designs WHERE name=$1`, [decodeURIComponent(req.params.name)]);
  res.json({ ok: true });
}));

/* ─────────────────── SCAN ─────────────────── */

// POST /api/scan { code }
// The QR on a design label encodes the design name or /d/<name>.
// Returns { status:'design', design:{name,default_rate} } so the frontend
// can show the "How many sets?" prompt.
// Also handles /o/<orderNo> QRs on printed order forms.
app.post('/api/scan', auth, wrap(async (req, res) => {
  const { get } = req.app.locals;
  let code = String(req.body.code || '').trim();
  if (!code) return res.json({ status: 'empty' });

  // Strip URL wrapper — QRs may carry the full page URL
  if (/^https?:\/\//i.test(code)) {
    try {
      const u = new URL(code);
      const parts = u.pathname.split('/').filter(Boolean);
      // /o/<orderNo>  or  /d/<designName>
      if (parts[0] === 'o') code = parts.slice(1).join('/');
      else if (parts[0] === 'd') code = 'd:' + decodeURIComponent(parts.slice(1).join('/'));
      else code = decodeURIComponent(parts.pop() || '');
    } catch(e) {}
  }
  code = code.replace(/^\/+|\/+$/, '');

  // Explicit design path markers: 'd:name' or '/d/name' or '/d/<id>'
  let designName = null;
  if (code.startsWith('d:'))  designName = code.slice(2).trim();
  if (code.startsWith('/d/')) designName = decodeURIComponent(code.slice(3)).trim();
  if (designName !== null) {
    // Labels carry the numeric design id to keep the QR small and easy to read.
    if (/^\d+$/.test(designName)) {
      const byId = await get(`SELECT * FROM designs WHERE id=$1`, [parseInt(designName)]);
      if (byId) return res.json({ status: 'design', design: byId });
    }
    const d = await get(`SELECT * FROM designs WHERE LOWER(name)=LOWER($1)`, [designName]);
    if (d) return res.json({ status: 'design', design: d });
    // Not in master yet — return the name anyway so the counter can add it
    return res.json({ status: 'design', design: { name: designName, default_rate: 0 } });
  }

  // Order number pattern — opens an existing order
  if (/^SP-\d{4}-\d{4}$/i.test(code)) {
    const order = await get(`SELECT order_no FROM orders WHERE UPPER(order_no)=UPPER($1)`, [code]);
    if (order) return res.json({ status: 'order', orderNo: order.order_no });
  }

  // Try it as a design name (for simple bare-name QRs or typed lookups)
  const byName = await get(`SELECT * FROM designs WHERE LOWER(name)=LOWER($1)`, [code]);
  if (byName) return res.json({ status: 'design', design: byName });

  // Partial / search fallback
  res.json({ status: 'not_found', code });
}));

/* ─────────────────── ORDERS ─────────────────── */

// POST /api/orders  { party:{}, lines:[{design,qty,rate,remarks}], remarks }
app.post('/api/orders', auth, wrap(async (req, res) => {
  const pool = req.app.locals.pool;
  const p = req.body.party || {};
  const rawLines = Array.isArray(req.body.lines) ? req.body.lines : [];
  const lines = rawLines
    .map(l => ({
      design:  String(l.design  || '').trim(),
      qty:     String(l.qty     || '').trim(),
      rate:    money(l.rate),
      remarks: String(l.remarks || '').trim()
    }))
    .filter(l => l.design);
  const remarks = String(req.body.remarks || '').trim();

  if (!String(p.partyName || '').trim()) return res.status(400).json({ error: 'Enter the party name' });
  if (!String(p.mobile    || '').trim()) return res.status(400).json({ error: 'Enter a mobile number' });
  if (!lines.length)                     return res.status(400).json({ error: 'Add at least one design line' });

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const orderNo   = await nextOrderNo(async (sql,prm) => (await client.query(sql,prm)).rows[0]);
    const createdAt = nowStr();

    await client.query(
      `INSERT INTO orders(order_no,party_name,party_address,contact_person,mobile,gst_no,transport,
         agent_name,agent_address,line_count,remarks,status,created_at,updated_at)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'Booked',$12,$12)`,
      [orderNo,
       String(p.partyName     ||'').trim(), String(p.address       ||'').trim(),
       String(p.contactPerson ||'').trim(), String(p.mobile        ||'').trim(),
       String(p.gstNo         ||'').trim().toUpperCase(),
       String(p.transport     ||'').trim(), String(p.agentName     ||'').trim(),
       String(p.agentAddress  ||'').trim(), lines.length, remarks, createdAt]);

    for (let i = 0; i < lines.length; i++) {
      const l = lines[i];
      await client.query(
        `INSERT INTO order_lines(order_no,design,qty,rate,remarks,line_no) VALUES($1,$2,$3,$4,$5,$6)`,
        [orderNo, l.design, l.qty, l.rate, l.remarks, i + 1]);
    }
    await client.query(
      `INSERT INTO status_log(order_no,status,note,at) VALUES($1,'Booked','Order form created',$2)`,
      [orderNo, createdAt]);

    // Save party & agent for future autofill
    const pname = String(p.partyName||'').trim();
    if (pname) {
      await client.query(
        `INSERT INTO parties(name,address,contact_person,mobile,gst_no,transport,agent_name,agent_address)
         VALUES($1,$2,$3,$4,$5,$6,$7,$8)
         ON CONFLICT(name) DO UPDATE SET address=$2,contact_person=$3,mobile=$4,gst_no=$5,
           transport=$6,agent_name=$7,agent_address=$8`,
        [pname, String(p.address||'').trim(), String(p.contactPerson||'').trim(),
         String(p.mobile||'').trim(), String(p.gstNo||'').trim().toUpperCase(),
         String(p.transport||'').trim(), String(p.agentName||'').trim(),
         String(p.agentAddress||'').trim()]);
    }
    const aname = String(p.agentName||'').trim();
    if (aname) {
      await client.query(
        `INSERT INTO agents(name,address) VALUES($1,$2) ON CONFLICT(name) DO UPDATE SET address=$2`,
        [aname, String(p.agentAddress||'').trim()]);
    }
    // Add new designs to master
    for (const l of lines) {
      await client.query(
        `INSERT INTO designs(name,default_rate,sort_order) VALUES($1,$2,9999)
         ON CONFLICT(name) DO UPDATE SET default_rate=CASE WHEN designs.default_rate=0 THEN $2 ELSE designs.default_rate END`,
        [l.design, l.rate]);
    }

    await client.query('COMMIT');
    res.json({ ok: true, orderNo });
  } catch(e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}));

// GET /api/orders
app.get('/api/orders', auth, wrap(async (req, res) => {
  const { all } = req.app.locals;
  const { status, search, date, limit } = req.query;
  let sql = `SELECT * FROM orders WHERE 1=1`;
  const p = []; let i = 1;
  if (date)   { sql += ` AND created_at LIKE $${i++}`;  p.push(date + '%'); }
  if (status) { sql += ` AND status=$${i++}`;            p.push(status); }
  if (search) {
    sql += ` AND (order_no ILIKE $${i} OR party_name ILIKE $${i+1} OR mobile ILIKE $${i+2}
             OR EXISTS(SELECT 1 FROM order_lines ol WHERE ol.order_no=orders.order_no AND ol.design ILIKE $${i+3}))`;
    const q = `%${search}%`; p.push(q,q,q,q); i += 4;
  }
  sql += ` ORDER BY id DESC`;
  if (limit) { sql += ` LIMIT $${i++}`; p.push(parseInt(limit)); }
  res.json({ orders: await all(sql, p) });
}));

// GET /api/orders/:orderNo
app.get('/api/orders/:orderNo', auth, wrap(async (req, res) => {
  const { get, all } = req.app.locals;
  const orderNo = decodeURIComponent(req.params.orderNo);
  const order = await get(`SELECT * FROM orders WHERE order_no=$1`, [orderNo]);
  if (!order) return res.status(404).json({ error: 'not_found' });
  const lines = await all(`SELECT * FROM order_lines WHERE order_no=$1 ORDER BY line_no,id`, [orderNo]);
  const log   = await all(`SELECT * FROM status_log WHERE order_no=$1 ORDER BY id DESC`, [orderNo]);
  res.json({ order, lines, log });
}));

// POST /api/orders/:orderNo/cancel
app.post('/api/orders/:orderNo/cancel', auth, wrap(async (req, res) => {
  const { run, get } = req.app.locals;
  const orderNo = decodeURIComponent(req.params.orderNo);
  const rkey = 'pin:' + (req.ip || 'unknown');
  const rlim = checkRate(rkey);
  if (rlim.blocked) return res.status(429).json({ ok: false, error: `Too many wrong PINs. Try again in ${rlim.secs} seconds.` });
  if (req.body.pin !== ADMIN_PIN) { failAttempt(rkey); return res.json({ ok: false, error: 'wrong_pin' }); }
  clearAttempts(rkey);
  const order = await get(`SELECT status FROM orders WHERE order_no=$1`, [orderNo]);
  if (!order)                       return res.json({ ok: false, error: 'not_found' });
  if (order.status === 'Cancelled') return res.json({ ok: false, error: 'already_cancelled' });
  const at = nowStr();
  await run(`UPDATE orders SET status='Cancelled',cancelled_at=$1,cancel_reason=$2,updated_at=$1 WHERE order_no=$3`,
    [at, String(req.body.reason||'').trim(), orderNo]);
  await run(`INSERT INTO status_log(order_no,status,note,at) VALUES($1,'Cancelled',$2,$3)`,
    [orderNo, String(req.body.reason||'').trim(), at]);
  res.json({ ok: true });
}));

/* ─────────────────── PARTIES / AGENTS ─────────────────── */

app.get('/api/parties', auth, wrap(async (req, res) =>
  res.json({ parties: await req.app.locals.all(`SELECT * FROM parties ORDER BY name`) })));
app.post('/api/parties', auth, wrap(async (req, res) => {
  const b = req.body; const name = String(b.name||'').trim();
  if (!name) return res.status(400).json({ error: 'Party name is required' });
  await req.app.locals.run(
    `INSERT INTO parties(name,address,contact_person,mobile,gst_no,transport,agent_name,agent_address)
     VALUES($1,$2,$3,$4,$5,$6,$7,$8)
     ON CONFLICT(name) DO UPDATE SET address=$2,contact_person=$3,mobile=$4,gst_no=$5,transport=$6,agent_name=$7,agent_address=$8`,
    [name,String(b.address||'').trim(),String(b.contactPerson||'').trim(),String(b.mobile||'').trim(),
     String(b.gstNo||'').trim().toUpperCase(),String(b.transport||'').trim(),
     String(b.agentName||'').trim(),String(b.agentAddress||'').trim()]);
  res.json({ ok: true });
}));
app.delete('/api/parties/:name', auth, wrap(async (req, res) => {
  await req.app.locals.run(`DELETE FROM parties WHERE name=$1`, [decodeURIComponent(req.params.name)]);
  res.json({ ok: true });
}));
app.get('/api/agents', auth, wrap(async (req, res) =>
  res.json({ agents: await req.app.locals.all(`SELECT * FROM agents ORDER BY name`) })));
app.post('/api/agents', auth, wrap(async (req, res) => {
  const name = String(req.body.name||'').trim();
  if (!name) return res.status(400).json({ error: 'Agent name is required' });
  await req.app.locals.run(`INSERT INTO agents(name,address) VALUES($1,$2) ON CONFLICT(name) DO UPDATE SET address=$2`,
    [name, String(req.body.address||'').trim()]);
  res.json({ ok: true });
}));
app.delete('/api/agents/:name', auth, wrap(async (req, res) => {
  await req.app.locals.run(`DELETE FROM agents WHERE name=$1`, [decodeURIComponent(req.params.name)]);
  res.json({ ok: true });
}));

/* ─────────────────── STATS ─────────────────── */

app.get('/api/stats', auth, wrap(async (req, res) => {
  const { get } = req.app.locals;
  const prefix = todayPrefix();
  const c = async (sql,p=[]) => parseInt((await get(sql,p)).c || 0);
  const ordersToday = await c(`SELECT COUNT(*) AS c FROM orders WHERE created_at LIKE $1`, [prefix+'%']);
  const totalOrders = await c(`SELECT COUNT(*) AS c FROM orders WHERE status='Booked'`);
  res.json({ ordersToday, totalOrders });
}));

/* ─────────────────── REPORTS ─────────────────── */

app.get('/api/report/range', auth, wrap(async (req, res) => {
  const { all } = req.app.locals;
  const from = parseDateStr((req.query.from||'').replace(/Z$/,''));
  const to   = parseDateStr((req.query.to  ||'').replace(/Z$/,''));
  if (to) to.setHours(23,59,59,999);

  const allOrders = await all(`SELECT * FROM orders ORDER BY id DESC`);
  const orders = allOrders.filter(o => {
    const d = parseDateStr(o.created_at); if (!d) return false;
    if (from && d < from) return false;
    if (to   && d > to)   return false;
    return true;
  });
  const active = orders.filter(o => o.status !== 'Cancelled');
  const nos = active.map(o => o.order_no);
  let lines = [];
  if (nos.length) lines = await all(`SELECT * FROM order_lines WHERE order_no = ANY($1)`, [nos]);

  // Sets ordered per design
  const dMap = {};
  lines.forEach(l => {
    if (!dMap[l.design]) dMap[l.design] = { design: l.design, sets: 0, orders: 0 };
    dMap[l.design].sets   += parseInt(l.qty) || 0;
    dMap[l.design].orders += 1;
  });
  const byDesign = Object.values(dMap).sort((a,b) => b.sets - a.sets);

  // Sets ordered per party
  const pMap = {};
  active.forEach(o => {
    const key = o.party_name || '(no name)';
    if (!pMap[key]) pMap[key] = { party: key, orders: 0, sets: 0 };
    pMap[key].orders++;
    pMap[key].sets += o.line_count || 0;
  });
  const byParty = Object.values(pMap).sort((a,b) => b.orders - a.orders);

  res.json({
    orders, activeCount: active.length,
    cancelledCount: orders.filter(o => o.status==='Cancelled').length,
    byDesign, byParty
  });
}));

/* ─────────────────── SETTINGS / PIN ─────────────────── */

app.get('/api/settings', auth, wrap(async (req, res) => {
  const rows = await req.app.locals.all(`SELECT key,value FROM settings`);
  const flat = {}; rows.forEach(r => flat[r.key] = r.value);
  res.json(flat);
}));
app.post('/api/settings', auth, wrap(async (req, res) => {
  if (!req.body.key) return res.status(400).json({ error: 'Missing key' });
  await req.app.locals.run(`INSERT INTO settings(key,value) VALUES($1,$2) ON CONFLICT(key) DO UPDATE SET value=$2`,
    [req.body.key, req.body.value||'']);
  res.json({ ok: true });
}));
app.post('/api/verify-pin', auth, (req, res) => {
  const rkey = 'pin:' + (req.ip || 'unknown');
  const rlim = checkRate(rkey);
  if (rlim.blocked) return res.status(429).json({ ok: false, error: `Too many wrong PINs. Try again in ${rlim.secs} seconds.` });
  if (req.body.pin === CHANGE_PIN) { clearAttempts(rkey); return res.json({ ok: true }); }
  failAttempt(rkey);
  res.status(401).json({ ok: false, error: 'Wrong PIN' });
});

// POST /api/reset — wipe test data. Requires the admin PIN and a typed phrase.
// { pin, confirm:'DELETE ALL', alsoMasters:bool }
app.post('/api/reset', auth, wrap(async (req, res) => {
  const rkey = 'pin:' + (req.ip || 'unknown');
  const rlim = checkRate(rkey);
  if (rlim.blocked) return res.status(429).json({ error: `Too many wrong PINs. Try again in ${rlim.secs} seconds.` });
  if (req.body.pin !== ADMIN_PIN) { failAttempt(rkey); return res.status(401).json({ error: 'Wrong admin PIN' }); }
  clearAttempts(rkey);
  if (req.body.confirm !== 'DELETE ALL') return res.status(400).json({ error: 'Type DELETE ALL exactly to confirm' });
  const { run, get } = req.app.locals;

  await run(`TRUNCATE order_lines, status_log, orders RESTART IDENTITY`);
  await run(`DELETE FROM counters`);            // order numbers restart at 0001
  let mastersCleared = false;
  if (req.body.alsoMasters) {
    await run(`TRUNCATE designs, parties, agents RESTART IDENTITY`);
    mastersCleared = true;
  }
  const left = await get(`SELECT COUNT(*) AS c FROM orders`);
  res.json({ ok: true, ordersLeft: parseInt(left.c) || 0, mastersCleared });
}));

/* ─────────────────── BACKUP ─────────────────── */

const BACKUP_MONTHS = MONTHS;
async function getSheets() {
  const { google } = require('googleapis');
  const clientEmail = process.env.GOOGLE_CLIENT_EMAIL;
  const privateKey  = (process.env.GOOGLE_PRIVATE_KEY||'').replace(/\\n/g,'\n');
  const sheetId     = process.env.GOOGLE_SHEET_ID;
  if (!clientEmail||!privateKey||!sheetId) return null;
  const authj = new google.auth.JWT(clientEmail,null,privateKey,['https://www.googleapis.com/auth/spreadsheets']);
  return { sheets: google.sheets({ version:'v4', auth:authj }), sheetId };
}
async function runBackup() {
  const client = await getSheets();
  if (!client) { console.log('[Backup] Google Sheets not configured.'); return; }
  const { sheets, sheetId } = client;
  const { all } = global.dbHelpers;
  const d = new Date(); d.setDate(d.getDate()-1);
  const pfx = `${String(d.getDate()).padStart(2,'0')}-${BACKUP_MONTHS[d.getMonth()]}-${d.getFullYear()}`;
  try {
    const orders = await all(`SELECT * FROM orders WHERE created_at LIKE $1 ORDER BY id`, [pfx+'%']);
    if (!orders.length) { console.log(`[Backup] No orders for ${pfx}`); return; }
    const nos = orders.map(o => o.order_no);
    const lines = await all(`SELECT * FROM order_lines WHERE order_no=ANY($1) ORDER BY order_no,line_no`, [nos]);
    const byOrder = {}; lines.forEach(l => (byOrder[l.order_no]=byOrder[l.order_no]||[]).push(l));
    const meta = await sheets.spreadsheets.get({ spreadsheetId: sheetId });
    if (!meta.data.sheets.map(s=>s.properties.title).includes(pfx)) {
      await sheets.spreadsheets.batchUpdate({ spreadsheetId:sheetId,
        requestBody:{ requests:[{ addSheet:{ properties:{ title:pfx } } }] } });
    }
    const header = ['Order No','Date','Party','Mobile','GST','Design','Qty (sets)','Rate','Remarks','Status'];
    const rows = [];
    orders.forEach(o => {
      const ls = byOrder[o.order_no] || [{ design:'', qty:'', rate:'', remarks:'' }];
      ls.forEach((l,idx) => rows.push([
        idx===0?o.order_no:'', idx===0?o.created_at:'',
        idx===0?o.party_name:'', idx===0?o.mobile:'', idx===0?o.gst_no:'',
        l.design, l.qty, l.rate, l.remarks, idx===0?o.status:''
      ]));
    });
    const summary = [[`Summary — ${pfx}`],
      ['Orders',orders.filter(o=>o.status==='Booked').length],
      ['Cancelled',orders.filter(o=>o.status==='Cancelled').length],
      [], header, ...rows];
    await sheets.spreadsheets.values.update({ spreadsheetId:sheetId, range:`${pfx}!A1`,
      valueInputOption:'RAW', requestBody:{ values:summary } });
    console.log(`[Backup] ${orders.length} orders backed up for ${pfx}`);
  } catch(err) { console.error('[Backup] Error:', err.message); }
}
app.post('/api/backup/trigger', auth, async (req,res) => {
  try { await runBackup(); res.json({ ok:true, message:'Backup done. Check the Google Sheet.' }); }
  catch(e) { res.status(500).json({ ok:false, error:e.message }); }
});
function scheduleNightlyBackup() {
  function msUntil() {
    const now=new Date(); const next=new Date();
    next.setUTCHours(18,30,0,0); if(next<=now) next.setUTCDate(next.getUTCDate()+1);
    return next-now;
  }
  function loop() { runBackup(); setTimeout(loop, msUntil()); }
  setTimeout(loop, msUntil());
  console.log(`[Backup] Nightly backup set for midnight IST. Next in ${Math.round(msUntil()/60000)} min.`);
}

/* ─────────────────── CATCH-ALL ─────────────────── */

app.get('*', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

/* ─────────────────── START ─────────────────── */

initDB().then(pool => {
  pgStore = makePgStore(pool);
  app.listen(PORT, () => {
    console.log(`Sushant Order System on port ${PORT}`);
    scheduleNightlyBackup();
  });
}).catch(err => {
  console.error('DB init failed:', err);
  process.exit(1);
});
