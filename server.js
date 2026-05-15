// Only load .env file in development — never override Railway's injected vars
if (!process.env.RAILWAY_ENVIRONMENT) {
  require('dotenv').config();
}

const ANTHROPIC_KEY  = process.env.ANTHROPIC_API_KEY || process.env.CLAUDE_KEY || process.env.AI_KEY || process.env.APP_TOKEN || '';
const GROQ_KEY       = process.env.GROQ_API_KEY || process.env.GROQ_KEY || process.env.SPEECH_TOKEN || '';
const DB_URL         = process.env.DATABASE_URL || process.env.DB_URL || process.env.POSTGRES_URL || process.env.APP_DB || '';
const ENCRYPT_KEY    = process.env.FIELD_ENCRYPT_KEY || process.env.ENC_KEY || 'default-dev-key-change-in-prod-!!';
const SESSION_SECRET = process.env.SESSION_SECRET || process.env.APP_SECRET || 'clearshift-session-secret-change-me';
const RETENTION_DAYS = parseInt(process.env.RETENTION_DAYS || '1825');
const SESSION_TIMEOUT_MINS = parseInt(process.env.SESSION_TIMEOUT_MINS || '60');

console.log('ENV CHECK:',
  'ANTHROPIC=', ANTHROPIC_KEY ? 'SET(' + ANTHROPIC_KEY.slice(0,8) + '...)' : 'MISSING',
  'GROQ=', GROQ_KEY ? 'SET' : 'MISSING',
  'DB=', DB_URL ? 'SET' : 'MISSING'
);

const express    = require('express');
const multer     = require('multer');
const fetch      = require('node-fetch');
const FormData   = require('form-data');
const cors       = require('cors');
const path       = require('path');
const crypto     = require('crypto');
const bcrypt     = require('bcryptjs');
const session    = require('express-session');
const { Pool }   = require('pg');

const app    = express();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 25 * 1024 * 1024 } });

app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));

// ── Session setup ─────────────────────────────────────────────
app.set('trust proxy', 1);
app.use(session({
  secret: SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  cookie: {
    httpOnly: true,
    secure: false,
    maxAge: SESSION_TIMEOUT_MINS * 60 * 1000,
    sameSite: 'lax'
  }
}));

// Serve login page before static files
app.use((req, res, next) => {
  // Allow login routes through
  if (req.path === '/login' || req.path === '/api/auth/login' || req.path === '/api/auth/logout') return next();
  // Allow API auth check through
  if (req.path === '/api/auth/me') return next();
  // Protect everything else
  if (!req.session?.user) {
    if (req.path.startsWith('/api/')) {
      return res.status(401).json({ error: 'Not authenticated', redirect: '/login' });
    }
    return res.redirect('/login');
  }
  next();
});

app.use(express.static(path.join(__dirname, 'public')));

// ── Encryption helpers (AES-256-GCM) ─────────────────────────
const ENC_ALGO = 'aes-256-gcm';
const ENC_KEY  = crypto.scryptSync(ENCRYPT_KEY, 'clearshift-salt', 32);

function encrypt(text) {
  const iv     = crypto.randomBytes(16);
  const cipher = crypto.createCipheriv(ENC_ALGO, ENC_KEY, iv);
  const enc    = Buffer.concat([cipher.update(text, 'utf8'), cipher.final()]);
  const tag    = cipher.getAuthTag();
  return iv.toString('hex') + ':' + tag.toString('hex') + ':' + enc.toString('hex');
}

function decrypt(data) {
  try {
    const [ivHex, tagHex, encHex] = data.split(':');
    const iv       = Buffer.from(ivHex, 'hex');
    const tag      = Buffer.from(tagHex, 'hex');
    const enc      = Buffer.from(encHex, 'hex');
    const decipher = crypto.createDecipheriv(ENC_ALGO, ENC_KEY, iv);
    decipher.setAuthTag(tag);
    return decipher.update(enc) + decipher.final('utf8');
  } catch(e) {
    return data;
  }
}

// ── Role middleware ───────────────────────────────────────────
function requireRole(...roles) {
  return (req, res, next) => {
    if (!req.session?.user) return res.status(401).json({ error: 'Not authenticated' });
    if (roles.length && !roles.includes(req.session.user.role)) {
      return res.status(403).json({ error: 'Insufficient permissions' });
    }
    next();
  };
}

