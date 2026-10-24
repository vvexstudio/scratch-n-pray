// Scratch & Pray pipeline, shared by the local Node server (server.js) and Cloudflare Pages Functions (functions/).
// prayer → RNG (1 in N jackpot) → LLM writes the prize + card theme → OpenAI image renders the ticket art.
// Runtime-agnostic: only uses fetch, Web Crypto and atob. Storage is the caller's job.

export function config(env) {
  return {
    apiKey: env.OPENAI_API_KEY,
    textModel: env.SP_TEXT_MODEL || 'gpt-5.4-mini',
    imageModel: env.SP_IMAGE_MODEL || 'gpt-image-1.5',
    imageQuality: env.SP_IMAGE_QUALITY || 'medium', // low | medium | high
    jackpotOdds: Number(env.SP_JACKPOT_ODDS || 10), // 1 in N
  };
}

// Returns { record, png } — png is a Uint8Array, or null if art was skipped or failed (record.artError says why).
export async function pray(cfg, prayer, { force, art = true } = {}) {
  const jackpot = force ? force === 'win' : randomInt(cfg.jackpotOdds) === 0;
  const id = new Date().toISOString().replace(/[:.]/g, '-') + '-' + crypto.randomUUID().slice(0, 6);
  const t0 = Date.now();

  const ticket = await writePrize(cfg, prayer, jackpot);
  const tText = Date.now() - t0;

  let png = null;
  let artError = null;
  if (art) {
    try {
      png = base64ToBytes(await renderArt(cfg, ticket, jackpot));
    } catch (e) {
      artError = e.message;
    }
  }

  const record = {
    id, prayer, jackpot, ticket,
    image: png ? `/generated/${id}.png` : null,
    artError,
    timings: { text: tText, total: Date.now() - t0 },
    models: { text: cfg.textModel, image: art ? cfg.imageModel : null },
  };
  return { record, png };
}

// Unbiased integer in [0, n) via rejection sampling on Web Crypto.
function randomInt(n) {
  const max = Math.floor(0x100000000 / n) * n;
  const buf = new Uint32Array(1);
  do crypto.getRandomValues(buf); while (buf[0] >= max);
  return buf[0] % n;
}

function base64ToBytes(b64) {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

// ── Prize writing ────────────────────────────────────────────────────────────

const SYSTEM_PROMPT = `You are the prize department of "SCRATCH & PRAY", a satirical scratch-off lottery run by an imaginary, underfunded New York City bureaucracy. People submit a "prayer" — a real need (food, housing, health care, immigration status, student debt, childcare, transit, etc.) — and scratch a ticket hoping it gets solved.

The joke: access to basic services in America feels like gambling. Most tickets are monkey's-paw prizes: technically a "win", absurdly inadequate, hyper-specific to NYC, and darkly funny. Examples of the tone:
- Starving → "Leftovers from the 3-Pizza-Joint dumpster on 14th St (crusts only, still warm-ish)"
- Need a green card → "One (1) Get Out Of ICE Free Card*" (*not valid anywhere) or "A weekend trip to New Jersey"
- Need major surgery → "A free ambulance ride (to the wrong borough)", "Two ibuprofen and a 'there there' pat on the head", "'Walk It Off' brand sneakers"
- Student loans → "An invitation to audit one night class at City College", "BOGO coupon for summer school at SUNY"
- Housing → "A 4-year spot on the waitlist for the waitlist", "One night on a very nice bench in Bryant Park"

Rules:
- Punch UP at systems, bureaucracy, landlords, insurers, agencies. Never mock the person praying or their identity.
- Be specific, concrete, NYC-flavored (boroughs, MTA, bodegas, 311, DMV lines, Con Ed, alternate side parking).
- Keep "prize" short enough to fit on a ticket (max ~14 words). "description" is 1-2 sentences of deadpan flavor. "fine_print" is fake legalese, one sentence, funny.
- If outcome is JACKPOT: the prize genuinely and completely solves their stated problem, written with lottery-ticket exuberance (still a little absurd in tone, but the substance is real: e.g. "Full green card, expedited, no interview, fee waived").
- "real_help": one short, sincere line pointing to a REAL, well-known resource relevant to their need (e.g. "Call 311 or visit nyc.gov/foodhelp", "NYC Care: 646-NYC-CARE", "Legal Aid Society", "StudentAid.gov PSLF", "City Harvest food pantry map", "Housing Court Answers"). Only name resources you are confident exist. No made-up phone numbers.
- If the prayer suggests self-harm or suicidal crisis, set "crisis": true and keep the prize gentle (not a joke at their expense).
- "card_theme" describes visual art for the ticket's ornate border (motifs, palette, iconography tied to their need, NYC landmarks, kitschy lottery/religious-candle aesthetic). No words in it except the game name.`;

const PRIZE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['category', 'game_name', 'headline', 'prize', 'description', 'fine_print', 'real_help', 'crisis', 'symbols', 'card_theme'],
  properties: {
    category: { type: 'string', enum: ['food', 'housing', 'health', 'immigration', 'education', 'money', 'transit', 'childcare', 'work', 'love', 'other'] },
    game_name: { type: 'string', description: 'Ticket game name, 1-3 words, e.g. "Rent Roulette", "Green Card Bingo", "Copay Cash"' },
    headline: { type: 'string', description: 'Big reveal line, e.g. "WINNER!", "YOU WON*", "JACKPOT!!!", "CONGRATULATIONS?"' },
    prize: { type: 'string' },
    description: { type: 'string' },
    fine_print: { type: 'string' },
    real_help: { type: 'string' },
    crisis: { type: 'boolean' },
    symbols: { type: 'array', items: { type: 'string' }, description: 'Exactly 3 emoji that show up on the ticket' },
    card_theme: { type: 'string' },
  },
};

