# Clearshift Customer Onboarding Portal

Extracts customer onboarding data from documents and call recordings using Claude (Anthropic) and Whisper (Groq).

## How it works

- **Documents** (PDF, DOCX, TXT) → text extracted in browser, sent to Claude for field mapping
- **Audio/video** (MP3, MP4, WAV, M4A) → sent to Groq Whisper for transcription, transcript sent to Claude
- All API keys stay on the server — never exposed to the browser

## Local development

```bash
# 1. Install dependencies
npm install

# 2. Set up environment variables
cp .env.example .env
# Edit .env and add your API keys

# 3. Start the server
npm run dev   # with auto-reload
npm start     # production mode
```

Visit http://localhost:3000

## Deploy to Railway

1. Push this folder to a GitHub repository

2. Go to [railway.app](https://railway.app) and create a new project
   - Click **New Project → Deploy from GitHub repo**
   - Select your repository

3. Add environment variables in Railway dashboard:
   - Go to your service → **Variables** tab
   - Add `ANTHROPIC_API_KEY` → your Anthropic API key
   - Add `GROQ_API_KEY` → your Groq API key (free at console.groq.com)

4. Railway auto-detects Node.js and runs `npm start` — deployment is automatic

5. Click the generated URL to open your app

## Environment variables

| Variable | Required | Description |
|---|---|---|
| `ANTHROPIC_API_KEY` | Yes | From console.anthropic.com |
| `GROQ_API_KEY` | Yes | Free from console.groq.com |
| `PORT` | No | Defaults to 3000, Railway sets this automatically |

## API endpoints

| Endpoint | Method | Description |
|---|---|---|
| `/api/transcribe` | POST | Transcribes audio file via Groq Whisper. Accepts `multipart/form-data` with `audio` field. Returns `{ transcript }` |
| `/api/analyze` | POST | Extracts onboarding fields via Claude. Accepts `{ contentParts, fieldSummary, systemPrompt }`. Returns `{ extracted, summary }` |
| `/*` | GET | Serves the frontend |