// ── Database setup ────────────────────────────────────────────
const pool = new Pool({
  connectionString: DB_URL,
  ssl: DB_URL ? { rejectUnauthorized: false } : false
});

// Prevent unhandled pool errors from crashing the process
pool.on('error', (err) => {
  console.error('Unexpected DB pool error:', err.message);
});

async function initDB() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id           SERIAL PRIMARY KEY,
      username     TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      role         TEXT NOT NULL DEFAULT 'reviewer' CHECK (role IN ('admin','reviewer')),
      created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      last_login   TIMESTAMPTZ,
      active       BOOLEAN NOT NULL DEFAULT TRUE
    );

    CREATE TABLE IF NOT EXISTS applicants (
      id                   SERIAL PRIMARY KEY,
      name                 TEXT NOT NULL,
      created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      fields               TEXT NOT NULL DEFAULT '{}',
      flagged_for_deletion BOOLEAN NOT NULL DEFAULT FALSE,
      deletion_flagged_at  TIMESTAMPTZ
    );
    CREATE INDEX IF NOT EXISTS idx_applicants_name ON applicants(name);

    CREATE TABLE IF NOT EXISTS access_log (
      id           SERIAL PRIMARY KEY,
      applicant_id INTEGER REFERENCES applicants(id) ON DELETE CASCADE,
      action       TEXT NOT NULL,
      username     TEXT,
      ip           TEXT,
      user_agent   TEXT,
      created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_access_log_applicant ON access_log(applicant_id);

    CREATE TABLE IF NOT EXISTS audit_trail (
      id           SERIAL PRIMARY KEY,
      applicant_id INTEGER REFERENCES applicants(id) ON DELETE CASCADE,
      field_id     TEXT NOT NULL,
      old_value    TEXT,
      new_value    TEXT,
      changed_by   TEXT DEFAULT 'user',
      created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_audit_trail_applicant ON audit_trail(applicant_id);
  `);

  // Safe migrations
  await pool.query(`
    ALTER TABLE applicants ADD COLUMN IF NOT EXISTS flagged_for_deletion BOOLEAN NOT NULL DEFAULT FALSE;
    ALTER TABLE applicants ADD COLUMN IF NOT EXISTS deletion_flagged_at TIMESTAMPTZ;
    ALTER TABLE access_log ADD COLUMN IF NOT EXISTS username TEXT;
  `).catch(() => {});

  // Create default admin if no users exist
  const { rows } = await pool.query(`SELECT COUNT(*) FROM users`);
  if (parseInt(rows[0].count) === 0) {
    const defaultPass = process.env.ADMIN_PASSWORD || process.env.DEFAULT_ADMIN_PASS || 'ChangeMe123!';
    const hash = await bcrypt.hash(defaultPass, 12);
    await pool.query(
      `INSERT INTO users (username, password_hash, role) VALUES ($1, $2, 'admin')`,
      ['admin', hash]
    );
    console.log('Created default admin user. Username: admin — CHANGE THE PASSWORD IMMEDIATELY.');
  }

  console.log('Database ready');
}

initDB().catch(err => console.error('DB init error:', err));

// ── Auth routes ───────────────────────────────────────────────
app.get('/login', (req, res) => {
  if (req.session?.user) return res.redirect('/');
  res.sendFile(path.join(__dirname, 'public', 'login.html'));
});

app.post('/api/auth/login', async (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) return res.status(400).json({ error: 'Username and password required' });

  try {
    const result = await pool.query(
      `SELECT * FROM users WHERE username = $1 AND active = TRUE`, [username]
    );
    const user = result.rows[0];
    if (!user) return res.status(401).json({ error: 'Invalid username or password' });

    const valid = await bcrypt.compare(password, user.password_hash);
    if (!valid) return res.status(401).json({ error: 'Invalid username or password' });

    await pool.query(`UPDATE users SET last_login = NOW() WHERE id = $1`, [user.id]);

    req.session.user = { id: user.id, username: user.username, role: user.role };
    res.json({ success: true, username: user.username, role: user.role });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/auth/logout', (req, res) => {
  req.session.destroy();
  res.json({ success: true });
});

app.get('/api/auth/me', (req, res) => {
  if (!req.session?.user) return res.status(401).json({ error: 'Not authenticated' });
  res.json(req.session.user);
});

// ── User management (admin only) ──────────────────────────────
app.get('/api/users', requireRole('admin'), async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT id, username, role, created_at, last_login, active FROM users ORDER BY created_at`
    );
    res.json(result.rows);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/users', requireRole('admin'), async (req, res) => {
  const { username, password, role } = req.body;
  if (!username || !password) return res.status(400).json({ error: 'Username and password required' });
  if (!['admin', 'reviewer'].includes(role)) return res.status(400).json({ error: 'Role must be admin or reviewer' });
  try {
    const hash = await bcrypt.hash(password, 12);
    const result = await pool.query(
      `INSERT INTO users (username, password_hash, role) VALUES ($1, $2, $3) RETURNING id, username, role, created_at`,
      [username, hash, role]
    );
    res.json(result.rows[0]);
  } catch(e) {
    if (e.code === '23505') return res.status(409).json({ error: 'Username already exists' });
    res.status(500).json({ error: e.message });
  }
});