async function writePrize(cfg, prayer, jackpot) {
  const body = {
    model: cfg.textModel,
    messages: [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: `Prayer: """${prayer}"""\nOutcome: ${jackpot ? 'JACKPOT (genuinely solve it)' : 'MONKEY\'S PAW (inadequate, absurd prize)'}` },
    ],
    response_format: { type: 'json_schema', json_schema: { name: 'prize', strict: true, schema: PRIZE_SCHEMA } },
  };
  const res = await openai(cfg, '/v1/chat/completions', body);
  return JSON.parse(res.choices[0].message.content);
}

// ── Ticket art ───────────────────────────────────────────────────────────────

function imagePrompt(t, jackpot) {
  return `A vertical scratch-off lottery ticket, flat front-facing graphic design filling the entire frame edge to edge, portrait 2:3, no background or table visible.

Game title at the top in big bold retro lottery lettering: "SCRATCH & PRAY" and beneath it smaller: "${t.game_name.toUpperCase()}".

Theme and border art: ${t.card_theme}. Ornate, maximalist, kitschy American state-lottery aesthetic crossed with a Catholic prayer candle / devotional card: halos, rays, gold foil, stars, sparkles, NYC iconography. ${jackpot ? 'Extra radiant, celebratory gold.' : ''}

CRITICAL LAYOUT: the large central area (from about 41% to 78% of the height, and 12% to 88% of the width; the top 40% holds the title and a central devotional illustration) must be a single plain empty rectangle with a thin decorative frame and NOTHING inside it — no text, no symbols, it will be covered. Below it, a narrow strip of tiny illegible fine print and a fake barcode. No other words besides the title and game name.`;
}

async function renderArt(cfg, t, jackpot) {
  const res = await openai(cfg, '/v1/images/generations', {
    model: cfg.imageModel,
    prompt: imagePrompt(t, jackpot),
    size: '1024x1536',
    quality: cfg.imageQuality,
    background: 'opaque',
    n: 1,
  });
  return res.data[0].b64_json;
}

async function openai(cfg, endpoint, body) {
  if (!cfg.apiKey) throw new Error('OPENAI_API_KEY missing');
  const r = await fetch('https://api.openai.com' + endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${cfg.apiKey}` },
    body: JSON.stringify(body),
  });
  const json = await r.json();
  if (!r.ok) throw new Error(`${endpoint} ${r.status}: ${json.error?.message || JSON.stringify(json)}`);
  return json;
}
