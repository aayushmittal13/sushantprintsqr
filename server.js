const express = require('express');
const session = require('express-session');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;
const SESSION_SECRET = process.env.SESSION_SECRET || 'sushant-secret-key-2026';
const CHANGE_PIN = process.env.CHANGE_PIN || '9999';
const ADMIN_PIN = process.env.ADMIN_PIN || '0000';

/* ─────────────────── DATABASE ─────────────────── */

async function initDB() {
  if (!process.env.DATABASE_URL) {
    console.error('DATABASE_URL not set');
    process.exit(1);
  }

  const { Pool } = require('pg');
  // Railway needs SSL. A database running on the same machine does not have it.
  const isLocal = /@(localhost|127\.0\.0\.1)[:\/]/.test(process.env.DATABASE_URL);
  const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: isLocal ? false : { rejectUnauthorized: false }
  });

  await pool.query('SELECT 1');

  app.locals.pool = pool;
  app.locals.run = (sql, p = []) => pool.query(sql, p);
  app.locals.get = async (sql, p = []) => { const r = await pool.query(sql, p); return r.rows[0]; };
  app.locals.all = async (sql, p = []) => { const r = await pool.query(sql, p); return r.rows; };

  global.dbHelpers = {
    run: (sql, p = []) => pool.query(sql, p),
    get: async (sql, p = []) => { const r = await pool.query(sql, p); return r.rows[0]; },
    all: async (sql, p = []) => { const r = await pool.query(sql, p); return r.rows; }
  };

  const { run, get } = app.locals;

  /* ── Orders ── */
  await run(`CREATE TABLE IF NOT EXISTS orders (
    id             SERIAL PRIMARY KEY,
    order_no       TEXT UNIQUE NOT NULL,
    party_name     TEXT NOT NULL,
    party_address  TEXT DEFAULT '',
    contact_person TEXT DEFAULT '',
    mobile         TEXT NOT NULL DEFAULT '',
    gst_no         TEXT DEFAULT '',
    transport      TEXT DEFAULT '',
    agent_name     TEXT DEFAULT '',
    agent_address  TEXT DEFAULT '',
    master_qty     TEXT DEFAULT '',
    master_remarks TEXT DEFAULT '',
    status         TEXT NOT NULL DEFAULT 'Pending',
    created_at     TEXT NOT NULL,
    updated_at     TEXT DEFAULT '',
    delivered_at   TEXT DEFAULT '',
    cancelled_at   TEXT DEFAULT '',
    cancel_reason  TEXT DEFAULT ''
  )`);

  /* ── Order design lines ── */
  await run(`CREATE TABLE IF NOT EXISTS order_items (
    id       SERIAL PRIMARY KEY,
    order_no TEXT NOT NULL,
    design   TEXT NOT NULL,
    qty      TEXT DEFAULT '',
    remarks  TEXT DEFAULT '',
    line_no  INTEGER DEFAULT 0
  )`);

  /* ── Status history ── */
  await run(`CREATE TABLE IF NOT EXISTS status_log (
    id       SERIAL PRIMARY KEY,
    order_no TEXT NOT NULL,
    status   TEXT NOT NULL,
    note     TEXT DEFAULT '',
    at       TEXT NOT NULL
  )`);

  /* ── Party master ── */
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

  /* ── Agent master ── */
  await run(`CREATE TABLE IF NOT EXISTS agents (
    id      SERIAL PRIMARY KEY,
    name    TEXT UNIQUE NOT NULL,
    address TEXT DEFAULT ''
  )`);

  /* ── Design master ── */
  await run(`CREATE TABLE IF NOT EXISTS designs (
    id         SERIAL PRIMARY KEY,
    name       TEXT UNIQUE NOT NULL,
    sort_order INTEGER DEFAULT 0
  )`);

  /* ── Atomic counters for order numbering ── */
  await run(`CREATE TABLE IF NOT EXISTS counters (
    key TEXT PRIMARY KEY,
    val INTEGER NOT NULL DEFAULT 0
  )`);

  await run(`CREATE TABLE IF NOT EXISTS settings (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
  )`);

  await run(`CREATE TABLE IF NOT EXISTS exported_dates (
    date_prefix TEXT PRIMARY KEY
  )`);

  await run(`CREATE TABLE IF NOT EXISTS session (
    sid    TEXT PRIMARY KEY,
    sess   TEXT NOT NULL,
    expire TIMESTAMPTZ NOT NULL
  )`);

  await run(`CREATE INDEX IF NOT EXISTS idx_orders_status   ON orders(status)`);
  await run(`CREATE INDEX IF NOT EXISTS idx_orders_created  ON orders(created_at)`);
  await run(`CREATE INDEX IF NOT EXISTS idx_orders_no       ON orders(order_no)`);
  await run(`CREATE INDEX IF NOT EXISTS idx_orders_party    ON orders(party_name)`);
  await run(`CREATE INDEX IF NOT EXISTS idx_items_order     ON order_items(order_no)`);
  await run(`CREATE INDEX IF NOT EXISTS idx_log_order       ON status_log(order_no)`);

  /* ── Seed company details from the letterhead, only once ── */
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

  // Attach PG session store now that the middleware is mounted
  const sessionLayer = app._router && app._router.stack.find(l => l.handle && l.handle.name === 'session');
  if (sessionLayer) sessionLayer.handle.store = makePgStore(pool);

  console.log('DB ready (pg)');
}

