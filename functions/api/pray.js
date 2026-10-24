// POST /api/pray on Cloudflare Pages. Same pipeline as server.js, plus the guard rails a public URL needs:
// per-IP limits, a daily spending cap (over it, tickets come without art), and R2 storage.
import { config, pray } from '../../lib/pipeline.js';

const json = (status, obj) => new Response(JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json' } });

export async function onRequestPost({ request, env, waitUntil }) {
  let body = {};
  try { body = await request.json(); } catch {}
  const text = String(body.prayer || '').trim().slice(0, 500);
  if (!text) return json(400, { error: 'Say a little prayer first.' });

  const day = new Date().toISOString().slice(0, 10);
  const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
  const ipHash = await sha256(`${env.SP_IP_SALT || 'scratch-n-pray'}:${ip}`);

  // Per-IP: a short burst limit plus a daily allowance.
  const ipKey = `limits/${day}/ip-${ipHash}.json`;
  const ipState = (await readJson(env.RAW, ipKey)) || { count: 0, recent: [] };
  const now = Date.now();
  ipState.recent = ipState.recent.filter((t) => now - t < 60_000);
  if (ipState.recent.length >= Number(env.SP_IP_PER_MINUTE || 3)) {
    return json(429, { error: 'Slow down — even miracles have a queue. Try again in a minute.' });
  }
  if (ipState.count >= Number(env.SP_IP_DAILY_LIMIT || 12)) {
    return json(429, { error: 'You’ve used up today’s prayers. The city reopens at midnight UTC.' });
  }

  // Global: estimated USD spent today. Over budget → text-only tickets; well over → closed.
  const budgetKey = `limits/${day}/budget.json`;
  const budget = (await readJson(env.RAW, budgetKey)) || { spentUsd: 0, tickets: 0 };
  const cap = Number(env.DAILY_BUDGET_USD || 5);
  if (cap > 0 && budget.spentUsd >= cap * 1.2) {
    return json(503, { error: 'The prayer budget has been exhausted for today. Like every other budget. Come back tomorrow.' });
  }
  const budgetExhausted = cap > 0 && budget.spentUsd >= cap;
  const art = body.art !== false && !budgetExhausted;

  ipState.count++; ipState.recent.push(now);
  await env.RAW.put(ipKey, JSON.stringify(ipState));

  const url = new URL(request.url);
  const { record, png } = await pray(config(env), text, { force: url.searchParams.get('force'), art });

  if (png) await env.TICKETS.put(`${record.id}.png`, png, { httpMetadata: { contentType: 'image/png' } });
  const out = { ...record, budgetExhausted };
  await env.TICKETS.put(`${record.id}.json`, JSON.stringify(out), { httpMetadata: { contentType: 'application/json' } });

  budget.spentUsd += Number(env.SP_TEXT_COST_USD || 0.002) + (png ? Number(env.SP_IMAGE_COST_USD || 0.06) : 0);
  budget.tickets++;
  waitUntil(Promise.all([
    env.RAW.put(budgetKey, JSON.stringify(budget)),
    env.RAW.put(`log/${day}/${record.id}.json`, JSON.stringify({ ...out, ipHash, country: request.cf?.country, ua: request.headers.get('User-Agent') })),
  ]));

  return json(200, out);
}

async function readJson(bucket, key) {
  const obj = await bucket.get(key);
  return obj ? obj.json() : null;
}

async function sha256(s) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  return [...new Uint8Array(buf)].slice(0, 8).map((b) => b.toString(16).padStart(2, '0')).join('');
}
