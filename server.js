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
app.post('/api/analyze', async (req, res) => {
  const { contentParts, fieldSummary, systemPrompt } = req.body;
  if (!contentParts || !fieldSummary) return res.status(400).json({ error: 'Missing contentParts or fieldSummary' });

  const groqKey = process.env.GROQ_API_KEY;
  if (!groqKey) return res.status(500).json({ error: 'GROQ_API_KEY not configured on server' });

  try {
    const TPM_LIMIT      = 5800;
    const RESPONSE_TOKENS = 800;
    const SYSTEM_TOKENS   = Math.ceil(systemPrompt.length / 4);
    const AVAILABLE       = TPM_LIMIT - RESPONSE_TOKENS - SYSTEM_TOKENS;

    // Extract document/transcript text, capped so it leaves room for fields
    const docText = contentParts
      .map(p => p.text || '')
      .filter(t => t.includes('===') || t.toLowerCase().includes('transcript'))
      .join('\n')
      .slice(0, 2000);

    const docTokens = Math.ceil(docText.length / 4);

    // Split field summary lines into batches that fit within token budget
    const fieldLines = fieldSummary.split('\n');
    const batches = [];
    let current = [];
    let currentTokens = 0;
    const overhead = docTokens + 60; // doc + prompt framing tokens

    for (const line of fieldLines) {
      const lineTokens = Math.ceil(line.length / 4);
      if (currentTokens + lineTokens + overhead > AVAILABLE && current.length > 0) {
        batches.push(current.join('\n'));
        current = [line];
        currentTokens = lineTokens;
      } else {
        current.push(line);
        currentTokens += lineTokens;
      }
    }
    if (current.length > 0) batches.push(current.join('\n'));

    console.log(`Splitting into ${batches.length} batch(es) for ${fieldLines.length} field lines`);

    const mergedExtracted = {};
    let lastSummary = '';

    for (let i = 0; i < batches.length; i++) {
      const batchFields = batches[i];
      const userText = `Fields to extract (batch ${i + 1} of ${batches.length}):\n${batchFields}\n\n---\n\nDocuments:\n${docText}`;

      const groqRes = await fetch('https://api.groq.com/openai/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${groqKey}`
        },
        body: JSON.stringify({
          model: 'llama-3.1-8b-instant',
          max_tokens: RESPONSE_TOKENS,
          temperature: 0.1,
          messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user',   content: userText }
          ]
        })
      });

      if (!groqRes.ok) {
        const err = await groqRes.json().catch(() => ({}));
        // If rate limited, wait 60s and retry once
        if (groqRes.status === 429) {
          console.log('Rate limited — waiting 60s before retry');
          await new Promise(r => setTimeout(r, 60000));
          const retry = await fetch('https://api.groq.com/openai/v1/chat/completions', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${groqKey}` },
            body: JSON.stringify({
              model: 'llama-3.1-8b-instant',
              max_tokens: RESPONSE_TOKENS,
              temperature: 0.1,
              messages: [
                { role: 'system', content: systemPrompt },
                { role: 'user',   content: userText }
              ]
            })
          });
          if (!retry.ok) {
            const retryErr = await retry.json().catch(() => ({}));
            return res.status(retry.status).json({ error: retryErr.error?.message || `Groq error ${retry.status}` });
          }
          const retryData = await retry.json();
          const retryText = retryData.choices?.[0]?.message?.content || '';
          const retryParsed = parseJSON(retryText);
          if (retryParsed?.extracted) {
            Object.assign(mergedExtracted, retryParsed.extracted);
            lastSummary = retryParsed.summary || lastSummary;
          }
          continue;
        }
        return res.status(groqRes.status).json({ error: err.error?.message || `Groq error ${groqRes.status}` });
      }

      const data = await groqRes.json();
      const text = data.choices?.[0]?.message?.content || '';
      const parsed = parseJSON(text);
      if (parsed?.extracted) {
        Object.assign(mergedExtracted, parsed.extracted);
        lastSummary = parsed.summary || lastSummary;
      }

      // Small pause between batches to avoid TPM burst
      if (i < batches.length - 1) await new Promise(r => setTimeout(r, 1000));
    }

    res.json({ extracted: mergedExtracted, summary: lastSummary || 'Extraction complete' });

  } catch (e) {
    console.error('Analyze error:', e);
    res.status(500).json({ error: e.message });
  }
});

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
