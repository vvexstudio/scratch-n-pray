// Scratch & Pray — zero-dependency local Node server. Tickets are saved to ./generated.
// The deployed version runs the same pipeline as Cloudflare Pages Functions (see functions/).
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { config, pray } from './lib/pipeline.js';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
loadEnv(path.join(ROOT, '.env'));

const PORT = Number(process.env.PORT || 5177);
const cfg = config(process.env);
const PUBLIC_DIR = path.join(ROOT, 'public');
const GEN_DIR = path.join(ROOT, 'generated');
fs.mkdirSync(GEN_DIR, { recursive: true });

function loadEnv(file) {
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*(?:\s#.*)?$/);
    if (!m || process.env[m[1]] !== undefined) continue;
    process.env[m[1]] = m[2].replace(/^['"]|['"]$/g, '');
  }
}

async function handlePray(req, res, url) {
  const { prayer = '', art = true } = await readJson(req);
  const text = String(prayer).trim().slice(0, 500);
  if (!text) return send(res, 400, { error: 'Say a little prayer first.' });

  const { record, png } = await pray(cfg, text, { force: url.searchParams.get('force'), art });
  if (png) fs.writeFileSync(path.join(GEN_DIR, `${record.id}.png`), png);
  if (record.artError) console.error('[art]', record.artError);
  fs.writeFileSync(path.join(GEN_DIR, `${record.id}.json`), JSON.stringify(record, null, 2));
  console.log(`[pray] ${record.jackpot ? 'JACKPOT' : 'paw'} ${record.timings.total}ms — "${text.slice(0, 60)}" → ${record.ticket.prize}`);
  send(res, 200, record);
}

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.webmanifest': 'application/manifest+json', '.png': 'image/png', '.svg': 'image/svg+xml' };

function serveStatic(res, file) {
  fs.readFile(file, (err, buf) => {
    if (err) return send(res, 404, { error: 'not found' });
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
    res.end(buf);
  });
}

function send(res, status, obj) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(obj));
}

function readJson(req) {
  return new Promise((resolve) => {
    let data = '';
    req.on('data', (c) => (data += c));
    req.on('end', () => { try { resolve(JSON.parse(data || '{}')); } catch { resolve({}); } });
  });
}

http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  try {
    if (req.method === 'POST' && url.pathname === '/api/pray') return await handlePray(req, res, url);
    if (url.pathname.startsWith('/generated/')) return serveStatic(res, path.join(GEN_DIR, path.basename(url.pathname)));
    const rel = url.pathname === '/' ? 'index.html' : path.normalize(url.pathname).replace(/^([/\\])+/, '');
    const file = path.join(PUBLIC_DIR, rel);
    if (!file.startsWith(PUBLIC_DIR)) return send(res, 403, { error: 'nope' });
    serveStatic(res, file);
  } catch (e) {
    console.error(e);
    send(res, 500, { error: e.message });
  }
}).listen(PORT, () => {
  console.log(`Scratch & Pray → http://localhost:${PORT}  (text: ${cfg.textModel}, image: ${cfg.imageModel}/${cfg.imageQuality}, odds 1:${cfg.jackpotOdds})`);
});
