// Reference Overlord webhook consumer: rebuilds the upstream Overlord
// `generate-feed-post` pipeline as ordinary, independent software driven by a
// mission-data webhook instead of living inside the Overlord repository.
//
// Flow: verify the HMAC signature -> hydrate full mission context (inline for
// `full`-mode subscriptions, or pulled over the REST API for `thin` ones) ->
// digest it into a short feed post (an LLM call if GEMINI_API_KEY is set, a
// deterministic fallback otherwise, mirroring the upstream pipeline's own
// fallback behavior) -> append it to a local JSON file as the "somewhere
// else" sink. See ../../../developer-instructions/webhooks.md for the full contract.
import { createHmac, timingSafeEqual } from 'node:crypto';
import { appendFile } from 'node:fs/promises';

import express from 'express';

const PORT = process.env.PORT ?? 8787;
const WEBHOOK_SECRET = process.env.OVERLORD_WEBHOOK_SECRET;
const OVERLORD_BACKEND_URL = process.env.OVERLORD_BACKEND_URL ?? 'http://127.0.0.1:4310';
const OVERLORD_USER_TOKEN = process.env.OVERLORD_USER_TOKEN;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const SIGNATURE_TOLERANCE_SECONDS = 300;

if (!WEBHOOK_SECRET) {
  throw new Error('Set OVERLORD_WEBHOOK_SECRET to the secret shown when you created the webhook.');
}

function verifySignature(rawBody, signatureHeader) {
  const parts = Object.fromEntries((signatureHeader ?? '').split(',').map(p => p.split('=')));
  const timestamp = Number(parts.t);
  if (!Number.isFinite(timestamp) || Math.abs(Date.now() / 1000 - timestamp) > SIGNATURE_TOLERANCE_SECONDS) {
    return false;
  }
  const expected = createHmac('sha256', WEBHOOK_SECRET).update(`${timestamp}.${rawBody}`).digest('hex');
  const expectedBuf = Buffer.from(expected, 'hex');
  const actualBuf = Buffer.from(parts.v1 ?? '', 'hex');
  return expectedBuf.length === actualBuf.length && timingSafeEqual(expectedBuf, actualBuf);
}

/** Hydrate a `thin` envelope's mission detail via the REST pull path. A `full` envelope already has it inline. */
async function hydrateMission(envelope) {
  if (envelope.mission?.title) return envelope; // already `full`
  if (!OVERLORD_USER_TOKEN) {
    throw new Error('Received a thin payload but OVERLORD_USER_TOKEN is not set to pull the rest.');
  }
  const res = await fetch(`${OVERLORD_BACKEND_URL}${envelope.links.mission}`, {
    headers: { Authorization: `Bearer ${OVERLORD_USER_TOKEN}` }
  });
  if (!res.ok) throw new Error(`Failed to hydrate mission: ${res.status}`);
  const mission = await res.json();
  return { ...envelope, mission: { ...envelope.mission, ...mission } };
}

/** Digest mission context into a short feed post. Falls back to a deterministic summary when no LLM key is configured or the call fails -- the same posture as the upstream pipeline. */
async function draftFeedPost(envelope) {
  const fallback = {
    title: envelope.mission.title ?? envelope.mission.displayId,
    summary: envelope.delivery?.summary?.slice(0, 240) ?? 'A mission was delivered for review.',
    tags: [envelope.type]
  };
  if (!GEMINI_API_KEY) return fallback;

  try {
    const prompt = `Write a one-sentence changelog entry for this delivered mission:\nTitle: ${envelope.mission.title}\nSummary: ${envelope.delivery?.summary ?? ''}`;
    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${GEMINI_API_KEY}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }] })
      }
    );
    const data = await res.json();
    const text = data.candidates?.[0]?.content?.parts?.[0]?.text?.trim();
    return text ? { ...fallback, summary: text } : fallback;
  } catch {
    return fallback; // provider unavailable -> deterministic fallback, never blocks the pipeline
  }
}

const app = express();
app.use(express.raw({ type: '*/*' })); // signing needs the exact raw body, not a re-serialized parse

app.post('/webhooks/overlord', async (req, res) => {
  const rawBody = req.body.toString('utf8');
  if (!verifySignature(rawBody, req.header('X-Overlord-Signature'))) {
    return res.status(401).json({ error: 'invalid_signature' });
  }

  const envelope = JSON.parse(rawBody);
  console.log(`[webhook] ${envelope.type} delivery=${req.header('X-Overlord-Delivery')}`);

  if (envelope.type !== 'mission.delivered') {
    return res.json({ ok: true, skipped: envelope.type }); // this example only drafts posts on delivery
  }

  try {
    const hydrated = await hydrateMission(envelope);
    const post = await draftFeedPost(hydrated);
    await appendFile('feed-posts.jsonl', JSON.stringify({ ...post, missionId: hydrated.mission.id }) + '\n');
    res.json({ ok: true });
  } catch (err) {
    console.error('[webhook] failed to process delivery', err);
    res.status(500).json({ error: 'processing_failed' });
  }
});

app.listen(PORT, () => console.log(`Feed post generator listening on :${PORT}`));