app.put('/api/users/:id', requireRole('admin'), async (req, res) => {
  const { role, active, password } = req.body;
  try {
    if (password) {
      const hash = await bcrypt.hash(password, 12);
      await pool.query(`UPDATE users SET password_hash = $1 WHERE id = $2`, [hash, req.params.id]);
    }
    if (role) await pool.query(`UPDATE users SET role = $1 WHERE id = $2`, [role, req.params.id]);
    if (active !== undefined) await pool.query(`UPDATE users SET active = $1 WHERE id = $2`, [active, req.params.id]);
    const result = await pool.query(
      `SELECT id, username, role, created_at, last_login, active FROM users WHERE id = $1`, [req.params.id]
    );
    res.json(result.rows[0]);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/users/:id', requireRole('admin'), async (req, res) => {
  if (parseInt(req.params.id) === req.session.user.id) {
    return res.status(400).json({ error: 'Cannot delete your own account' });
  }
  try {
    await pool.query(`DELETE FROM users WHERE id = $1`, [req.params.id]);
    res.json({ deleted: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── Logging helpers ───────────────────────────────────────────
async function logAccess(applicantId, action, req) {
  try {
    await pool.query(
      `INSERT INTO access_log (applicant_id, action, username, ip, user_agent) VALUES ($1, $2, $3, $4, $5)`,
      [applicantId, action, req.session?.user?.username || 'unknown',
       req.ip || req.headers['x-forwarded-for'] || 'unknown',
       req.headers['user-agent']?.slice(0, 200) || 'unknown']
    );
  } catch(e) { console.error('Access log error:', e.message); }
}

async function logAudit(applicantId, fieldId, oldVal, newVal, username) {
  try {
    await pool.query(
      `INSERT INTO audit_trail (applicant_id, field_id, old_value, new_value, changed_by) VALUES ($1, $2, $3, $4, $5)`,
      [applicantId, fieldId, oldVal ? String(oldVal).slice(0, 500) : null, newVal ? String(newVal).slice(0, 500) : null, username || 'user']
    );
  } catch(e) { console.error('Audit log error:', e.message); }
}

// ── Encrypt/decrypt applicant fields ─────────────────────────
function encryptFields(fields) {
  const enc = {};
  for (const [k, v] of Object.entries(fields || {})) {
    try { enc[k] = { ...v, value: encrypt(String(v.value || '')) }; }
    catch(e) { enc[k] = v; }
  }
  return enc;
}

function decryptFields(fields) {
  const dec = {};
  for (const [k, v] of Object.entries(fields || {})) {
    try { dec[k] = { ...v, value: decrypt(String(v.value || '')) }; }
    catch(e) { dec[k] = v; }
  }
  return dec;
}

// ── /api/applicants/search ────────────────────────────────────
app.get('/api/applicants/search', requireRole('admin', 'reviewer'), async (req, res) => {
  const q = (req.query.q || '').trim();
  try {
    let result;
    if (!q) {
      result = await pool.query(
        `SELECT id, name, updated_at, flagged_for_deletion, deletion_flagged_at
         FROM applicants ORDER BY updated_at DESC LIMIT 20`
      );
    } else {
      result = await pool.query(
        `SELECT id, name, updated_at, flagged_for_deletion, deletion_flagged_at
         FROM applicants WHERE name ILIKE $1 ORDER BY updated_at DESC LIMIT 20`,
        [`%${q}%`]
      );
    }
    res.json(result.rows);
  } catch(e) {
    console.error('Search error:', e);
    res.status(500).json({ error: e.message });
  }
});

// ── /api/applicants/:id ───────────────────────────────────────
app.get('/api/applicants/:id', requireRole('admin', 'reviewer'), async (req, res) => {
  try {
    const result = await pool.query(`SELECT * FROM applicants WHERE id = $1`, [req.params.id]);
    if (!result.rows.length) return res.status(404).json({ error: 'Applicant not found' });
    const row = result.rows[0];
    let fields = {};
    try { fields = decryptFields(JSON.parse(row.fields)); } catch(e) { fields = {}; }
    await logAccess(req.params.id, 'VIEW', req);
    res.json({ ...row, fields });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// ── /api/applicants (create) ──────────────────────────────────
app.post('/api/applicants', requireRole('admin', 'reviewer'), async (req, res) => {
  const { name, fields } = req.body;
  if (!name) return res.status(400).json({ error: 'Name is required' });
  try {
    const encFields = encryptFields(fields || {});
    const result = await pool.query(
      `INSERT INTO applicants (name, fields) VALUES ($1, $2) RETURNING *`,
      [name, JSON.stringify(encFields)]
    );
    const row = result.rows[0];
    await logAccess(row.id, 'CREATE', req);
    res.json({ ...row, fields: fields || {} });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// ── /api/applicants/:id (update) — reviewers can update too ──
app.put('/api/applicants/:id', requireRole('admin', 'reviewer'), async (req, res) => {
  const { name, fields } = req.body;
  const username = req.session?.user?.username;
  try {
    const old = await pool.query(`SELECT fields FROM applicants WHERE id = $1`, [req.params.id]);
    let oldFields = {};
    if (old.rows.length) {
      try { oldFields = decryptFields(JSON.parse(old.rows[0].fields)); } catch(e) {}
    }
    for (const [k, v] of Object.entries(fields || {})) {
      const oldVal = oldFields[k]?.value;
      const newVal = v?.value;
      if (oldVal !== newVal) await logAudit(req.params.id, k, oldVal, newVal, username);
    }
    const encFields = encryptFields(fields || {});
    const result = await pool.query(
      `UPDATE applicants SET name = $1, fields = $2, updated_at = NOW() WHERE id = $3 RETURNING *`,
      [name, JSON.stringify(encFields), req.params.id]
    );
    if (!result.rows.length) return res.status(404).json({ error: 'Applicant not found' });
    await logAccess(req.params.id, 'UPDATE', req);
    res.json({ ...result.rows[0], fields });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// ── /api/applicants/:id/flag-deletion ────────────────────────
app.post('/api/applicants/:id/flag-deletion', requireRole('admin'), async (req, res) => {
  try {
    const result = await pool.query(
      `UPDATE applicants SET flagged_for_deletion = TRUE, deletion_flagged_at = NOW() WHERE id = $1 RETURNING id, name`,
      [req.params.id]
    );
    if (!result.rows.length) return res.status(404).json({ error: 'Applicant not found' });
    await logAccess(req.params.id, 'DELETION_REQUESTED', req);
    res.json({ flagged: true, ...result.rows[0] });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// ── /api/applicants/:id (delete — admin only) ─────────────────
app.delete('/api/applicants/:id', requireRole('admin'), async (req, res) => {
  try {
    await logAccess(req.params.id, 'DELETE', req);
    await pool.query(`DELETE FROM applicants WHERE id = $1`, [req.params.id]);
    res.json({ deleted: true });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// ── /api/applicants/:id/audit ─────────────────────────────────
app.get('/api/applicants/:id/audit', requireRole('admin'), async (req, res) => {
  try {
    const [audit, access] = await Promise.all([
      pool.query(`SELECT * FROM audit_trail WHERE applicant_id = $1 ORDER BY created_at DESC LIMIT 100`, [req.params.id]),
      pool.query(`SELECT * FROM access_log WHERE applicant_id = $1 ORDER BY created_at DESC LIMIT 100`, [req.params.id])
    ]);
    await logAccess(req.params.id, 'VIEW_AUDIT', req);
    res.json({ audit: audit.rows, access: access.rows });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// ── /api/retention/flagged ────────────────────────────────────
app.get('/api/retention/flagged', requireRole('admin'), async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT id, name, created_at, updated_at, flagged_for_deletion, deletion_flagged_at,
             EXTRACT(DAY FROM NOW() - updated_at)::int AS days_since_update
      FROM applicants
      WHERE updated_at < NOW() - INTERVAL '${RETENTION_DAYS} days'
         OR flagged_for_deletion = TRUE
      ORDER BY updated_at ASC
    `);
    res.json({ retention_days: RETENTION_DAYS, applicants: result.rows });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// ── Sumsub API helpers ────────────────────────────────────────
const SUMSUB_APP_TOKEN  = process.env.SUMSUB_APP_TOKEN  || '';
const SUMSUB_SECRET_KEY = process.env.SUMSUB_SECRET_KEY || '';
const SUMSUB_BASE_URL   = 'https://api.sumsub.com';
const SUMSUB_LEVEL_NAME = process.env.SUMSUB_LEVEL_NAME || 'basic-kyc-level';

function sumsubSign(method, uri, body = '') {
  const ts  = Math.floor(Date.now() / 1000).toString();
  const msg = ts + method.toUpperCase() + uri + (body || '');
  const sig = crypto.createHmac('sha256', SUMSUB_SECRET_KEY).update(msg).digest('hex');
  return { ts, sig };
}

async function sumsubRequest(method, uri, bodyObj = null) {
  const body = bodyObj ? JSON.stringify(bodyObj) : '';
  const { ts, sig } = sumsubSign(method, uri, body);
  const headers = {
    'X-App-Token':      SUMSUB_APP_TOKEN,
    'X-App-Access-Sig': sig,
    'X-App-Access-Ts':  ts,
    'Content-Type':     'application/json',
    'Accept':           'application/json'
  };
  const res = await fetch(`${SUMSUB_BASE_URL}${uri}`, {
    method, headers, body: body || undefined
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.description || data.message || `Sumsub error ${res.status}`);
  return data;
}

// ── /api/sumsub/create ────────────────────────────────────────
// Creates a Sumsub applicant and generates a verification link
app.post('/api/sumsub/create', requireRole('admin', 'reviewer'), async (req, res) => {
  if (!SUMSUB_APP_TOKEN || !SUMSUB_SECRET_KEY) {
    return res.status(500).json({ error: 'Sumsub credentials not configured. Add SUMSUB_APP_TOKEN and SUMSUB_SECRET_KEY to Railway Variables.' });
  }

  const { personType, firstName, lastName, email, phone, dob, applicantId, externalId, levelName } = req.body;
  if (!firstName || !lastName || !email) {
    return res.status(400).json({ error: 'firstName, lastName and email are required' });
  }
  if (!levelName) {
    return res.status(400).json({ error: 'levelName is required' });
  }

  // Level name map — replace placeholder values with real Sumsub level names when available
  const LEVEL_MAP = {
    'level-israel': process.env.SUMSUB_LEVEL_ISRAEL || 'level-israel',
    'level-us':     process.env.SUMSUB_LEVEL_US     || 'level-us',
    'level-eu':     process.env.SUMSUB_LEVEL_EU     || 'level-eu',
  };
  const resolvedLevel = LEVEL_MAP[levelName] || levelName;

  try {
    // Build a unique external user ID
    const userId = externalId || `clearshift-${personType}-${applicantId}-${Date.now()}`;

    // Step 1: Create applicant in Sumsub
    const createBody = {
      externalUserId: userId,
      email,
      phone: phone || undefined,
      fixedInfo: {
        firstName,
        lastName,
        dob: dob || undefined
      }
    };

    const created = await sumsubRequest('POST', `/resources/applicants?levelName=${resolvedLevel}`, createBody);
    const sumsubApplicantId = created.id;

    // Step 2: Generate a shareable verification link (valid 1 hour)
    const linkBody = {
      levelName: resolvedLevel,
      userId,
      ttlInSecs: 3600
    };
    const linkRes = await sumsubRequest('POST', '/resources/sdkIntegrations/levels/-/websdkLink', linkBody);
    const verificationUrl = linkRes.url;

    // Step 3: Store the Sumsub applicant ID back in the onboarding record
    if (applicantId) {
      const fieldKey = `kyb_${personType}_sumsubId`;
      const statusKey = `kyb_${personType}_verificationStatus`;

      const row = await pool.query(`SELECT fields FROM applicants WHERE id = $1`, [applicantId]);
      if (row.rows.length) {
        let fields = {};
        try { fields = decryptFields(JSON.parse(row.rows[0].fields)); } catch(e) {}
        fields[fieldKey]  = { value: sumsubApplicantId, confidence: 'high', manual: false, sources: ['sumsub'] };
        fields[statusKey] = { value: 'link_sent',       confidence: 'high', manual: false, sources: ['sumsub'] };
        fields[`kyb_${personType}_verificationLevel`] = { value: resolvedLevel, confidence: 'high', manual: false, sources: ['sumsub'] };
        const encFields = encryptFields(fields);
        await pool.query(`UPDATE applicants SET fields = $1, updated_at = NOW() WHERE id = $2`,
          [JSON.stringify(encFields), applicantId]);
      }
    }

    res.json({
      sumsubApplicantId,
      verificationUrl,
      userId,
      message: `Verification link created for ${firstName} ${lastName}`
    });

  } catch(e) {
    console.error('Sumsub create error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── /api/sumsub/status/:sumsubApplicantId ─────────────────────
app.get('/api/sumsub/status/:sumsubApplicantId', requireRole('admin', 'reviewer'), async (req, res) => {
  if (!SUMSUB_APP_TOKEN || !SUMSUB_SECRET_KEY) {
    return res.status(500).json({ error: 'Sumsub credentials not configured' });
  }
  try {
    const data = await sumsubRequest('GET', `/resources/applicants/${req.params.sumsubApplicantId}/one`);
    const review = data.review || {};
    const status = review.reviewAnswer || review.reviewStatus || 'pending';
    res.json({
      sumsubApplicantId: req.params.sumsubApplicantId,
      status,
      reviewAnswer: review.reviewAnswer,
      reviewStatus: review.reviewStatus,
      rejectLabels: review.rejectLabels || [],
      moderationComment: review.moderationComment || ''
    });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// ── /api/sumsub/webhook ───────────────────────────────────────
// Receives Sumsub webhook events and updates applicant status
app.post('/api/sumsub/webhook', express.json(), async (req, res) => {
  try {
    const { type, applicantId: sumsubId, reviewResult } = req.body;

    if (type === 'applicantReviewed' && sumsubId) {
      const answer = reviewResult?.reviewAnswer || 'pending';
      const statusMap = { GREEN: 'verified', RED: 'rejected', ERROR: 'error' };
      const newStatus = statusMap[answer] || 'pending';

      // Find the applicant by scanning kybPersons lists for matching sumsubId
      const rows = await pool.query(`SELECT id, fields FROM applicants`);
      for (const row of rows.rows) {
        let fields = {};
        try { fields = decryptFields(JSON.parse(row.fields)); } catch(e) {}

        // Check new multi-person kybPersons structure
        let updated = false;
        try {
          const kybRaw = fields['__kybPersons']?.value;
          if (kybRaw) {
            const kyb = JSON.parse(kybRaw);
            for (const listKey of ['ubos', 'directors', 'representatives']) {
              if (!kyb[listKey]) continue;
              for (const person of kyb[listKey]) {
                if (person.sumsubId === sumsubId) {
                  person.verificationStatus = newStatus;
                  updated = true;
                  break;
                }
              }
              if (updated) break;
            }
            if (updated) {
              fields['__kybPersons'] = { value: JSON.stringify(kyb), confidence: 'high', manual: true, sources: ['sumsub'] };
              const encFields = encryptFields(fields);
              await pool.query(`UPDATE applicants SET fields = $1, updated_at = NOW() WHERE id = $2`,
                [JSON.stringify(encFields), row.id]);
              console.log(`Sumsub webhook: applicant ${sumsubId} → ${newStatus}`);
              break;
            }
          }
        } catch(e) { console.error('Webhook parse error:', e.message); }
      }
    }
    res.json({ received: true });
  } catch(e) {
    console.error('Webhook error:', e.message);
    res.status(500).json({ error: e.message });
  }
});


// Accepts: multipart/form-data with field "audio" (the file)
// Returns: { transcript: "..." }
app.post('/api/transcribe', upload.single('audio'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No audio file provided' });

  const groqKey = GROQ_KEY;
  if (!groqKey) return res.status(500).json({ error: 'GROQ_API_KEY not configured on server' });

  try {
    const form = new FormData();
    form.append('file', req.file.buffer, {
      filename: req.file.originalname || 'audio.mp3',
      contentType: req.file.mimetype || 'audio/mpeg'
    });
    form.append('model', 'whisper-large-v3-turbo');
    form.append('response_format', 'text');

    const groqRes = await fetch('https://api.groq.com/openai/v1/audio/transcriptions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${groqKey}`,
        ...form.getHeaders()
      },
      body: form
    });

    if (!groqRes.ok) {
      const err = await groqRes.json().catch(() => ({}));
      return res.status(groqRes.status).json({ error: err.error?.message || `Groq error ${groqRes.status}` });
    }

    const transcript = await groqRes.text();
    res.json({ transcript: transcript.trim() });

  } catch (e) {
    console.error('Transcription error:', e);
    res.status(500).json({ error: e.message });
  }
});

// ── /api/analyze ─────────────────────────────────────────────
app.post('/api/analyze', async (req, res) => {
  const { contentParts, fieldSummary, systemPrompt } = req.body;
  if (!contentParts || !fieldSummary) return res.status(400).json({ error: 'Missing contentParts or fieldSummary' });

  const anthropicKey = ANTHROPIC_KEY;
  if (!anthropicKey) return res.status(500).json({ error: 'ANTHROPIC_API_KEY not configured on server' });
  console.log('Using Anthropic key:', anthropicKey.slice(0, 20) + '...');

  try {
    const enhancedPrompt = systemPrompt +
      '\n\nADDITIONAL RULES: Documents may be in Hebrew, Arabic, or other languages. ' +
      'Extract and return values in English. Transliterate Hebrew/Arabic names to English letters. ' +
      'NEVER invent data. NEVER use placeholder values. NEVER hallucinate. ' +
      'If the information is not explicitly in the document, do NOT include that field.' +
      '\n\nPEP COMPLIANCE: The field "areYouAPep" must NEVER be filled unless the client ' +
      'has explicitly and directly stated Yes, No, or Uncertain. ' +
      'Do NOT infer "No" from silence. If not directly answered, omit it entirely.' +
      '\n\nKYB HEBREW REGISTRY EXTRACTION RULES:\n' +
      '- שם חברה / שם החברה = company name → extract to BOTH kyb_legalName AND companyNameInEnglish (use the English name "שם חברה באנגלית" if present, otherwise transliterate Hebrew)\n' +
      '- מספר חברה / מס\' חברה = registration number → kyb_regNumber\n' +
      '- כתובת התאגיד = registered address → kyb_regAddress\n' +
      '- תאריך רישום = registration date → kyb_regDate\n' +
      '- סוג חברה ישראלית + חברה פרטית = Private Limited Company → kyb_legalForm\n' +
      '- בעלי מניות section: check each shareholder name — if it contains בע"מ/Ltd/LLC/Inc/company/corp then it is a corporate shareholder → set kyb_ubo_hasCorporateShareholder="Yes — one or more corporate shareholders exist" AND kyb_ubo_corporateShareholderName. If ALL shareholders are individual people → set kyb_ubo_hasCorporateShareholder="No — all shareholders are individuals"\n' +
      '- דירקטורים + בעלי תפקידים sections: list ALL names and roles in the summary. Transliterate Hebrew names to English. מנכ"ל=CEO, סמנכ"ל=VP, רו"ח/רואה חשבון=Accountant, נושא משרה=Officer, מנהל=Manager\n' +
      '- Summary format for registry docs: "[Company name] ([reg number]). Directors: [names]. Officers: [name] ([role]). Shareholders: [names with %]"\n' +
      '- CRITICAL: Always write names as FIRSTNAME LASTNAME order (e.g. "Osama Sarsur" not "Sarsur Osama")\n' +
      'FIELD_ID="companyNameInEnglish" QUESTION="Name of the Business"\n' +
      'Document contains: "שם חברה: גרניטה - מקבוצת שאהין בע\'\'מ"\n' +
      'CORRECT: {"companyNameInEnglish": {"value": "Granita - Shahin Group Ltd", "confidence": "high"}}\n' +
      'WRONG:   {"companyNameInEnglish": {"value": "Name of the Business", "confidence": "high"}}\n' +
      'The value is ALWAYS real data from the document, NEVER the question/field label text.';

    // Build the user message — Claude handles large context natively, no chunking needed
    const userText = contentParts
      .map(p => p.text || '')
      .filter(t => t.trim().length > 20)
      .join('\n');

    console.log(`Sending ${userText.length} chars to Claude Sonnet`);

    // Try Sonnet first, fall back to Haiku if overloaded
    const models = [
      { id: 'claude-sonnet-4-6', label: 'Claude Sonnet' },
      { id: 'claude-haiku-4-5-20251001', label: 'Claude Haiku (fallback)' }
    ];

    let response, usedModel, lastError;

    for (const model of models) {
      let overloaded = false;
      for (let attempt = 1; attempt <= 2; attempt++) {
        try {
          console.log(`Trying ${model.label} (attempt ${attempt})...`);
          response = await fetch('https://api.anthropic.com/v1/messages', {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'x-api-key': anthropicKey,
              'anthropic-version': '2023-06-01'
            },
            body: JSON.stringify({
              model: model.id,
              max_tokens: 4000,
              system: enhancedPrompt,
              messages: [{ role: 'user', content: userText }]
            })
          });

          if (response.status === 529 || response.status === 503) {
            console.log(`${model.label} overloaded (attempt ${attempt}/2)`);
            overloaded = true;
            if (attempt < 2) await new Promise(r => setTimeout(r, 6000));
            continue;
          }

          if (!response.ok) {
            const err = await response.json().catch(() => ({}));
            const msg = err.error?.message || `API error ${response.status}`;
            if ((msg.toLowerCase().includes('overload') || response.status === 529) && attempt < 2) {
              overloaded = true;
              await new Promise(r => setTimeout(r, 6000));
              continue;
            }
            return res.status(response.status).json({ error: msg });
          }

          usedModel = model.label;
          overloaded = false;
          break;
        } catch(e) {
          lastError = e;
          if (attempt < 2) await new Promise(r => setTimeout(r, 4000));
        }
      }

      if (!overloaded && response?.ok) break; // success — stop trying models
      if (!overloaded) break; // non-overload error — stop
      response = null; // reset for next model
    }

    if (!response || !response.ok) {
      throw lastError || new Error('All models overloaded. Please try again in a few minutes.');
    }

    const data = await response.json();
    const text = data.content?.[0]?.text || '';

    console.log(`Claude response: ${text.length} chars`);

    const parsed = parseJSON(text);
    if (parsed) {
      console.log(`Extracted ${Object.keys(parsed.extracted || {}).length} fields using ${usedModel}`);
      res.json({ ...parsed, usedModel });
    } else {
      res.json({ extracted: {}, summary: 'No extractable data found', usedModel });
    }

  } catch (e) {
    console.error('Analyze error:', e);
    res.status(500).json({ error: e.message });
  }
});

// ── Groq chat helper with rate-limit retry ────────────────────
async function callGroq(apiKey, systemPrompt, userText, maxTokens, model = 'llama-3.3-70b-versatile') {
  const body = JSON.stringify({
    model,
    max_tokens: maxTokens,
    temperature: 0.1,
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user',   content: userText }
    ]
  });

  let res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
    body
  });

  // Retry once on rate limit
  if (res.status === 429) {
    console.log('Rate limited — waiting 60s');
    await new Promise(r => setTimeout(r, 60000));
    res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
      body
    });
  }

  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error?.message || `Groq error ${res.status}`);
  }

  const data = await res.json();
  return parseJSON(data.choices?.[0]?.message?.content || '');
}

function parseJSON(text) {
  let parsed = null;
  const jsonMatch = text.match(/\{[\s\S]*"extracted"[\s\S]*\}/);
  if (jsonMatch) { try { parsed = JSON.parse(jsonMatch[0]); } catch(e) {} }
  if (!parsed) {
    try {
      const clean = text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/, '').trim();
      parsed = JSON.parse(clean);
    } catch(e) {}
  }
  if (!parsed) {
    const s = text.indexOf('{'), e2 = text.lastIndexOf('}');
    if (s !== -1 && e2 > s) { try { parsed = JSON.parse(text.slice(s, e2 + 1)); } catch(e) {} }
  }
  return parsed;
}

// ── Catch-all → serve frontend ───────────────────────────────
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Clearshift onboarding running on port ${PORT}`));
