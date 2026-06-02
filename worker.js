/**
 * SITTER backend — Cloudflare Worker (split-invocation, two-step pipeline)
 *
 * Three actions, all POST:
 *
 *   action: 'submit_swap'    → start a face-swap; returns predictionId
 *   action: 'submit_upscale' → upscale a previously-generated image; returns predictionId
 *   action: 'poll'           → check status of any prediction; returns status + output
 *
 * Each invocation makes ≤2 subrequests, fitting in Cloudflare free tier limits.
 * The browser drives the pipeline: submit_swap → poll until done → submit_upscale
 * with the swap output → poll until done → show result.
 *
 * Bindings:
 *   - REPLICATE_TOKEN (secret)
 *   - QUOTA (KV namespace)
 *   - ALLOWED_ORIGIN (var)
 */

const DAILY_CAP = 100;   // testing cap; lower before launch
const PER_IP_CAP = 4;   // raised for testing; lower before launch

const BASE_SCENES = {
  // index: 0 = the leftmost face the model detects, 1 = the next one to the right
  // Most paintings work with index 1 (we want to swap the right figure).
  // Some paintings detect faces right-to-left, so we override to 0 for those.
  pearl_earring:  { url: 'https://raw.githubusercontent.com/wuyanqi321-gif/sitter-scenes/main/pearl_earring.png',  index: 1 },
  mona_lisa:      { url: 'https://raw.githubusercontent.com/wuyanqi321-gif/sitter-scenes/main/mona_lisa.png',      index: 1 },
  van_gogh_self:  { url: 'https://raw.githubusercontent.com/wuyanqi321-gif/sitter-scenes/main/van_gogh_self.png',  index: 1 },
  lady_ermine:    { url: 'https://raw.githubusercontent.com/wuyanqi321-gif/sitter-scenes/main/lady_ermine.png',    index: 0 },
  la_loge:        { url: 'https://raw.githubusercontent.com/wuyanqi321-gif/sitter-scenes/main/la_loge.png',        index: 0 },
  pope_innocent:  { url: 'https://raw.githubusercontent.com/wuyanqi321-gif/sitter-scenes/main/pope_innocent.png',  index: 1 },
  blue_boy:       { url: 'https://raw.githubusercontent.com/wuyanqi321-gif/sitter-scenes/main/blue_boy.png',       index: 1 },
  adele:          { url: 'https://raw.githubusercontent.com/wuyanqi321-gif/sitter-scenes/main/adele.png',          index: 0 },
  vigee_lebrun:   { url: 'https://raw.githubusercontent.com/wuyanqi321-gif/sitter-scenes/main/vigee_lebrun.png',   index: 0 },
  milkmaid:       { url: 'https://raw.githubusercontent.com/wuyanqi321-gif/sitter-scenes/main/milkmaid.png',       index: 0 },
  klimt_fan:         { url: 'https://raw.githubusercontent.com/wuyanqi321-gif/sitter-scenes/main/klimt_fan.png',         index: 0 },
  elizabeth_armada:  { url: 'https://raw.githubusercontent.com/wuyanqi321-gif/sitter-scenes/main/elizabeth_armada.png',  index: 0 },
};

// Face-swap model
const SWAP_MODEL_VERSION = '35e814ba37eb5ef39efda860786cbcdd9251c31dafbacc91ab3b4f6641fb802d'; // mertguvencli/face-swap-with-indexes

export default {
  async fetch(request, env, ctx) {
    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: corsHeaders(env) });
    }
    if (request.method !== 'POST') {
      return json({ error: 'POST only' }, 405, env);
    }

    let body;
    try {
      body = await request.json();
    } catch {
      return json({ error: 'invalid json' }, 400, env);
    }

    const action = String(body.action || 'submit_swap');

    if (action === 'poll') return handlePoll(body, env);
    if (action === 'read_stats') return handleReadStats(body, env);
    return handleSubmitSwap(body, request, env, ctx);
  },
};