/* ─────────────────── PG SESSION STORE ─────────────────── */

function makePgStore(pool) {
  class PgStore extends session.Store {
    async get(sid, cb) {
      try {
        const r = await pool.query('SELECT sess FROM session WHERE sid=$1 AND expire>NOW()', [sid]);
        cb(null, r.rows[0] ? JSON.parse(r.rows[0].sess) : null);
      } catch (e) { cb(e); }
    }
    async set(sid, sess, cb) {
      const exp = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);
      try {
        await pool.query(
          `INSERT INTO session(sid,sess,expire) VALUES($1,$2,$3) ON CONFLICT(sid) DO UPDATE SET sess=$2,expire=$3`,
          [sid, JSON.stringify(sess), exp]
        );
        cb(null);
      } catch (e) { cb(e); }
    }
    async destroy(sid, cb) {
      try { await pool.query('DELETE FROM session WHERE sid=$1', [sid]); cb(null); }
      catch (e) { cb(e); }
    }
  }
  return new PgStore();
}

/* ─────────────────── TIME HELPERS ─────────────────── */

const MONTHS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];

function istNow() {
  return new Date(new Date().getTime() + 5.5 * 60 * 60 * 1000);
}

function todayPrefix() {
  const d = istNow();
  return `${String(d.getUTCDate()).padStart(2,'0')}-${MONTHS[d.getUTCMonth()]}-${d.getUTCFullYear()}`;
}

function nowStr() {
  const d = istNow();
  return `${String(d.getUTCDate()).padStart(2,'0')}-${MONTHS[d.getUTCMonth()]}-${d.getUTCFullYear()} ${String(d.getUTCHours()).padStart(2,'0')}:${String(d.getUTCMinutes()).padStart(2,'0')}`;
}

// created_at is stored as "DD-Mon-YYYY HH:MM". String comparison breaks across
// months because month names do not sort in calendar order, so parse properly.
function parseDateStr(str) {
  if (!str) return null;
  const M = {Jan:0,Feb:1,Mar:2,Apr:3,May:4,Jun:5,Jul:6,Aug:7,Sep:8,Oct:9,Nov:10,Dec:11};
  const parts = String(str).split(' ')[0].split('-');
  if (parts.length < 3) return null;
  const [dd, mon, yyyy] = parts;
  if (M[mon] === undefined) return null;
  return new Date(parseInt(yyyy), M[mon], parseInt(dd));
}

// SP-2607-0042 — year, month, then a counter that restarts each month
async function nextOrderNo(run, get) {
  const d = istNow();
  const yy = String(d.getUTCFullYear()).slice(-2);
  const mm = String(d.getUTCMonth() + 1).padStart(2, '0');
  const key = `order-${yy}${mm}`;
  const r = await get(
    `INSERT INTO counters(key,val) VALUES($1,1)
     ON CONFLICT(key) DO UPDATE SET val = counters.val + 1
     RETURNING val`,
    [key]
  );
  return `SP-${yy}${mm}-${String(r.val).padStart(4, '0')}`;
}

/* ─────────────────── RATE LIMITING ─────────────────── */

const loginAttempts = new Map();

function checkRate(ip) {
  const rec = loginAttempts.get(ip) || { count: 0, lockedUntil: 0 };
  if (rec.lockedUntil > Date.now()) return { blocked: true, secs: Math.ceil((rec.lockedUntil - Date.now()) / 1000) };
  return { blocked: false };
}

