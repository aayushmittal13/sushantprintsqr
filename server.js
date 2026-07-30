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

  /* ── Items: one row per physical piece of stock ──
     status: in_stock | in_cart | sold | cancelled                         */
  await run(`CREATE TABLE IF NOT EXISTS items (
    id          SERIAL PRIMARY KEY,
    item_code   TEXT UNIQUE NOT NULL,
    design      TEXT NOT NULL,
    rate        NUMERIC(12,2) NOT NULL DEFAULT 0,
    status      TEXT NOT NULL DEFAULT 'in_stock',
    batch_id    TEXT DEFAULT '',
    order_no    TEXT DEFAULT '',
    created_at  TEXT NOT NULL,
    sold_at     TEXT DEFAULT ''
  )`);

  /* ── Orders: a bill made from scanned items ── */
  await run(`CREATE TABLE IF NOT EXISTS orders (
    id             SERIAL PRIMARY KEY,
    order_no       TEXT UNIQUE NOT NULL,
    party_name     TEXT DEFAULT '',
    party_address  TEXT DEFAULT '',
    contact_person TEXT DEFAULT '',
    mobile         TEXT DEFAULT '',
    gst_no         TEXT DEFAULT '',
    transport      TEXT DEFAULT '',
    agent_name     TEXT DEFAULT '',
    agent_address  TEXT DEFAULT '',
    piece_count    INTEGER NOT NULL DEFAULT 0,
    total_amount   NUMERIC(14,2) NOT NULL DEFAULT 0,
    discount       NUMERIC(14,2) NOT NULL DEFAULT 0,
    net_amount     NUMERIC(14,2) NOT NULL DEFAULT 0,
    remarks        TEXT DEFAULT '',
    order_type     TEXT NOT NULL DEFAULT 'scanned',
    master_qty     TEXT DEFAULT '',
    status         TEXT NOT NULL DEFAULT 'Billed',
    created_at     TEXT NOT NULL,
    updated_at     TEXT DEFAULT '',
    cancelled_at   TEXT DEFAULT '',
    cancel_reason  TEXT DEFAULT ''
  )`);

  /* ── Line snapshot: what each order contained, frozen at sale time ── */
  await run(`CREATE TABLE IF NOT EXISTS order_lines (
    id        SERIAL PRIMARY KEY,
    order_no  TEXT NOT NULL,
    item_code TEXT NOT NULL DEFAULT '',
    design    TEXT NOT NULL,
    rate      NUMERIC(12,2) NOT NULL DEFAULT 0,
    qty       TEXT DEFAULT '',
    remarks   TEXT DEFAULT '',
    line_no   INTEGER DEFAULT 0
  )`);

  await run(`CREATE TABLE IF NOT EXISTS status_log (
    id       SERIAL PRIMARY KEY,
    order_no TEXT NOT NULL,
    status   TEXT NOT NULL,
    note     TEXT DEFAULT '',
    at       TEXT NOT NULL
  )`);

  /* ── Batch record: each run of the Generate QR screen ── */
  await run(`CREATE TABLE IF NOT EXISTS batches (
    id          SERIAL PRIMARY KEY,
    batch_id    TEXT UNIQUE NOT NULL,
    design      TEXT NOT NULL,
    rate        NUMERIC(12,2) NOT NULL DEFAULT 0,
    qty         INTEGER NOT NULL DEFAULT 0,
    created_at  TEXT NOT NULL
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

  /* ── Design master, now with a default rate ── */
  await run(`CREATE TABLE IF NOT EXISTS designs (
    id           SERIAL PRIMARY KEY,
    name         TEXT UNIQUE NOT NULL,
    default_rate NUMERIC(12,2) DEFAULT 0,
    sort_order   INTEGER DEFAULT 0
  )`);

  await run(`CREATE TABLE IF NOT EXISTS counters (
    key TEXT PRIMARY KEY,
    val INTEGER NOT NULL DEFAULT 0
  )`);

  await run(`CREATE TABLE IF NOT EXISTS settings (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
  )`);

  await run(`CREATE TABLE IF NOT EXISTS exported_dates (date_prefix TEXT PRIMARY KEY)`);

  await run(`CREATE TABLE IF NOT EXISTS session (
    sid    TEXT PRIMARY KEY,
    sess   TEXT NOT NULL,
    expire TIMESTAMPTZ NOT NULL
  )`);

  await run(`CREATE INDEX IF NOT EXISTS idx_items_status  ON items(status)`);
  await run(`CREATE INDEX IF NOT EXISTS idx_items_design  ON items(design)`);
  await run(`CREATE INDEX IF NOT EXISTS idx_items_code    ON items(item_code)`);
  await run(`CREATE INDEX IF NOT EXISTS idx_orders_status ON orders(status)`);
  await run(`CREATE INDEX IF NOT EXISTS idx_orders_no     ON orders(order_no)`);
  await run(`CREATE INDEX IF NOT EXISTS idx_lines_order   ON order_lines(order_no)`);

  // Migrations — run on every boot, safe no-ops once columns exist.
  // The live database was created by v1/v2 which had a different orders schema.
  // Every column the v3 server reads or writes that didn't exist before needs
  // an ADD COLUMN IF NOT EXISTS guard here.
  await run(`ALTER TABLE orders ADD COLUMN IF NOT EXISTS piece_count    INTEGER          NOT NULL DEFAULT 0`);
  await run(`ALTER TABLE orders ADD COLUMN IF NOT EXISTS total_amount   NUMERIC(14,2)    NOT NULL DEFAULT 0`);
  await run(`ALTER TABLE orders ADD COLUMN IF NOT EXISTS discount       NUMERIC(14,2)    NOT NULL DEFAULT 0`);
  await run(`ALTER TABLE orders ADD COLUMN IF NOT EXISTS net_amount     NUMERIC(14,2)    NOT NULL DEFAULT 0`);
  await run(`ALTER TABLE orders ADD COLUMN IF NOT EXISTS remarks        TEXT             DEFAULT ''`);
  await run(`ALTER TABLE orders ADD COLUMN IF NOT EXISTS order_type     TEXT             NOT NULL DEFAULT 'scanned'`);
  await run(`ALTER TABLE orders ADD COLUMN IF NOT EXISTS master_qty     TEXT             DEFAULT ''`);
  // order_lines is the v3 equivalent of the old order_items table. Both exist
  // independently; old orders link to order_items, new ones to order_lines.
  await run(`ALTER TABLE order_lines ADD COLUMN IF NOT EXISTS qty       TEXT             DEFAULT ''`);
  await run(`ALTER TABLE order_lines ADD COLUMN IF NOT EXISTS remarks   TEXT             DEFAULT ''`);
  await run(`ALTER TABLE order_lines ALTER COLUMN item_code SET DEFAULT ''`);
  // designs gained these columns in v3.
  await run(`ALTER TABLE designs ADD COLUMN IF NOT EXISTS default_rate  NUMERIC(12,2)    DEFAULT 0`);
  await run(`ALTER TABLE designs ADD COLUMN IF NOT EXISTS sort_order    INTEGER          DEFAULT 9999`);

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
          [sid, JSON.stringify(sess), exp]);
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
function istNow() { return new Date(new Date().getTime() + 5.5 * 60 * 60 * 1000); }
function todayPrefix() {
  const d = istNow();
  return `${String(d.getUTCDate()).padStart(2,'0')}-${MONTHS[d.getUTCMonth()]}-${d.getUTCFullYear()}`;
}
function nowStr() {
  const d = istNow();
  return `${String(d.getUTCDate()).padStart(2,'0')}-${MONTHS[d.getUTCMonth()]}-${d.getUTCFullYear()} ${String(d.getUTCHours()).padStart(2,'0')}:${String(d.getUTCMinutes()).padStart(2,'0')}`;
}
function parseDateStr(str) {
  if (!str) return null;
  const M = {Jan:0,Feb:1,Mar:2,Apr:3,May:4,Jun:5,Jul:6,Aug:7,Sep:8,Oct:9,Nov:10,Dec:11};
  const parts = String(str).split(' ')[0].split('-');
  if (parts.length < 3) return null;
  const [dd, mon, yyyy] = parts;
  if (M[mon] === undefined) return null;
  return new Date(parseInt(yyyy), M[mon], parseInt(dd));
}

// Order number: SP-2607-0042 (restarts each month)
async function nextOrderNo(get) {
  const d = istNow();
  const yy = String(d.getUTCFullYear()).slice(-2);
  const mm = String(d.getUTCMonth() + 1).padStart(2, '0');
  const r = await get(
    `INSERT INTO counters(key,val) VALUES($1,1)
     ON CONFLICT(key) DO UPDATE SET val = counters.val + 1 RETURNING val`,
    [`order-${yy}${mm}`]);
  return `SP-${yy}${mm}-${String(r.val).padStart(4, '0')}`;
}

// Batch id, one per Generate run: B-2607-07
async function nextBatchId(get) {
  const d = istNow();
  const yy = String(d.getUTCFullYear()).slice(-2);
  const mm = String(d.getUTCMonth() + 1).padStart(2, '0');
  const r = await get(
    `INSERT INTO counters(key,val) VALUES($1,1)
     ON CONFLICT(key) DO UPDATE SET val = counters.val + 1 RETURNING val`,
    [`batch-${yy}${mm}`]);
  return `B-${yy}${mm}-${String(r.val).padStart(2, '0')}`;
}

// Item code carries the design in a short, human-glanceable slug plus a global
// running number, so codes are unique across all designs and never reused.
// SP-FLORAL12-000042
function slug(design) {
  return String(design).toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 8) || 'ITEM';
}
async function nextItemNumbers(get, count) {
  // Reserve `count` global item numbers in one atomic bump.
  const r = await get(
    `INSERT INTO counters(key,val) VALUES('item',$1)
     ON CONFLICT(key) DO UPDATE SET val = counters.val + $1 RETURNING val`,
    [count]);
  const end = parseInt(r.val);
  const start = end - count + 1;
  const nums = [];
  for (let n = start; n <= end; n++) nums.push(n);
  return nums;
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

app.use(express.json({ limit: '2mb' }));
app.use(express.urlencoded({ extended: true }));

// Sessions live in Postgres, not in memory, so people stay signed in across the
// host's sleep/wake cycles and redeploys. The store needs the pool, which only
// exists after initDB(), so a real Store subclass delegates to it once ready.
let pgStore = null;
class LazyStore extends session.Store {
  get(sid, cb)        { if (!pgStore) return cb(null, null); return pgStore.get(sid, cb); }
  set(sid, sess, cb)  { if (!pgStore) return cb(null);        return pgStore.set(sid, sess, cb); }
  destroy(sid, cb)    { if (!pgStore) return cb(null);        return pgStore.destroy(sid, cb); }
  touch(sid, sess, cb){ if (!pgStore || !pgStore.touch) return cb && cb(null); return pgStore.touch(sid, sess, cb); }
}
app.use(session({
  store: new LazyStore(),
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
const money = v => { const n = parseFloat(String(v).replace(/[^0-9.\-]/g, '')); return isNaN(n) ? 0 : n; };

/* ─────────────────── AUTH ─────────────────── */

app.post('/api/login', (req, res) => {
  const ip = req.ip || 'unknown';
  const lim = checkRate(ip);
  if (lim.blocked) return res.status(429).json({ error: `Too many attempts. Try again in ${lim.secs} seconds.` });
  if (req.body.password === (process.env.APP_PASSWORD || '')) {
    loginAttempts.delete(ip);
    req.session.authenticated = true;
    return res.json({ ok: true });
  }
  failLogin(ip);
  const r = loginAttempts.get(ip) || { count: 0 };
  res.status(401).json({ error: 'Wrong password', attemptsLeft: Math.max(0, 5 - r.count) });
});
app.post('/api/logout', (req, res) => { if (req.session) req.session.destroy(() => {}); res.json({ ok: true }); });
app.get('/api/me', (req, res) => { res.json({ authenticated: !!(req.session && req.session.authenticated) }); });

/* ═══════════════════ GENERATE QR: ITEMS ═══════════════════ */

// POST /api/items/generate  { design, rate, qty }
// Creates `qty` unique in-stock items and returns them, ready to print.
app.post('/api/items/generate', auth, wrap(async (req, res) => {
  const { get, run, all } = req.app.locals;
  const design = String(req.body.design || '').trim();
  const rate = money(req.body.rate);
  const qty = parseInt(req.body.qty);

  if (!design) return res.status(400).json({ error: 'Pick or type a design' });
  if (!qty || qty < 1) return res.status(400).json({ error: 'How many pieces? Enter a number of 1 or more' });
  if (qty > 500) return res.status(400).json({ error: 'Generate at most 500 at a time' });

  const batchId = await nextBatchId(get);
  const nums = await nextItemNumbers(get, qty);
  const createdAt = nowStr();
  const sl = slug(design);

  const codes = nums.map(n => `SP-${sl}-${String(n).padStart(6, '0')}`);

  // One multi-row insert keeps it fast even for a big batch.
  const values = [];
  const params = [];
  codes.forEach((code, i) => {
    const b = i * 5;
    values.push(`($${b+1},$${b+2},$${b+3},'in_stock',$${b+4},$${b+5})`);
    params.push(code, design, rate, batchId, createdAt);
  });
  await run(
    `INSERT INTO items(item_code,design,rate,status,batch_id,created_at) VALUES ${values.join(',')}`,
    params);

  await run(`INSERT INTO batches(batch_id,design,rate,qty,created_at) VALUES($1,$2,$3,$4,$5)`,
    [batchId, design, rate, qty, createdAt]);

  // Design joins the master list, and its default rate is refreshed.
  await run(
    `INSERT INTO designs(name,default_rate,sort_order) VALUES($1,$2,9999)
     ON CONFLICT(name) DO UPDATE SET default_rate=$2`, [design, rate]);

  const items = await all(`SELECT * FROM items WHERE batch_id=$1 ORDER BY id`, [batchId]);
  res.json({ ok: true, batchId, design, rate, qty, items });
}));

// GET /api/items  filters: status, design, search, limit
app.get('/api/items', auth, wrap(async (req, res) => {
  const { all } = req.app.locals;
  const { status, design, search, limit } = req.query;
  let sql = `SELECT * FROM items WHERE 1=1`;
  const p = []; let i = 1;
  if (status) { sql += ` AND status=$${i++}`; p.push(status); }
  if (design) { sql += ` AND design=$${i++}`; p.push(design); }
  if (search) { sql += ` AND (item_code ILIKE $${i} OR design ILIKE $${i+1})`; p.push(`%${search}%`, `%${search}%`); i += 2; }
  sql += ` ORDER BY id DESC`;
  if (limit) { sql += ` LIMIT $${i++}`; p.push(parseInt(limit)); }
  res.json({ items: await all(sql, p) });
}));

// GET /api/items/:code — look up one item (used by the label reprint)
app.get('/api/items/:code', auth, wrap(async (req, res) => {
  const item = await req.app.locals.get(`SELECT * FROM items WHERE item_code=$1`, [decodeURIComponent(req.params.code)]);
  if (!item) return res.status(404).json({ error: 'not_found' });
  res.json({ item });
}));

// GET /api/batches — recent print runs, so a sheet can be reprinted
app.get('/api/batches', auth, wrap(async (req, res) => {
  const rows = await req.app.locals.all(`SELECT * FROM batches ORDER BY id DESC LIMIT 40`);
  res.json({ batches: rows });
}));
app.get('/api/batches/:id/items', auth, wrap(async (req, res) => {
  const items = await req.app.locals.all(
    `SELECT * FROM items WHERE batch_id=$1 ORDER BY id`, [decodeURIComponent(req.params.id)]);
  res.json({ items });
}));

// DELETE /api/items/:code — remove a stray/mislabelled item (in_stock only, PIN)
app.delete('/api/items/:code', auth, wrap(async (req, res) => {
  const { get, run } = req.app.locals;
  if (req.body.pin !== ADMIN_PIN) return res.json({ ok: false, error: 'wrong_pin' });
  const code = decodeURIComponent(req.params.code);
  const it = await get(`SELECT status FROM items WHERE item_code=$1`, [code]);
  if (!it) return res.json({ ok: false, error: 'not_found' });
  if (it.status === 'sold') return res.json({ ok: false, error: 'sold' });
  await run(`DELETE FROM items WHERE item_code=$1`, [code]);
  res.json({ ok: true });
}));

/* ═══════════════════ COUNTER: SCAN A PIECE ═══════════════════ */

// POST /api/scan  { code }  — resolves a scanned item QR for the cart.
// The QR carries the whole /o/<code> URL or a bare code; both work.
app.post('/api/scan', auth, wrap(async (req, res) => {
  const { get } = req.app.locals;
  let code = String(req.body.code || '').trim();
  if (!code) return res.json({ status: 'empty' });
  if (/^https?:\/\//i.test(code)) {
    try { code = decodeURIComponent(new URL(code).pathname.split('/').filter(Boolean).pop() || ''); } catch (e) {}
  }
  code = code.replace(/^\/+|\/+$/g, '');

  // A scanned order number (from an old bill) resolves to that order, not an item.
  if (/^SP-\d{4}-\d{4}$/i.test(code)) {
    const order = await get(`SELECT order_no FROM orders WHERE UPPER(order_no)=UPPER($1)`, [code]);
    if (order) return res.json({ status: 'order', orderNo: order.order_no });
  }

  const item = await get(`SELECT * FROM items WHERE UPPER(item_code)=UPPER($1)`, [code]);
  if (!item) return res.json({ status: 'not_found', code });
  if (item.status === 'sold')      return res.json({ status: 'sold', item });
  if (item.status === 'cancelled') return res.json({ status: 'cancelled', item });
  res.json({ status: 'ok', item });
}));

/* ═══════════════════ ORDERS (built from items) ═══════════════════ */

// POST /api/orders  { itemCodes:[], party:{}, discount, remarks }
// Marks the items sold and writes one order. All-or-nothing in a transaction.
app.post('/api/orders', auth, wrap(async (req, res) => {
  const pool = req.app.locals.pool;
  const codes = Array.isArray(req.body.itemCodes) ? req.body.itemCodes.map(c => String(c).trim()).filter(Boolean) : [];
  const p = req.body.party || {};
  const discount = money(req.body.discount);
  const remarks = String(req.body.remarks || '').trim();

  if (!codes.length) return res.status(400).json({ error: 'Scan at least one item before billing' });

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Lock the rows so two counters cannot sell the same piece.
    const { rows: items } = await client.query(
      `SELECT * FROM items WHERE item_code = ANY($1) FOR UPDATE`, [codes]);

    const found = new Map(items.map(it => [it.item_code, it]));
    const missing = codes.filter(c => !found.has(c));
    const alreadySold = items.filter(it => it.status === 'sold').map(it => it.item_code);
    if (missing.length)     { await client.query('ROLLBACK'); return res.status(409).json({ error: 'Some items were not found', codes: missing }); }
    if (alreadySold.length) { await client.query('ROLLBACK'); return res.status(409).json({ error: 'Some items are already sold', codes: alreadySold }); }

    const orderNo = await nextOrderNo(async (sql, prm) => (await client.query(sql, prm)).rows[0]);
    const createdAt = nowStr();

    // Keep the caller's scan order.
    const ordered = codes.map(c => found.get(c));
    const total = ordered.reduce((s, it) => s + money(it.rate), 0);
    const net = Math.max(0, total - discount);

    await client.query(
      `INSERT INTO orders(order_no,party_name,party_address,contact_person,mobile,gst_no,transport,
        agent_name,agent_address,piece_count,total_amount,discount,net_amount,remarks,status,created_at,updated_at)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,'Billed',$15,$15)`,
      [orderNo, String(p.partyName||'').trim(), String(p.address||'').trim(), String(p.contactPerson||'').trim(),
       String(p.mobile||'').trim(), String(p.gstNo||'').trim().toUpperCase(), String(p.transport||'').trim(),
       String(p.agentName||'').trim(), String(p.agentAddress||'').trim(),
       ordered.length, total, discount, net, remarks, createdAt]);

    for (let i = 0; i < ordered.length; i++) {
      const it = ordered[i];
      await client.query(
        `INSERT INTO order_lines(order_no,item_code,design,rate,line_no) VALUES($1,$2,$3,$4,$5)`,
        [orderNo, it.item_code, it.design, it.rate, i + 1]);
      await client.query(
        `UPDATE items SET status='sold', order_no=$1, sold_at=$2 WHERE item_code=$3`,
        [orderNo, createdAt, it.item_code]);
    }

    await client.query(`INSERT INTO status_log(order_no,status,note,at) VALUES($1,'Billed','Order billed',$2)`, [orderNo, createdAt]);

    // Remember the party for next time (only if named).
    if (String(p.partyName || '').trim()) {
      await client.query(
        `INSERT INTO parties(name,address,contact_person,mobile,gst_no,transport,agent_name,agent_address)
         VALUES($1,$2,$3,$4,$5,$6,$7,$8)
         ON CONFLICT(name) DO UPDATE SET address=$2,contact_person=$3,mobile=$4,gst_no=$5,transport=$6,agent_name=$7,agent_address=$8`,
        [String(p.partyName).trim(), String(p.address||'').trim(), String(p.contactPerson||'').trim(),
         String(p.mobile||'').trim(), String(p.gstNo||'').trim().toUpperCase(), String(p.transport||'').trim(),
         String(p.agentName||'').trim(), String(p.agentAddress||'').trim()]);
    }
    if (String(p.agentName || '').trim()) {
      await client.query(`INSERT INTO agents(name,address) VALUES($1,$2) ON CONFLICT(name) DO UPDATE SET address=$2`,
        [String(p.agentName).trim(), String(p.agentAddress||'').trim()]);
    }

    await client.query('COMMIT');
    res.json({ ok: true, orderNo });
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}));

// POST /api/orders/manual  — a TYPED order docket. No pieces are scanned and no
// inventory moves. This is the fallback for when scanning is not possible (a
// phone order, or the scanner is down) and you still need to print an order.
// Body: { party:{...}, lines:[{design,qty,rate,remarks}], masterQty, remarks }
app.post('/api/orders/manual', auth, wrap(async (req, res) => {
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
    .filter(l => l.design);           // a line counts only if it has a design
  const masterQty = String(req.body.masterQty || '').trim();
  const remarks   = String(req.body.remarks || '').trim();

  if (!String(p.partyName || '').trim()) return res.status(400).json({ error: 'Enter the party name' });
  if (!String(p.mobile || '').trim())    return res.status(400).json({ error: 'Enter a mobile number' });
  if (!lines.length)                     return res.status(400).json({ error: 'Add at least one design line' });

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const orderNo = await nextOrderNo(async (sql, prm) => (await client.query(sql, prm)).rows[0]);
    const createdAt = nowStr();

    await client.query(
      `INSERT INTO orders(order_no,party_name,party_address,contact_person,mobile,gst_no,transport,
        agent_name,agent_address,piece_count,total_amount,discount,net_amount,remarks,order_type,master_qty,status,created_at,updated_at)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,0,0,0,$11,'manual',$12,'Booked',$13,$13)`,
      [orderNo, String(p.partyName||'').trim(), String(p.address||'').trim(), String(p.contactPerson||'').trim(),
       String(p.mobile||'').trim(), String(p.gstNo||'').trim().toUpperCase(), String(p.transport||'').trim(),
       String(p.agentName||'').trim(), String(p.agentAddress||'').trim(),
       lines.length, remarks, masterQty, createdAt]);

    for (let i = 0; i < lines.length; i++) {
      const l = lines[i];
      await client.query(
        `INSERT INTO order_lines(order_no,item_code,design,rate,qty,remarks,line_no) VALUES($1,'',$2,$3,$4,$5,$6)`,
        [orderNo, l.design, l.rate, l.qty, l.remarks, i + 1]);
    }

    await client.query(`INSERT INTO status_log(order_no,status,note,at) VALUES($1,'Booked','Typed order',$2)`, [orderNo, createdAt]);

    // Remember the party and agent, same as a scanned order.
    if (String(p.partyName || '').trim()) {
      await client.query(
        `INSERT INTO parties(name,address,contact_person,mobile,gst_no,transport,agent_name,agent_address)
         VALUES($1,$2,$3,$4,$5,$6,$7,$8)
         ON CONFLICT(name) DO UPDATE SET address=$2,contact_person=$3,mobile=$4,gst_no=$5,transport=$6,agent_name=$7,agent_address=$8`,
        [String(p.partyName).trim(), String(p.address||'').trim(), String(p.contactPerson||'').trim(),
         String(p.mobile||'').trim(), String(p.gstNo||'').trim().toUpperCase(), String(p.transport||'').trim(),
         String(p.agentName||'').trim(), String(p.agentAddress||'').trim()]);
    }
    if (String(p.agentName || '').trim()) {
      await client.query(`INSERT INTO agents(name,address) VALUES($1,$2) ON CONFLICT(name) DO UPDATE SET address=$2`,
        [String(p.agentName).trim(), String(p.agentAddress||'').trim()]);
    }
    // Remember any new designs typed in.
    for (const l of lines) {
      await client.query(`INSERT INTO designs(name) VALUES($1) ON CONFLICT(name) DO NOTHING`, [l.design]);
    }

    await client.query('COMMIT');
    res.json({ ok: true, orderNo });
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}));
app.get('/api/orders', auth, wrap(async (req, res) => {
  const { all } = req.app.locals;
  const { status, party, search, date, limit } = req.query;
  let sql = `SELECT * FROM orders WHERE 1=1`;
  const p = []; let i = 1;
  if (date)   { sql += ` AND created_at LIKE $${i++}`; p.push(date + '%'); }
  if (status) { sql += ` AND status=$${i++}`; p.push(status); }
  if (party)  { sql += ` AND party_name=$${i++}`; p.push(party); }
  if (search) {
    sql += ` AND (order_no ILIKE $${i} OR party_name ILIKE $${i+1} OR mobile ILIKE $${i+2}
             OR EXISTS(SELECT 1 FROM order_lines ol WHERE ol.order_no=orders.order_no
                       AND (ol.item_code ILIKE $${i+3} OR ol.design ILIKE $${i+4})))`;
    const q = `%${search}%`; p.push(q, q, q, q, q); i += 5;
  }
  sql += ` ORDER BY id DESC`;
  if (limit) { sql += ` LIMIT $${i++}`; p.push(parseInt(limit)); }
  res.json({ orders: await all(sql, p) });
}));

// GET /api/orders/:orderNo — full bill for the detail screen
app.get('/api/orders/:orderNo', auth, wrap(async (req, res) => {
  const { get, all } = req.app.locals;
  const orderNo = decodeURIComponent(req.params.orderNo);
  const order = await get(`SELECT * FROM orders WHERE order_no=$1`, [orderNo]);
  if (!order) return res.status(404).json({ error: 'not_found' });
  const lines = await all(`SELECT * FROM order_lines WHERE order_no=$1 ORDER BY line_no,id`, [orderNo]);
  const log   = await all(`SELECT * FROM status_log WHERE order_no=$1 ORDER BY id DESC`, [orderNo]);
  res.json({ order, lines, log });
}));

// POST /api/orders/:orderNo/cancel  { pin, reason }
// Cancels a bill and returns its pieces to stock.
app.post('/api/orders/:orderNo/cancel', auth, wrap(async (req, res) => {
  const pool = req.app.locals.pool;
  const orderNo = decodeURIComponent(req.params.orderNo);
  if (req.body.pin !== ADMIN_PIN) return res.json({ ok: false, error: 'wrong_pin' });

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query(`SELECT * FROM orders WHERE order_no=$1 FOR UPDATE`, [orderNo]);
    const order = rows[0];
    if (!order) { await client.query('ROLLBACK'); return res.json({ ok: false, error: 'not_found' }); }
    if (order.status === 'Cancelled') { await client.query('ROLLBACK'); return res.json({ ok: false, error: 'already_cancelled' }); }

    const at = nowStr();
    await client.query(`UPDATE orders SET status='Cancelled',cancelled_at=$1,cancel_reason=$2,updated_at=$1 WHERE order_no=$3`,
      [at, String(req.body.reason || '').trim(), orderNo]);
    // Pieces go back to stock so they can be sold again.
    await client.query(`UPDATE items SET status='in_stock',order_no='',sold_at='' WHERE order_no=$1`, [orderNo]);
    await client.query(`INSERT INTO status_log(order_no,status,note,at) VALUES($1,'Cancelled',$2,$3)`,
      [orderNo, String(req.body.reason || '').trim(), at]);
    await client.query('COMMIT');
    res.json({ ok: true });
  } catch (e) { await client.query('ROLLBACK'); throw e; }
  finally { client.release(); }
}));

/* ═══════════════════ DESIGN MASTER ═══════════════════ */

app.get('/api/designs', auth, wrap(async (req, res) => {
  const rows = await req.app.locals.all(`SELECT name, default_rate FROM designs ORDER BY sort_order, name`);
  res.json({ designs: rows });
}));
app.post('/api/designs', auth, wrap(async (req, res) => {
  const { get, run } = req.app.locals;
  const name = String(req.body.name || '').trim();
  const rate = money(req.body.rate);
  if (!name) return res.status(400).json({ error: 'Design name is required' });
  try {
    const m = await get(`SELECT MAX(sort_order) AS m FROM designs`);
    const order = (m && m.m !== null) ? parseInt(m.m) : 0;
    await run(`INSERT INTO designs(name,default_rate,sort_order) VALUES($1,$2,$3)`, [name, rate, order + 1]);
    res.json({ ok: true });
  } catch (e) {
    if (e.code === '23505') return res.status(409).json({ error: 'That design is already on the list' });
    throw e;
  }
}));
app.post('/api/designs/rate', auth, wrap(async (req, res) => {
  await req.app.locals.run(`UPDATE designs SET default_rate=$1 WHERE name=$2`,
    [money(req.body.rate), String(req.body.name || '').trim()]);
  res.json({ ok: true });
}));
app.delete('/api/designs/:name', auth, wrap(async (req, res) => {
  await req.app.locals.run(`DELETE FROM designs WHERE name=$1`, [decodeURIComponent(req.params.name)]);
  res.json({ ok: true });
}));

/* ═══════════════════ PARTY / AGENT MASTER ═══════════════════ */

app.get('/api/parties', auth, wrap(async (req, res) => {
  res.json({ parties: await req.app.locals.all(`SELECT * FROM parties ORDER BY name`) });
}));
app.post('/api/parties', auth, wrap(async (req, res) => {
  const b = req.body; const name = String(b.name || '').trim();
  if (!name) return res.status(400).json({ error: 'Party name is required' });
  await req.app.locals.run(
    `INSERT INTO parties(name,address,contact_person,mobile,gst_no,transport,agent_name,agent_address)
     VALUES($1,$2,$3,$4,$5,$6,$7,$8)
     ON CONFLICT(name) DO UPDATE SET address=$2,contact_person=$3,mobile=$4,gst_no=$5,transport=$6,agent_name=$7,agent_address=$8`,
    [name, String(b.address||'').trim(), String(b.contactPerson||'').trim(), String(b.mobile||'').trim(),
     String(b.gstNo||'').trim().toUpperCase(), String(b.transport||'').trim(), String(b.agentName||'').trim(), String(b.agentAddress||'').trim()]);
  res.json({ ok: true });
}));
app.delete('/api/parties/:name', auth, wrap(async (req, res) => {
  await req.app.locals.run(`DELETE FROM parties WHERE name=$1`, [decodeURIComponent(req.params.name)]);
  res.json({ ok: true });
}));
app.get('/api/agents', auth, wrap(async (req, res) => {
  res.json({ agents: await req.app.locals.all(`SELECT * FROM agents ORDER BY name`) });
}));
app.post('/api/agents', auth, wrap(async (req, res) => {
  const name = String(req.body.name || '').trim();
  if (!name) return res.status(400).json({ error: 'Agent name is required' });
  await req.app.locals.run(`INSERT INTO agents(name,address) VALUES($1,$2) ON CONFLICT(name) DO UPDATE SET address=$2`,
    [name, String(req.body.address || '').trim()]);
  res.json({ ok: true });
}));
app.delete('/api/agents/:name', auth, wrap(async (req, res) => {
  await req.app.locals.run(`DELETE FROM agents WHERE name=$1`, [decodeURIComponent(req.params.name)]);
  res.json({ ok: true });
}));

/* ═══════════════════ STATS ═══════════════════ */

app.get('/api/stats', auth, wrap(async (req, res) => {
  const { get } = req.app.locals;
  const prefix = todayPrefix();
  const c = async (sql, p = []) => parseInt((await get(sql, p)).c);
  const n = async (sql, p = []) => money((await get(sql, p)).s);

  const inStock     = await c(`SELECT COUNT(*) AS c FROM items WHERE status='in_stock'`);
  const soldToday   = await c(`SELECT COUNT(*) AS c FROM items WHERE status='sold' AND sold_at LIKE $1`, [prefix + '%']);
  const ordersToday = await c(`SELECT COUNT(*) AS c FROM orders WHERE status='Billed' AND created_at LIKE $1`, [prefix + '%']);
  const salesToday  = await n(`SELECT COALESCE(SUM(net_amount),0) AS s FROM orders WHERE status='Billed' AND created_at LIKE $1`, [prefix + '%']);

  res.json({ inStock, soldToday, ordersToday, salesToday });
}));

/* ═══════════════════ REPORT ═══════════════════ */

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
    if (toDate && d > toDate) return false;
    return true;
  });
  const billed = orders.filter(o => o.status === 'Billed');
  const nos = billed.map(o => o.order_no);
  let lines = [];
  if (nos.length) lines = await all(`SELECT * FROM order_lines WHERE order_no = ANY($1)`, [nos]);

  const dMap = {};
  lines.forEach(l => {
    if (!dMap[l.design]) dMap[l.design] = { design: l.design, pieces: 0, amount: 0 };
    dMap[l.design].pieces++; dMap[l.design].amount += money(l.rate);
  });
  const byDesign = Object.values(dMap).sort((a, b) => b.amount - a.amount);

  const pMap = {};
  billed.forEach(o => {
    const key = o.party_name || '(walk-in, no name)';
    if (!pMap[key]) pMap[key] = { party: key, orders: 0, pieces: 0, amount: 0 };
    pMap[key].orders++; pMap[key].pieces += o.piece_count; pMap[key].amount += money(o.net_amount);
  });
  const byParty = Object.values(pMap).sort((a, b) => b.amount - a.amount);

  res.json({
    orders,
    billedCount: billed.length,
    cancelledCount: orders.filter(o => o.status === 'Cancelled').length,
    pieces: billed.reduce((s, o) => s + o.piece_count, 0),
    sales: billed.reduce((s, o) => s + money(o.net_amount), 0),
    byDesign, byParty
  });
}));

/* ═══════════════════ SETTINGS / PIN ═══════════════════ */

app.get('/api/settings', auth, wrap(async (req, res) => {
  const rows = await req.app.locals.all(`SELECT key,value FROM settings`);
  const flat = {}; rows.forEach(r => flat[r.key] = r.value);
  res.json(flat);
}));
app.post('/api/settings', auth, wrap(async (req, res) => {
  if (!req.body.key) return res.status(400).json({ error: 'Missing key' });
  await req.app.locals.run(`INSERT INTO settings(key,value) VALUES($1,$2) ON CONFLICT(key) DO UPDATE SET value=$2`,
    [req.body.key, req.body.value || '']);
  res.json({ ok: true });
}));
app.post('/api/verify-pin', auth, (req, res) => {
  if (req.body.pin === CHANGE_PIN) return res.json({ ok: true });
  res.status(401).json({ ok: false, error: 'Wrong PIN' });
});

/* ═══════════════════ GOOGLE SHEETS BACKUP ═══════════════════ */

async function getSheets() {
  const { google } = require('googleapis');
  const clientEmail = process.env.GOOGLE_CLIENT_EMAIL;
  const privateKey  = (process.env.GOOGLE_PRIVATE_KEY || '').replace(/\\n/g, '\n');
  const sheetId     = process.env.GOOGLE_SHEET_ID;
  if (!clientEmail || !privateKey || !sheetId) return null;
  const authj = new google.auth.JWT(clientEmail, null, privateKey, ['https://www.googleapis.com/auth/spreadsheets']);
  return { sheets: google.sheets({ version: 'v4', auth: authj }), sheetId };
}

async function runBackup() {
  const client = await getSheets();
  if (!client) { console.log('[Backup] Google Sheets not configured, skipping.'); return; }
  const { sheets, sheetId } = client;
  const { all } = global.dbHelpers;

  const d = new Date(); d.setDate(d.getDate() - 1);
  const pfx = `${String(d.getDate()).padStart(2,'0')}-${MONTHS[d.getMonth()]}-${d.getFullYear()}`;

  try {
    const orders = await all(`SELECT * FROM orders WHERE created_at LIKE $1 ORDER BY id`, [pfx + '%']);
    if (!orders.length) { console.log(`[Backup] No orders for ${pfx}`); return; }
    const nos = orders.map(o => o.order_no);
    const lines = await all(`SELECT * FROM order_lines WHERE order_no = ANY($1) ORDER BY order_no,line_no`, [nos]);
    const byOrder = {}; lines.forEach(l => (byOrder[l.order_no] = byOrder[l.order_no] || []).push(l));

    const meta = await sheets.spreadsheets.get({ spreadsheetId: sheetId });
    if (!meta.data.sheets.map(s => s.properties.title).includes(pfx)) {
      await sheets.spreadsheets.batchUpdate({ spreadsheetId: sheetId, requestBody: { requests: [{ addSheet: { properties: { title: pfx } } }] } });
    }

    const header = ['Order No','Date','Party','Mobile','GST','Item Code','Design','Rate','Pieces','Total','Discount','Net','Status'];
    const rows = [];
    orders.forEach(o => {
      const ls = byOrder[o.order_no] || [{ item_code: '', design: '', rate: '' }];
      ls.forEach((l, idx) => rows.push([
        idx === 0 ? o.order_no : '', idx === 0 ? o.created_at : '',
        idx === 0 ? o.party_name : '', idx === 0 ? o.mobile : '', idx === 0 ? o.gst_no : '',
        l.item_code, l.design, l.rate,
        idx === 0 ? o.piece_count : '', idx === 0 ? o.total_amount : '',
        idx === 0 ? o.discount : '', idx === 0 ? o.net_amount : '', idx === 0 ? o.status : ''
      ]));
    });
    const summary = [
      [`Summary — ${pfx}`],
      ['Orders billed', orders.filter(o => o.status === 'Billed').length],
      ['Cancelled', orders.filter(o => o.status === 'Cancelled').length],
      ['Net sales', orders.filter(o => o.status === 'Billed').reduce((s, o) => s + money(o.net_amount), 0)],
      [], header, ...rows
    ];
    await sheets.spreadsheets.values.update({ spreadsheetId: sheetId, range: `${pfx}!A1`, valueInputOption: 'RAW', requestBody: { values: summary } });
    console.log(`[Backup] ${orders.length} orders backed up for ${pfx}`);
  } catch (err) { console.error('[Backup] Error:', err.message); }
}

app.post('/api/backup/trigger', auth, async (req, res) => {
  try { await runBackup(); res.json({ ok: true, message: 'Backup finished. Check the Google Sheet.' }); }
  catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

function scheduleNightlyBackup() {
  function msUntil() {
    const now = new Date(); const next = new Date();
    next.setUTCHours(18, 30, 0, 0);
    if (next <= now) next.setUTCDate(next.getUTCDate() + 1);
    return next - now;
  }
  function loop() { runBackup(); setTimeout(loop, msUntil()); }
  setTimeout(loop, msUntil());
  console.log(`[Backup] Nightly backup set for midnight IST. Next in ${Math.round(msUntil()/60000)} min.`);
}

/* ═══════════════════ CATCH-ALL ═══════════════════ */
// /o/<code> is what item QR codes and bill QR codes point at. Serves the app,
// which reads the path and either loads the order or drops the item in the cart.
app.get('*', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

/* ═══════════════════ START ═══════════════════ */

initDB().then((pool) => {
  pgStore = makePgStore(pool);
  app.listen(PORT, () => {
    console.log(`Sushant Order System on port ${PORT}`);
    scheduleNightlyBackup();
  });
}).catch(err => {
  console.error('DB init failed:', err);
  process.exit(1);
});