// ─── SUBMIT FACE-SWAP ─────────────────────────────────────────────────────────
async function handleSubmitSwap(body, request, env, ctx) {
  const userPhoto = String(body.userPhoto || '');
  const paintingId = String(body.paintingId || '');

  if (!userPhoto.startsWith('data:image/')) {
    return json({ error: 'userPhoto must be a base64 data URL' }, 400, env);
  }

  const sceneConfig = BASE_SCENES[paintingId];
  if (!sceneConfig) {
    return json({
      error: 'no base scene for this painting',
      paintingId,
      available: Object.keys(BASE_SCENES),
    }, 400, env);
  }
  const sceneUrl = sceneConfig.url;
  const destinationFaceIndex = sceneConfig.index;

  // Quota check (only on swap submit — upscale doesn't count separately)
  const today = new Date().toISOString().slice(0, 10);
  const ip = request.headers.get('cf-connecting-ip') || 'unknown';
  const ipKey = `ip:${today}:${ip}`;
  const globalKey = `global:${today}`;

  const [ipUsedRaw, globalUsedRaw] = await Promise.all([
    env.QUOTA.get(ipKey),
    env.QUOTA.get(globalKey),
  ]);
  const ipUsed = parseInt(ipUsedRaw || '0', 10);
  const globalUsed = parseInt(globalUsedRaw || '0', 10);

  if (ipUsed >= PER_IP_CAP) {
    return json({ error: 'per-ip daily limit reached', remaining: 0 }, 429, env);
  }
  if (globalUsed >= DAILY_CAP) {
    return json({ error: 'site daily limit reached, try again tomorrow', remaining: 0 }, 429, env);
  }

  // Submit prediction
  let prediction;
  try {
    const resp = await fetch('https://api.replicate.com/v1/predictions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${env.REPLICATE_TOKEN}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        version: SWAP_MODEL_VERSION,
        input: {
          source_face_image: userPhoto,
          destination_image: sceneUrl,
          source_face_index: 0,
          destination_face_index: destinationFaceIndex,
          execution_type: 'face_swap',
        },
      }),
    });
    if (!resp.ok) {
      const errText = await resp.text();
      return json({
        error: 'face-swap submit failed',
        status: resp.status,
        detail: errText.slice(0, 500),
        fallbackImage: sceneUrl,
      }, 502, env);
    }
    prediction = await resp.json();
  } catch (err) {
    return json({
      error: 'replicate unreachable',
      detail: String(err),
      fallbackImage: sceneUrl,
    }, 502, env);
  }

  // Bump quotas optimistically
  ctx.waitUntil(Promise.all([
    env.QUOTA.put(ipKey, String(ipUsed + 1), { expirationTtl: 60 * 60 * 26 }),
    env.QUOTA.put(globalKey, String(globalUsed + 1), { expirationTtl: 60 * 60 * 26 }),
  ]));

  // Bump stats counters: per-day total and per-day per-painting
  ctx.waitUntil((async () => {
    const totalKey = `stats:total:${today}`;
    const paintingKey = `stats:painting:${today}:${paintingId}`;
    const [totalRaw, paintingRaw] = await Promise.all([
      env.QUOTA.get(totalKey),
      env.QUOTA.get(paintingKey),
    ]);
    const total = parseInt(totalRaw || '0', 10) + 1;
    const painting = parseInt(paintingRaw || '0', 10) + 1;
    // 90 days retention so old stats clean themselves up
    const ttl = 60 * 60 * 24 * 90;
    await Promise.all([
      env.QUOTA.put(totalKey, String(total), { expirationTtl: ttl }),
      env.QUOTA.put(paintingKey, String(painting), { expirationTtl: ttl }),
    ]);
  })());

  return json({
    predictionId: prediction.id,
    status: prediction.status,
    output: prediction.output,
    scenePreview: sceneUrl,
    remainingForYou: PER_IP_CAP - ipUsed - 1,
    remainingGlobal: DAILY_CAP - globalUsed - 1,
  }, 200, env);
}

// ─── POLL ─────────────────────────────────────────────────────────────────────
async function handlePoll(body, env) {
  const predictionId = String(body.predictionId || '');
  if (!predictionId) return json({ error: 'missing predictionId' }, 400, env);

  try {
    const resp = await fetch(
      `https://api.replicate.com/v1/predictions/${encodeURIComponent(predictionId)}`,
      { headers: { 'Authorization': `Bearer ${env.REPLICATE_TOKEN}` } }
    );
    if (!resp.ok) {
      return json({ error: 'poll failed', status: resp.status }, 502, env);
    }
    const prediction = await resp.json();
    return json({
      predictionId: prediction.id,
      status: prediction.status,
      output: prediction.output,
      error: prediction.error,
    }, 200, env);
  } catch (err) {
    return json({ error: 'poll error', detail: String(err) }, 502, env);
  }
}

// ─── HELPERS ──────────────────────────────────────────────────────────────────
function corsHeaders(env) {
  return {
    'Access-Control-Allow-Origin': env.ALLOWED_ORIGIN || '*',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Max-Age': '86400',
  };
}

function json(obj, status, env) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: {
      'Content-Type': 'application/json',
      ...corsHeaders(env),
    },
  });
}