function failLogin(ip) {
  const rec = loginAttempts.get(ip) || { count: 0, lockedUntil: 0 };
  rec.count++;
  if (rec.count >= 5) { rec.lockedUntil = Date.now() + 5 * 60 * 1000; rec.count = 0; }
  loginAttempts.set(ip, rec);
}

/* ─────────────────── MIDDLEWARE ─────────────────── */

app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true }));
app.use(session({
  secret: SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  cookie: { maxAge: 1000 * 60 * 60 * 24 * 30, httpOnly: true, sameSite: 'lax' }
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
  const lim = checkRate(ip);
  if (lim.blocked) return res.status(429).json({ error: `Too many attempts. Try again in ${lim.secs} seconds.` });
  const PWD = process.env.APP_PASSWORD || '';
  if (req.body.password === PWD) {
    loginAttempts.delete(ip);
    req.session.authenticated = true;
    return res.json({ ok: true });
  }
  failLogin(ip);
  const r = loginAttempts.get(ip) || { count: 0 };
  res.status(401).json({ error: 'Wrong password', attemptsLeft: Math.max(0, 5 - r.count) });
});

app.post('/api/logout', (req, res) => {
  if (req.session) req.session.destroy(() => {});
  res.json({ ok: true });
});

app.get('/api/me', (req, res) => {
  res.json({ authenticated: !!(req.session && req.session.authenticated) });
});

/* ─────────────────── ORDERS ─────────────────── */

// POST /api/orders
// Body: { party:{...}, items:[{design,qty,remarks}], masterQty, masterRemarks }
// Response: { ok:true, orderNo }
app.post('/api/orders', auth, wrap(async (req, res) => {
  const { run, get } = req.app.locals;
  const p = req.body.party || {};
  const items = Array.isArray(req.body.items) ? req.body.items : [];

  if (!p.partyName || !String(p.partyName).trim()) return res.status(400).json({ error: 'Party name is required' });
  if (!p.mobile || !String(p.mobile).trim())       return res.status(400).json({ error: 'Mobile number is required' });

  const clean = items
    .filter(i => i && i.design && String(i.design).trim())
    .map((i, n) => ({ design: String(i.design).trim(), qty: String(i.qty || '').trim(), remarks: String(i.remarks || '').trim(), line: n + 1 }));

  if (!clean.length) return res.status(400).json({ error: 'Add at least one design' });

  const orderNo  = await nextOrderNo(run, get);
  const createdAt = nowStr();

  await run(
    `INSERT INTO orders(order_no,party_name,party_address,contact_person,mobile,gst_no,transport,
                        agent_name,agent_address,master_qty,master_remarks,status,created_at,updated_at)
     VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'Pending',$12,$12)`,
    [
      orderNo,
      String(p.partyName).trim(),
      String(p.address || '').trim(),
      String(p.contactPerson || '').trim(),
      String(p.mobile).trim(),
      String(p.gstNo || '').trim(),
      String(p.transport || '').trim(),
      String(p.agentName || '').trim(),
      String(p.agentAddress || '').trim(),
      String(req.body.masterQty || '').trim(),
      String(req.body.masterRemarks || '').trim(),
      createdAt
    ]
  );

  for (const it of clean) {
    await run(
      `INSERT INTO order_items(order_no,design,qty,remarks,line_no) VALUES($1,$2,$3,$4,$5)`,
      [orderNo, it.design, it.qty, it.remarks, it.line]
    );
    // Any freshly typed design joins the master list automatically
    await run(
      `INSERT INTO designs(name,sort_order) VALUES($1,9999) ON CONFLICT(name) DO NOTHING`,
      [it.design]
    );
  }

  await run(`INSERT INTO status_log(order_no,status,note,at) VALUES($1,'Pending','Order created',$2)`, [orderNo, createdAt]);

  // Remember the party so the next order autofills
  await run(
    `INSERT INTO parties(name,address,contact_person,mobile,gst_no,transport,agent_name,agent_address)
     VALUES($1,$2,$3,$4,$5,$6,$7,$8)
     ON CONFLICT(name) DO UPDATE SET
       address=$2, contact_person=$3, mobile=$4, gst_no=$5, transport=$6, agent_name=$7, agent_address=$8`,
    [
      String(p.partyName).trim(), String(p.address || '').trim(), String(p.contactPerson || '').trim(),
      String(p.mobile).trim(), String(p.gstNo || '').trim(), String(p.transport || '').trim(),
      String(p.agentName || '').trim(), String(p.agentAddress || '').trim()
    ]
  );

  if (p.agentName && String(p.agentName).trim()) {
    await run(
      `INSERT INTO agents(name,address) VALUES($1,$2) ON CONFLICT(name) DO UPDATE SET address=$2`,
      [String(p.agentName).trim(), String(p.agentAddress || '').trim()]
    );
  }

  res.json({ ok: true, orderNo });
}));

// PUT /api/orders/:orderNo — replace party block, design lines and master fields
app.put('/api/orders/:orderNo', auth, wrap(async (req, res) => {
  const { run, get } = req.app.locals;
  const orderNo = decodeURIComponent(req.params.orderNo);
  const p = req.body.party || {};
  const items = Array.isArray(req.body.items) ? req.body.items : [];

  const existing = await get(`SELECT * FROM orders WHERE order_no=$1`, [orderNo]);
  if (!existing) return res.status(404).json({ error: 'Order not found' });

  if (!p.partyName || !String(p.partyName).trim()) return res.status(400).json({ error: 'Party name is required' });
  if (!p.mobile || !String(p.mobile).trim())       return res.status(400).json({ error: 'Mobile number is required' });

  const clean = items
    .filter(i => i && i.design && String(i.design).trim())
    .map((i, n) => ({ design: String(i.design).trim(), qty: String(i.qty || '').trim(), remarks: String(i.remarks || '').trim(), line: n + 1 }));
  if (!clean.length) return res.status(400).json({ error: 'Add at least one design' });

  const updatedAt = nowStr();

  await run(
    `UPDATE orders SET party_name=$1, party_address=$2, contact_person=$3, mobile=$4, gst_no=$5,
       transport=$6, agent_name=$7, agent_address=$8, master_qty=$9, master_remarks=$10, updated_at=$11
     WHERE order_no=$12`,
    [
      String(p.partyName).trim(), String(p.address || '').trim(), String(p.contactPerson || '').trim(),
      String(p.mobile).trim(), String(p.gstNo || '').trim(), String(p.transport || '').trim(),
      String(p.agentName || '').trim(), String(p.agentAddress || '').trim(),
      String(req.body.masterQty || '').trim(), String(req.body.masterRemarks || '').trim(),
      updatedAt, orderNo
    ]
  );

  await run(`DELETE FROM order_items WHERE order_no=$1`, [orderNo]);
  for (const it of clean) {
    await run(
      `INSERT INTO order_items(order_no,design,qty,remarks,line_no) VALUES($1,$2,$3,$4,$5)`,
      [orderNo, it.design, it.qty, it.remarks, it.line]
    );
    await run(`INSERT INTO designs(name,sort_order) VALUES($1,9999) ON CONFLICT(name) DO NOTHING`, [it.design]);
  }

  await run(`INSERT INTO status_log(order_no,status,note,at) VALUES($1,$2,'Order edited',$3)`, [orderNo, existing.status, updatedAt]);
  res.json({ ok: true, orderNo });
}));

// GET /api/orders — list with filters
app.get('/api/orders', auth, wrap(async (req, res) => {
  const { all } = req.app.locals;
  const { date, status, party, search, limit } = req.query;

  let sql = `SELECT o.*, COALESCE(c.n,0) AS design_count FROM orders o
             LEFT JOIN (SELECT order_no, COUNT(*) AS n FROM order_items GROUP BY order_no) c
               ON c.order_no = o.order_no
             WHERE 1=1`;
  const params = [];
  let i = 1;

  if (date)   { sql += ` AND o.created_at LIKE $${i++}`; params.push(date + '%'); }
  if (status) { sql += ` AND o.status = $${i++}`;        params.push(status); }
  if (party)  { sql += ` AND o.party_name = $${i++}`;    params.push(party); }

  if (search) {
    sql += ` AND (o.order_no ILIKE $${i} OR o.party_name ILIKE $${i+1} OR o.mobile ILIKE $${i+2}
             OR o.agent_name ILIKE $${i+3}
             OR EXISTS (SELECT 1 FROM order_items oi WHERE oi.order_no=o.order_no AND oi.design ILIKE $${i+4}))`;
    const q = `%${search}%`;
    params.push(q, q, q, q, q);
    i += 5;
  }

  sql += ` ORDER BY o.id DESC`;
  if (limit) { sql += ` LIMIT $${i++}`; params.push(parseInt(limit)); }

  const orders = await all(sql, params);
  res.json({ orders });
}));

// GET /api/orders/:orderNo — full record, this is what a QR scan lands on
app.get('/api/orders/:orderNo', auth, wrap(async (req, res) => {
  const { get, all } = req.app.locals;
  const orderNo = decodeURIComponent(req.params.orderNo);
  const order = await get(`SELECT * FROM orders WHERE order_no=$1`, [orderNo]);
  if (!order) return res.status(404).json({ error: 'not_found' });
  const items = await all(`SELECT * FROM order_items WHERE order_no=$1 ORDER BY line_no, id`, [orderNo]);
  const log   = await all(`SELECT * FROM status_log WHERE order_no=$1 ORDER BY id DESC`, [orderNo]);
  res.json({ order, items, log });
}));

// POST /api/orders/:orderNo/status — { status, note }
const VALID_STATUS = ['Pending', 'In Process', 'Ready', 'Delivered', 'Cancelled'];

app.post('/api/orders/:orderNo/status', auth, wrap(async (req, res) => {
  const { get, run } = req.app.locals;
  const orderNo = decodeURIComponent(req.params.orderNo);
  const { status, note } = req.body;

  if (!VALID_STATUS.includes(status)) return res.status(400).json({ error: 'Unknown status' });

  const order = await get(`SELECT * FROM orders WHERE order_no=$1`, [orderNo]);
  if (!order) return res.json({ ok: false, reason: 'not_found' });
  if (order.status === status) return res.json({ ok: false, reason: 'unchanged', status });

  const at = nowStr();
  if (status === 'Delivered') {
    await run(`UPDATE orders SET status=$1, delivered_at=$2, updated_at=$2 WHERE order_no=$3`, [status, at, orderNo]);
  } else if (status === 'Cancelled') {
    await run(`UPDATE orders SET status=$1, cancelled_at=$2, cancel_reason=$3, updated_at=$2 WHERE order_no=$4`,
      [status, at, String(note || '').trim(), orderNo]);
  } else {
    await run(`UPDATE orders SET status=$1, updated_at=$2 WHERE order_no=$3`, [status, at, orderNo]);
  }

  await run(`INSERT INTO status_log(order_no,status,note,at) VALUES($1,$2,$3,$4)`, [orderNo, status, String(note || '').trim(), at]);
  res.json({ ok: true, status, previous: order.status });
}));

// DELETE /api/orders/:orderNo — permanent, needs the admin PIN
app.delete('/api/orders/:orderNo', auth, wrap(async (req, res) => {
  const { get, run } = req.app.locals;
  const orderNo = decodeURIComponent(req.params.orderNo);
  const { pin } = req.body;
  if (!pin || pin !== ADMIN_PIN) return res.json({ ok: false, error: 'wrong_pin' });
  const order = await get(`SELECT id FROM orders WHERE order_no=$1`, [orderNo]);
  if (!order) return res.json({ ok: false, error: 'not_found' });
  await run(`DELETE FROM order_items WHERE order_no=$1`, [orderNo]);
  await run(`DELETE FROM status_log  WHERE order_no=$1`, [orderNo]);
  await run(`DELETE FROM orders      WHERE order_no=$1`, [orderNo]);
  res.json({ ok: true });
}));

/* ─────────────────── SCAN ─────────────────── */

// POST /api/scan-check — { code } where code is a full URL or a bare order number
app.post('/api/scan-check', auth, wrap(async (req, res) => {
  const { get, all } = req.app.locals;
  let code = String(req.body.code || '').trim();
  if (!code) return res.json({ status: 'empty' });

  // A scanned QR usually carries the whole URL, so take the last path segment
  if (/^https?:\/\//i.test(code)) {
    try { code = decodeURIComponent(new URL(code).pathname.split('/').filter(Boolean).pop() || ''); }
    catch (e) { /* fall through with the raw value */ }
  }
  code = code.replace(/^\/+|\/+$/g, '').toUpperCase();

  const order = await get(`SELECT * FROM orders WHERE UPPER(order_no)=$1`, [code]);
  if (!order) return res.json({ status: 'not_found', code });
  const items = await all(`SELECT * FROM order_items WHERE order_no=$1 ORDER BY line_no, id`, [order.order_no]);
  res.json({ status: 'ok', order, items });
}));

/* ─────────────────── DESIGN MASTER ─────────────────── */

app.get('/api/designs', auth, wrap(async (req, res) => {
  const rows = await req.app.locals.all(`SELECT name FROM designs ORDER BY sort_order, name`);
  res.json({ designs: rows.map(r => r.name) });
}));

app.post('/api/designs', auth, wrap(async (req, res) => {
  const { get, run } = req.app.locals;
  const name = String(req.body.name || '').trim();
  if (!name) return res.status(400).json({ error: 'Design name is required' });
  try {
    const maxRow = await get(`SELECT MAX(sort_order) AS m FROM designs`);
    const maxOrder = (maxRow && maxRow.m !== null) ? parseInt(maxRow.m) : 0;
    await run(`INSERT INTO designs(name,sort_order) VALUES($1,$2)`, [name, maxOrder + 1]);
    res.json({ ok: true });
  } catch (e) {
    if (e.code === '23505') return res.status(409).json({ error: 'That design is already on the list' });
    throw e;
  }
}));

app.delete('/api/designs/:name', auth, wrap(async (req, res) => {
  await req.app.locals.run(`DELETE FROM designs WHERE name=$1`, [decodeURIComponent(req.params.name)]);
  res.json({ ok: true });
}));

/* ─────────────────── PARTY MASTER ─────────────────── */

app.get('/api/parties', auth, wrap(async (req, res) => {
  const rows = await req.app.locals.all(`SELECT * FROM parties ORDER BY name ASC`);
  res.json({ parties: rows });
}));

app.post('/api/parties', auth, wrap(async (req, res) => {
  const { run } = req.app.locals;
  const b = req.body;
  const name = String(b.name || '').trim();
  if (!name) return res.status(400).json({ error: 'Party name is required' });
  await run(
    `INSERT INTO parties(name,address,contact_person,mobile,gst_no,transport,agent_name,agent_address)
     VALUES($1,$2,$3,$4,$5,$6,$7,$8)
     ON CONFLICT(name) DO UPDATE SET
       address=$2, contact_person=$3, mobile=$4, gst_no=$5, transport=$6, agent_name=$7, agent_address=$8`,
    [name, String(b.address||'').trim(), String(b.contactPerson||'').trim(), String(b.mobile||'').trim(),
     String(b.gstNo||'').trim(), String(b.transport||'').trim(), String(b.agentName||'').trim(), String(b.agentAddress||'').trim()]
  );
  res.json({ ok: true });
}));

app.delete('/api/parties/:name', auth, wrap(async (req, res) => {
  await req.app.locals.run(`DELETE FROM parties WHERE name=$1`, [decodeURIComponent(req.params.name)]);
  res.json({ ok: true });
}));

/* ─────────────────── AGENT MASTER ─────────────────── */

app.get('/api/agents', auth, wrap(async (req, res) => {
  const rows = await req.app.locals.all(`SELECT * FROM agents ORDER BY name ASC`);
  res.json({ agents: rows });
}));

app.post('/api/agents', auth, wrap(async (req, res) => {
  const name = String(req.body.name || '').trim();
  if (!name) return res.status(400).json({ error: 'Agent name is required' });
  await req.app.locals.run(
    `INSERT INTO agents(name,address) VALUES($1,$2) ON CONFLICT(name) DO UPDATE SET address=$2`,
    [name, String(req.body.address || '').trim()]
  );
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
  const c = async (sql, p = []) => parseInt((await get(sql, p)).c);

  const total     = await c(`SELECT COUNT(*) AS c FROM orders`);
  const pending   = await c(`SELECT COUNT(*) AS c FROM orders WHERE status='Pending'`);
  const process_  = await c(`SELECT COUNT(*) AS c FROM orders WHERE status='In Process'`);
  const ready     = await c(`SELECT COUNT(*) AS c FROM orders WHERE status='Ready'`);
  const delivered = await c(`SELECT COUNT(*) AS c FROM orders WHERE status='Delivered'`);
  const today     = await c(`SELECT COUNT(*) AS c FROM orders WHERE created_at LIKE $1`, [prefix + '%']);
  const open      = pending + process_ + ready;

  res.json({ total, pending, inProcess: process_, ready, delivered, today, open });
}));

/* ─────────────────── REPORT ─────────────────── */

app.get('/api/report/range', auth, wrap(async (req, res) => {
  const { all } = req.app.locals;
  const fromDate = parseDateStr((req.query.from || '').replace(/Z$/, ''));
  const toDate   = parseDateStr((req.query.to   || '').replace(/Z$/, ''));
  if (toDate) toDate.setHours(23, 59, 59, 999);

  const allOrders = await all(`SELECT * FROM orders ORDER BY id DESC`);
  const orders = allOrders.filter(o => {
    const d = parseDateStr(o.created_at);
    if (!d) return false;
    if (fromDate && d < fromDate) return false;
    if (toDate   && d > toDate)   return false;
    return true;
  });

  const nos = orders.map(o => o.order_no);
  let items = [];
  if (nos.length) items = await all(`SELECT * FROM order_items WHERE order_no = ANY($1)`, [nos]);

  const num = v => { const n = parseFloat(String(v).replace(/[^0-9.\-]/g, '')); return isNaN(n) ? 0 : n; };

  const designMap = {};
  items.forEach(it => {
    if (!designMap[it.design]) designMap[it.design] = { design: it.design, lines: 0, qty: 0 };
    designMap[it.design].lines++;
    designMap[it.design].qty += num(it.qty);
  });
  const byDesign = Object.values(designMap).sort((a, b) => b.qty - a.qty);

  const partyMap = {};
  orders.forEach(o => {
    if (!partyMap[o.party_name]) partyMap[o.party_name] = { party: o.party_name, orders: 0, qty: 0 };
    partyMap[o.party_name].orders++;
    partyMap[o.party_name].qty += num(o.master_qty);
  });
  const byParty = Object.values(partyMap).sort((a, b) => b.orders - a.orders);

  res.json({
    orders,
    created:   orders.length,
    delivered: orders.filter(o => o.status === 'Delivered').length,
    cancelled: orders.filter(o => o.status === 'Cancelled').length,
    open:      orders.filter(o => ['Pending','In Process','Ready'].includes(o.status)).length,
    totalQty:  orders.reduce((s, o) => s + num(o.master_qty), 0),
    byDesign,
    byParty
  });
}));

/* ─────────────────── SETTINGS / PIN ─────────────────── */

app.get('/api/settings', auth, wrap(async (req, res) => {
  const rows = await req.app.locals.all(`SELECT key, value FROM settings`);
  const flat = {};
  rows.forEach(r => { flat[r.key] = r.value; });
  res.json(flat);
}));

app.post('/api/settings', auth, wrap(async (req, res) => {
  const { key, value } = req.body;
  if (!key) return res.status(400).json({ error: 'Missing key' });
  await req.app.locals.run(
    `INSERT INTO settings(key,value) VALUES($1,$2) ON CONFLICT(key) DO UPDATE SET value=$2`,
    [key, value || '']
  );
  res.json({ ok: true });
}));

app.post('/api/verify-pin', auth, (req, res) => {
  if (req.body.pin === CHANGE_PIN) return res.json({ ok: true });
  res.status(401).json({ ok: false, error: 'Wrong PIN' });
});

app.get('/api/exported', auth, wrap(async (req, res) => {
  const rows = await req.app.locals.all(`SELECT date_prefix FROM exported_dates`);
  const exported = {};
  rows.forEach(r => { exported[r.date_prefix] = true; });
  res.json({ exported });
}));

app.post('/api/exported', auth, wrap(async (req, res) => {
  if (!req.body.date) return res.status(400).json({ error: 'Missing date' });
  await req.app.locals.run(`INSERT INTO exported_dates(date_prefix) VALUES($1) ON CONFLICT DO NOTHING`, [req.body.date]);
  res.json({ ok: true });
}));

/* ─────────────────── GOOGLE SHEETS BACKUP ─────────────────── */

async function getGoogleSheetsClient() {
  const { google } = require('googleapis');
  const clientEmail = process.env.GOOGLE_CLIENT_EMAIL;
  const privateKey  = (process.env.GOOGLE_PRIVATE_KEY || '').replace(/\\n/g, '\n');
  const sheetId     = process.env.GOOGLE_SHEET_ID;
  if (!clientEmail || !privateKey || !sheetId) return null;
  const auth = new google.auth.JWT(clientEmail, null, privateKey, ['https://www.googleapis.com/auth/spreadsheets']);
  return { sheets: google.sheets({ version: 'v4', auth }), sheetId };
}

async function runGoogleBackup() {
  const client = await getGoogleSheetsClient();
  if (!client) { console.log('[Backup] Google Sheets not configured, skipping.'); return; }

  const { sheets, sheetId } = client;
  const { all } = global.dbHelpers;

  const d = new Date();
  d.setDate(d.getDate() - 1);
  const pfx = `${String(d.getDate()).padStart(2,'0')}-${MONTHS[d.getMonth()]}-${d.getFullYear()}`;

  console.log(`[Backup] Starting backup for ${pfx}`);
  try {
    const orders = await all(`SELECT * FROM orders WHERE created_at LIKE $1 ORDER BY id ASC`, [pfx + '%']);
    if (!orders.length) { console.log(`[Backup] No orders for ${pfx}, skipping.`); return; }

    const nos = orders.map(o => o.order_no);
    const items = await all(`SELECT * FROM order_items WHERE order_no = ANY($1) ORDER BY order_no, line_no`, [nos]);
    const byOrder = {};
    items.forEach(it => { (byOrder[it.order_no] = byOrder[it.order_no] || []).push(it); });

    const spreadsheet = await sheets.spreadsheets.get({ spreadsheetId: sheetId });
    const existing = spreadsheet.data.sheets.map(s => s.properties.title);
    if (!existing.includes(pfx)) {
      await sheets.spreadsheets.batchUpdate({
        spreadsheetId: sheetId,
        requestBody: { requests: [{ addSheet: { properties: { title: pfx } } }] }
      });
    }

    const headers = ['Order No','Date','Party','Contact','Mobile','GST','Transport','Agent','Design','Design Qty','Design Remarks','Master Qty','Master Remarks','Status'];
    const rows = [];
    orders.forEach(o => {
      const lines = byOrder[o.order_no] || [{ design: '', qty: '', remarks: '' }];
      lines.forEach((l, idx) => {
        rows.push([
          idx === 0 ? o.order_no : '', idx === 0 ? o.created_at : '',
          idx === 0 ? o.party_name : '', idx === 0 ? (o.contact_person||'') : '',
          idx === 0 ? (o.mobile||'') : '', idx === 0 ? (o.gst_no||'') : '',
          idx === 0 ? (o.transport||'') : '', idx === 0 ? (o.agent_name||'') : '',
          l.design, l.qty, l.remarks,
          idx === 0 ? (o.master_qty||'') : '', idx === 0 ? (o.master_remarks||'') : '',
          idx === 0 ? o.status : ''
        ]);
      });
    });

    const summary = [
      [`Summary — ${pfx}`],
      ['Orders created', orders.length],
      ['Delivered',      orders.filter(o => o.status === 'Delivered').length],
      ['Cancelled',      orders.filter(o => o.status === 'Cancelled').length],
      [],
      headers,
      ...rows
    ];

    await sheets.spreadsheets.values.update({
      spreadsheetId: sheetId,
      range: `${pfx}!A1`,
      valueInputOption: 'RAW',
      requestBody: { values: summary }
    });

    console.log(`[Backup] Backed up ${orders.length} orders for ${pfx}`);
  } catch (err) {
    console.error('[Backup] Error:', err.message);
  }
}

app.post('/api/backup/trigger', auth, async (req, res) => {
  try { await runGoogleBackup(); res.json({ ok: true, message: 'Backup finished. Check the Google Sheet.' }); }
  catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

function scheduleNightlyBackup() {
  function msUntilNext1830UTC() {
    const now = new Date();
    const next = new Date();
    next.setUTCHours(18, 30, 0, 0);
    if (next <= now) next.setUTCDate(next.getUTCDate() + 1);
    return next - now;
  }
  function runAndReschedule() {
    runGoogleBackup();
    setTimeout(runAndReschedule, msUntilNext1830UTC());
  }
  setTimeout(runAndReschedule, msUntilNext1830UTC());
  console.log(`[Backup] Nightly backup set for midnight IST. Next run in ${Math.round(msUntilNext1830UTC()/60000)} minutes.`);
}

/* ─────────────────── CATCH-ALL ─────────────────── */
// /o/SP-2607-0001 is what the QR codes point at. It serves the app, which then
// reads the path and opens that order.
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

/* ─────────────────── START ─────────────────── */

initDB().then(() => {
  app.listen(PORT, () => {
    console.log(`Sushant Order System on port ${PORT}`);
    scheduleNightlyBackup();
  });
}).catch(err => {
  console.error('DB init failed:', err);
  process.exit(1);
});
