require('dotenv').config();
const express    = require('express');
const multer     = require('multer');
const fetch      = require('node-fetch');
const FormData   = require('form-data');
const cors       = require('cors');
const path       = require('path');
const { Pool }   = require('pg');

const app    = express();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 25 * 1024 * 1024 } });

app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// ── Database setup (PostgreSQL) ───────────────────────────────
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL?.includes('railway') ? { rejectUnauthorized: false } : false
});

async function initDB() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS applicants (
      id         SERIAL PRIMARY KEY,
      name       TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      fields     JSONB NOT NULL DEFAULT '{}'
    );
    CREATE INDEX IF NOT EXISTS idx_applicants_name ON applicants(name);
  `);
  console.log('Database ready');
}

initDB().catch(err => console.error('DB init error:', err));

// ── /api/applicants/search ────────────────────────────────────
app.get('/api/applicants/search', async (req, res) => {
  const q = (req.query.q || '').trim();
  try {
    let result;
    if (!q) {
      result = await pool.query(
        `SELECT id, name, updated_at FROM applicants ORDER BY updated_at DESC LIMIT 20`
      );
    } else {
      result = await pool.query(
        `SELECT id, name, updated_at FROM applicants WHERE name ILIKE $1 ORDER BY updated_at DESC LIMIT 20`,
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
app.get('/api/applicants/:id', async (req, res) => {
  try {
    const result = await pool.query(`SELECT * FROM applicants WHERE id = $1`, [req.params.id]);
    if (!result.rows.length) return res.status(404).json({ error: 'Applicant not found' });
    res.json(result.rows[0]);
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// ── /api/applicants (create) ──────────────────────────────────
app.post('/api/applicants', async (req, res) => {
  const { name, fields } = req.body;
  if (!name) return res.status(400).json({ error: 'Name is required' });
  try {
    const result = await pool.query(
      `INSERT INTO applicants (name, fields) VALUES ($1, $2) RETURNING *`,
      [name, JSON.stringify(fields || {})]
    );
    res.json(result.rows[0]);
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// ── /api/applicants/:id (update) ─────────────────────────────
app.put('/api/applicants/:id', async (req, res) => {
  const { name, fields } = req.body;
  try {
    const result = await pool.query(
      `UPDATE applicants SET name = $1, fields = $2, updated_at = NOW()
       WHERE id = $3 RETURNING *`,
      [name, JSON.stringify(fields || {}), req.params.id]
    );
    if (!result.rows.length) return res.status(404).json({ error: 'Applicant not found' });
    res.json(result.rows[0]);
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// ── /api/applicants/:id (delete) ─────────────────────────────
app.delete('/api/applicants/:id', async (req, res) => {
  try {
    await pool.query(`DELETE FROM applicants WHERE id = $1`, [req.params.id]);
    res.json({ deleted: true });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// ── /api/transcribe ──────────────────────────────────────────
// Accepts: multipart/form-data with field "audio" (the file)
// Returns: { transcript: "..." }
app.post('/api/transcribe', upload.single('audio'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No audio file provided' });

  const groqKey = process.env.GROQ_API_KEY;
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

  const groqKey = process.env.GROQ_API_KEY;
  if (!groqKey) return res.status(500).json({ error: 'GROQ_API_KEY not configured on server' });

  try {
    const TPM_LIMIT       = 5800;
    const RESPONSE_TOKENS = 800;
    const DOC_CHUNK_SIZE  = 4000; // chars per document chunk

    const multilingualPrompt = systemPrompt +
      '\n\nADDITIONAL RULES: Documents may be in Hebrew, Arabic, or other languages. ' +
      'Extract and return values in English. Transliterate names if needed. ' +
      'NEVER invent data. NEVER use placeholder values. NEVER hallucinate. ' +
      'If the information is not explicitly in the document, do NOT include the field.' +
      '\n\nPEP COMPLIANCE: The field "areYouAPep" must NEVER be filled unless the client ' +
      'has explicitly and directly stated Yes, No, or Uncertain in their own words. ' +
      'Do NOT infer "No" from silence or absence of mention. If not directly answered, omit it entirely.' +
      '\n\nCRITICAL EXAMPLE — correct extraction:\n' +
      'FIELD_ID="companyNameInEnglish" QUESTION="Name of the Business"\n' +
      'Document contains: "שם חברה: גרניטה - מקבוצת שאהין בע\'\'מ"\n' +
      'CORRECT: {"companyNameInEnglish": {"value": "Granita - Shahin Group Ltd", "confidence": "high"}}\n' +
      'WRONG: {"companyNameInEnglish": {"value": "Name of the Business", "confidence": "high"}}\n' +
      'The value is ALWAYS from the document, NEVER the question text.';

    const SYSTEM_TOKENS = Math.ceil(multilingualPrompt.length / 4);
    const AVAILABLE     = TPM_LIMIT - RESPONSE_TOKENS - SYSTEM_TOKENS;

    // ── 1. Extract full document text ──────────────────────────
    const allDocText = contentParts
      .map(p => p.text || '')
      .filter(t => t.trim().length > 20)
      .join('\n');

    console.log(`Received ${contentParts.length} content parts, total doc text: ${allDocText.length} chars`);

    // ── 2. Pre-translate Hebrew if needed ──────────────────────
    const isHebrew = /[\u0590-\u05FF]/.test(allDocText);
    let processedText = allDocText;

    if (isHebrew) {
      console.log('Hebrew detected — pre-translating...');
      try {
        // Translate in 3000-char chunks if needed
        const hebrewChunks = [];
        for (let i = 0; i < allDocText.length; i += 3000) {
          hebrewChunks.push(allDocText.slice(i, i + 3000));
        }
        const translatedParts = [];
        for (const chunk of hebrewChunks) {
          const translateRes = await fetch('https://api.groq.com/openai/v1/chat/completions', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${groqKey}` },
            body: JSON.stringify({
              model: 'llama-3.1-8b-instant',
              max_tokens: 1500,
              temperature: 0.1,
              messages: [{ role: 'user', content: `Translate to English. Keep all numbers, names, and amounts unchanged:\n\n${chunk}` }]
            })
          });
          if (translateRes.ok) {
            const tData = await translateRes.json();
            const t = tData.choices?.[0]?.message?.content || '';
            if (t.length > 50) translatedParts.push(t);
          }
          await new Promise(r => setTimeout(r, 500));
        }
        if (translatedParts.length > 0) {
          processedText = translatedParts.join('\n');
          console.log(`Translation complete: ${processedText.length} chars`);
        }
      } catch(e) {
        console.log('Translation failed, using original:', e.message);
      }
    }

    // ── 3. Split document text into 4000-char chunks ───────────
    const docChunks = [];
    for (let i = 0; i < processedText.length; i += DOC_CHUNK_SIZE) {
      docChunks.push(processedText.slice(i, i + DOC_CHUNK_SIZE));
    }
    if (docChunks.length === 0) docChunks.push('');
    console.log(`Document split into ${docChunks.length} chunk(s)`);

    // ── 4. Split field summary into token-safe batches ─────────
    const DOC_CHUNK_TOKENS = Math.ceil(DOC_CHUNK_SIZE * 1.5 / 4);
    const fieldLines = fieldSummary.split('\n');
    const fieldBatches = [];
    let current = [];
    let currentTokens = 0;
    const overhead = DOC_CHUNK_TOKENS + 80;

    for (const line of fieldLines) {
      const lineTokens = Math.ceil(line.length / 4);
      if (currentTokens + lineTokens + overhead > AVAILABLE && current.length > 0) {
        fieldBatches.push(current.join('\n'));
        current = [line];
        currentTokens = lineTokens;
      } else {
        current.push(line);
        currentTokens += lineTokens;
      }
    }
    if (current.length > 0) fieldBatches.push(current.join('\n'));

    console.log(`${fieldBatches.length} field batch(es) × ${docChunks.length} doc chunk(s) = ${fieldBatches.length * docChunks.length} total requests`);

    // ── 5. Run every field batch against every doc chunk ───────
    const mergedExtracted = {};
    let lastSummary = '';
    let requestCount = 0;

    for (const docChunk of docChunks) {
      for (let i = 0; i < fieldBatches.length; i++) {
        requestCount++;
        const userText = `Extract real data values from the document text below. Map them to these field IDs.
The QUESTION shows what to look for. The value must come from the document — NEVER from the QUESTION text itself.

FIELDS (batch ${i + 1} of ${fieldBatches.length}):\n${fieldBatches[i]}\n\n---\n\nDOCUMENT TEXT (chunk ${docChunks.indexOf(docChunk) + 1} of ${docChunks.length}):\n${docChunk}`;

        const parsed = await callGroq(groqKey, multilingualPrompt, userText, RESPONSE_TOKENS);
        if (parsed?.extracted) {
          // Only overwrite if new value has higher or equal confidence
          for (const [k, v] of Object.entries(parsed.extracted)) {
            if (v?.value && !mergedExtracted[k]) {
              mergedExtracted[k] = v;
            }
          }
          lastSummary = parsed.summary || lastSummary;
        }

        // Pause between requests to avoid TPM burst
        if (requestCount < fieldBatches.length * docChunks.length) {
          await new Promise(r => setTimeout(r, 800));
        }
      }
    }

    console.log(`Completed ${requestCount} requests, extracted ${Object.keys(mergedExtracted).length} fields`);
    res.json({ extracted: mergedExtracted, summary: lastSummary || 'Extraction complete' });

  } catch (e) {
    console.error('Analyze error:', e);
    res.status(500).json({ error: e.message });
  }
});

// ── Groq chat helper with rate-limit retry ────────────────────
async function callGroq(apiKey, systemPrompt, userText, maxTokens) {
  const body = JSON.stringify({
    model: 'llama-3.1-8b-instant',
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
