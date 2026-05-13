require('dotenv').config();
const express    = require('express');
const multer     = require('multer');
const fetch      = require('node-fetch');
const FormData   = require('form-data');
const cors       = require('cors');
const path       = require('path');

const app    = express();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 25 * 1024 * 1024 } });

app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.static(path.join(__dirname, 'public')));

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
// Accepts: { contentParts: [...], fieldSummary: "...", systemPrompt: "..." }
// Returns: { extracted: {...}, summary: "..." }
app.post('/api/analyze', async (req, res) => {
  const { contentParts, fieldSummary, systemPrompt } = req.body;
  if (!contentParts || !fieldSummary) return res.status(400).json({ error: 'Missing contentParts or fieldSummary' });

  const groqKey = process.env.GROQ_API_KEY;
  if (!groqKey) return res.status(500).json({ error: 'GROQ_API_KEY not configured on server' });

  try {
    // Flatten contentParts array into a single text message for Llama
    const userText = contentParts
      .map(p => p.text || '')
      .filter(Boolean)
      .join('\n');

    const groqRes = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${groqKey}`
      },
      body: JSON.stringify({
        model: 'llama-3.3-70b-versatile',
        max_tokens: 4000,
        temperature: 0.1,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user',   content: userText }
        ]
      })
    });

    if (!groqRes.ok) {
      const err = await groqRes.json().catch(() => ({}));
      return res.status(groqRes.status).json({ error: err.error?.message || `Groq error ${groqRes.status}` });
    }

    const data = await groqRes.json();
    const text  = data.choices?.[0]?.message?.content || '';

    // Parse JSON from Llama's response with fallbacks
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

    if (parsed) {
      res.json(parsed);
    } else {
      res.json({ extracted: {}, summary: 'No extractable data found' });
    }

  } catch (e) {
    console.error('Analyze error:', e);
    res.status(500).json({ error: e.message });
  }
});

// ── Catch-all → serve frontend ───────────────────────────────
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Clearshift onboarding running on port ${PORT}`));
