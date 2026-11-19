import { decodeStreamId, normalizeChatId } from "./codec";
import { downloadDocument, getDocument, invalidateClients, type CfConfig, type WorkerEnv } from "./telegram";
import { resolveZipEntry } from "./zip";

interface Env extends WorkerEnv {}
interface Part { chatId: number; messageId: number; size: number; client: any; document: any; }
let configCache: { value: CfConfig; at: number } | null = null;
let configPromise: Promise<CfConfig> | null = null;
const META_TTL = 90_000;
const MAX_LINK_TTL = 48 * 60 * 60;
// Per-isolate counters are intentionally labelled as runtime-only in the dashboard.
// Cloudflare may run multiple isolates, so these are diagnostics, not billing totals.
const runtimeMetrics = { streams: 0, bytes: 0, startedAt: Date.now(), lastStreamAt: 0 };

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" } });
}
function hex(bytes: ArrayBuffer) { return Array.from(new Uint8Array(bytes)).map(x => x.toString(16).padStart(2, "0")).join(""); }
async function hmac(secret: string, value: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return hex(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(value)));
}
function safeEqual(a: string, b: string) {
  if (a.length !== b.length) return false;
  let v = 0; for (let i = 0; i < a.length; i++) v |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return v === 0;
}
async function verifyAppRequest(request: Request, env: Env, body: string) {
  const ts = request.headers.get("x-cf-time") || "";
  const sig = request.headers.get("x-cf-sig") || "";
  if (!/^\d{10,}$/.test(ts) || Math.abs(Date.now() / 1000 - Number(ts)) > 300 || !sig) return false;
  const expected = await hmac(env.SHARED_SECRET, `${ts}\n${request.method} ${new URL(request.url).pathname}\n${body}`);
  return safeEqual(expected, sig.toLowerCase());
}
async function loadConfig(env: Env, force = false): Promise<CfConfig> {
  if (!force && configCache && Date.now() - configCache.at < META_TTL) return configCache.value;
  if (configPromise) return configPromise;
  configPromise = (async () => {
    const origin = env.ORIGIN_URL.replace(/\/$/, "");
    const ts = String(Math.floor(Date.now() / 1000));
    const sig = await hmac(env.SHARED_SECRET, `${ts}\nGET /api/cf/config\n`);
    const response = await fetch(`${origin}/api/cf/config`, { headers: { "x-cf-time": ts, "x-cf-sig": sig } });
    if (!response.ok) throw new Error(`Origin config request failed: HTTP ${response.status}`);
    const data = await response.json() as CfConfig;
    if (!data.api_id || !data.api_hash || !Array.isArray(data.bots) || !data.bots.length) throw new Error("Origin returned incomplete Telegram configuration");
    configCache = { value: data, at: Date.now() };
    return data;
  })();
  try { return await configPromise; } finally { configPromise = null; }
}
async function report(env: Env, installToken: string, bytes: number, request: Request, includeStart: boolean) {
  if (bytes <= 0 && !includeStart) return;
  const payload: any = {};
  if (bytes > 0) payload.usage = { [installToken]: bytes };
  if (includeStart) payload.starts = [{ token: installToken, ip: request.headers.get("cf-connecting-ip") || "", ua: request.headers.get("user-agent") || "" }];
  const body = JSON.stringify(payload);
  const ts = String(Math.floor(Date.now() / 1000));
  const sig = await hmac(env.SHARED_SECRET, `${ts}\nPOST /api/cf/usage\n${body}`);
  try {
    await fetch(`${env.ORIGIN_URL.replace(/\/$/, "")}/api/cf/usage`, { method: "POST", headers: { "content-type": "application/json", "x-cf-time": ts, "x-cf-sig": sig }, body });
  } catch { /* Usage reporting must never interrupt playback. */ }
}

async function resolveParts(decoded: any, config: CfConfig, env: Env): Promise<Part[]> {
  const isGlobal = !!decoded.global;
  const rawParts = Array.isArray(decoded.parts) ? decoded.parts : [decoded];
  const out: Part[] = [];
  for (const p of rawParts) {
    const chatId = normalizeChatId(Number(p.chat_id), isGlobal);
    const messageId = Number(p.msg_id);
    if (!Number.isSafeInteger(chatId) || !Number.isSafeInteger(messageId) || !messageId) throw new Error("Invalid Telegram message reference in stream id");
    const { client, document } = await getDocument(chatId, messageId, config, env, isGlobal);
    const size = Number(document.size);
    if (!Number.isSafeInteger(size) || size <= 0) throw new Error("Telegram returned an invalid file size");
    out.push({ chatId, messageId, size, client, document });
  }
  return out;
}
function totalSize(parts: Part[]) { return parts.reduce((n, p) => n + p.size, 0); }
async function* virtualRange(parts: Part[], start: number, end: number): AsyncGenerator<Uint8Array> {
  let base = 0;
  for (const p of parts) {
    const pEnd = base + p.size - 1;
    if (pEnd >= start && base <= end) {
      const localStart = Math.max(start, base) - base;
      const localEnd = Math.min(end, pEnd) - base;
      yield* downloadDocument(p.client, p.document, localStart, localEnd - localStart + 1);
    }
    base += p.size;
    if (base > end) break;
  }
}
async function readVirtual(parts: Part[], start: number, length: number): Promise<Uint8Array> {
  const chunks: Uint8Array[] = []; let got = 0;
  for await (const chunk of virtualRange(parts, start, start + length - 1)) { chunks.push(chunk); got += chunk.length; }
  const result = new Uint8Array(got); let offset = 0;
  for (const chunk of chunks) { result.set(chunk, offset); offset += chunk.length; }
  return result;
}
function parseRange(header: string | null, size: number) {
  if (!header) return { start: 0, end: size - 1 };
  if (!header.startsWith("bytes=") || header.includes(",")) return null;
  const m = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!m || (!m[1] && !m[2])) return null;
  let start: number, end: number;
  if (!m[1]) { const suffix = Number(m[2]); if (!suffix) return null; start = Math.max(0, size - suffix); end = size - 1; }
  else { start = Number(m[1]); end = m[2] ? Number(m[2]) : size - 1; }
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || start >= size || end < start) return null;
  return { start, end: Math.min(end, size - 1) };
}
function disposition(name: string) {
  const clean = (name || "video").replace(/[\r\n"\\]/g, "_").slice(0, 180);
  const ascii = clean.replace(/[^\x20-\x7e]/g, "_");
  return `inline; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(clean)}`;
}
function mimeFor(name: string, fallback: string) {
  const ext = (name.split(".").pop() || "").toLowerCase();
  const known: Record<string, string> = {
    mp4: "video/mp4", m4v: "video/mp4", m4a: "audio/mp4", mkv: "video/x-matroska",
    webm: "video/webm", mov: "video/quicktime", avi: "video/x-msvideo", ts: "video/mp2t",
    mp3: "audio/mpeg", m4b: "audio/mp4", flac: "audio/flac", ogg: "audio/ogg",
  };
  return known[ext] || (fallback === "application/zip" ? "application/octet-stream" : fallback || "application/octet-stream");
}

async function streamHandler(request: Request, env: Env, ctx: ExecutionContext, installToken: string, encodedId: string, fileName: string) {
  const url = new URL(request.url);
  const exp = Number(url.searchParams.get("e"));
  const sig = (url.searchParams.get("s") || "").toLowerCase();
  if (!Number.isSafeInteger(exp) || exp < Date.now() / 1000 || exp > Date.now() / 1000 + MAX_LINK_TTL + 60 || !/^[0-9a-f]{32}$/.test(sig)) return new Response("Expired or invalid stream link", { status: 403 });
  const expected = (await hmac(env.SHARED_SECRET, `/dl/${installToken}/${encodedId}:${exp}`)).slice(0, 32);
  if (!safeEqual(expected, sig)) return new Response("Invalid stream signature", { status: 403 });

  const decoded = await decodeStreamId(encodedId);
  const config = await loadConfig(env);
  const parts = await resolveParts(decoded, config, env);
  const archiveSize = totalSize(parts);
  let virtualOffset = 0, outputSize = archiveSize;
  if (decoded.zip) {
    const entry = await resolveZipEntry((start, length) => readVirtual(parts, start, length), archiveSize);
    if (!entry) return new Response("No streamable (stored) video found in ZIP", { status: 415 });
    virtualOffset = entry.offset; outputSize = entry.size;
  }
  const range = parseRange(request.headers.get("range"), outputSize);
  if (!range) return new Response(null, { status: 416, headers: { "Content-Range": `bytes */${outputSize}`, "Accept-Ranges": "bytes" } });
  const length = range.end - range.start + 1;
  const headers = new Headers({
    "content-type": mimeFor(fileName, parts[0]?.document?.mimeType || "application/octet-stream"),
    "content-disposition": disposition(fileName),
    "content-length": String(length),
    "accept-ranges": "bytes",
    "cache-control": "private, max-age=0, no-store",
    "access-control-allow-origin": "*",
    "access-control-expose-headers": "Content-Length, Content-Range, Accept-Ranges, Content-Type",
  });
  if (request.method === "HEAD") {
    if (request.headers.has("range")) headers.set("content-range", `bytes ${range.start}-${range.end}/${outputSize}`);
    return new Response(null, { status: request.headers.has("range") ? 206 : 200, headers });
  }
  if (request.headers.has("range")) headers.set("content-range", `bytes ${range.start}-${range.end}/${outputSize}`);

  let sent = 0, reportedBytes = 0, startedReported = false, lastReport = Date.now(), finished = false;
  if (!startedReported) { runtimeMetrics.streams += 1; runtimeMetrics.lastStreamAt = Date.now(); }
  const flush = () => {
    const delta = sent - reportedBytes;
    const includeStart = !startedReported;
    if (delta <= 0 && !includeStart) return;
    reportedBytes = sent; startedReported = true; lastReport = Date.now();
    ctx.waitUntil(report(env, installToken, delta, request, includeStart));
  };
  const finish = () => { if (!finished) { finished = true; flush(); } };
  const iterator = virtualRange(parts, virtualOffset + range.start, virtualOffset + range.end);
  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const next = await iterator.next();
        if (next.done) { controller.close(); finish(); return; }
        sent += next.value.byteLength;
        runtimeMetrics.bytes += next.value.byteLength;
        controller.enqueue(next.value);
        if (Date.now() - lastReport >= 30_000) flush();
      } catch (error) { controller.error(error); finish(); }
    },
    async cancel() { try { await iterator.return(undefined); } catch { /* ignore */ } finish(); },
  });
  return new Response(body, { status: request.headers.has("range") ? 206 : 200, headers });
}

const dashboardHtml = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="theme-color" content="#090d18"><title>Caitlin Stream · Edge Dashboard</title>
<style>
:root{color-scheme:dark;--bg:#090d18;--panel:#111827;--line:#263247;--muted:#93a4bd;--text:#edf4ff;--blue:#70a7ff;--green:#55d6a0;--amber:#ffc76b}*{box-sizing:border-box}body{margin:0;background:radial-gradient(ellipse at 12% 0%,#172b49 0,transparent 38%),var(--bg);color:var(--text);font:15px/1.5 Inter,ui-sans-serif,system-ui,-apple-system,Segoe UI,sans-serif}.wrap{max-width:1050px;margin:auto;padding:34px 20px 70px}.top{display:flex;align-items:center;justify-content:space-between;gap:20px;margin-bottom:28px}.brand{display:flex;align-items:center;gap:13px}.logo{width:44px;height:44px;border-radius:14px;background:linear-gradient(135deg,#60a5fa,#6366f1);display:grid;place-items:center;font-size:22px;font-weight:900;color:white}.eyebrow{color:var(--blue);font-size:11px;font-weight:800;letter-spacing:.16em;text-transform:uppercase}.title{font-size:25px;font-weight:800;letter-spacing:-.04em}.sub{color:var(--muted);font-size:13px}.pill{border:1px solid #245b49;background:#10291f;color:var(--green);border-radius:999px;padding:7px 12px;font-size:12px;font-weight:700}.grid{display:grid;grid-template-columns:repeat(12,1fr);gap:15px}.card{background:linear-gradient(145deg,#141e2e,#0f1725);border:1px solid var(--line);border-radius:18px;padding:20px;min-width:0}.span-12{grid-column:span 12}.span-8{grid-column:span 8}.span-4{grid-column:span 4}.span-6{grid-column:span 6}h2{font-size:15px;margin:0 0 5px}p{margin:0;color:var(--muted)}.metric{font-size:27px;font-weight:800;letter-spacing:-.04em;margin-top:13px}.metric-label{font-size:12px;color:var(--muted)}.row{display:flex;align-items:center;justify-content:space-between;gap:12px}.field{margin-top:16px}.field label{display:block;font-size:12px;color:var(--muted);margin-bottom:7px}.value{display:flex;gap:8px}.value input,input[type=password]{width:100%;min-width:0;border:1px solid #34435b;background:#0a1220;color:var(--text);border-radius:10px;padding:12px;font:13px ui-monospace,monospace}.btn{border:1px solid #3b5272;background:#1b2b43;color:var(--text);border-radius:10px;padding:10px 13px;font-weight:700;cursor:pointer;white-space:nowrap}.btn.primary{background:#2563eb;border-color:#3b82f6}.btn:disabled{opacity:.5;cursor:wait}.actions{display:flex;flex-wrap:wrap;gap:9px;margin-top:16px}.note{font-size:12px;color:var(--muted);margin-top:12px}.status{display:inline-flex;align-items:center;gap:8px;font-size:12px;color:var(--green);font-weight:700}.dot{width:8px;height:8px;border-radius:50%;background:var(--green);box-shadow:0 0 12px #55d6a0}.warning{color:var(--amber)}.steps{display:grid;grid-template-columns:repeat(3,1fr);gap:12px;margin-top:14px}.step{background:#0b1422;border:1px solid var(--line);border-radius:12px;padding:13px;font-size:12px;color:var(--muted)}.step b{display:block;color:var(--text);font-size:13px;margin-bottom:5px}.hidden{display:none!important}#login{max-width:460px;margin:9vh auto}.err{color:#ff9d9d;font-size:12px;margin-top:8px;min-height:18px}a{color:var(--blue)}@media(max-width:720px){.span-8,.span-4,.span-6{grid-column:span 12}.steps{grid-template-columns:1fr}.top{align-items:flex-start;flex-direction:column}.wrap{padding:24px 14px 50px}}
</style></head><body><main class="wrap">
<section id="login" class="card"><div class="brand"><div class="logo">C</div><div><div class="eyebrow">Caitlin Stream</div><div class="title">Edge dashboard</div></div></div><p style="margin:15px 0">Enter the Worker shared secret to unlock this private dashboard. It is not stored by this page.</p><div class="field"><label for="secret">Worker shared secret</label><input id="secret" type="password" autocomplete="current-password" placeholder="Paste SHARED_SECRET"></div><div class="actions"><button class="btn primary" id="unlock">Unlock dashboard</button></div><div class="err" id="loginerr"></div></section>
<div id="app" class="hidden"><header class="top"><div class="brand"><div class="logo">C</div><div><div class="eyebrow">Caitlin Stream / Cloudflare</div><div class="title">Edge streaming dashboard</div><div class="sub">Worker control panel · live diagnostics</div></div></div><div class="pill"><span class="dot" style="display:inline-block;margin-right:7px"></span>Worker dashboard unlocked</div></header>
<div class="grid">
<section class="card span-4"><div class="row"><h2>Worker status</h2><span class="status"><span class="dot"></span>Online</span></div><div class="metric" id="uptime">—</div><div class="metric-label">This isolate uptime</div></section>
<section class="card span-4"><h2>Stream requests</h2><div class="metric" id="streams">0</div><div class="metric-label">Since this isolate started</div></section>
<section class="card span-4"><h2>Bytes relayed</h2><div class="metric" id="bytes">0 B</div><div class="metric-label">Since this isolate started</div></section>
<section class="card span-8"><div class="row"><div><h2>App integration</h2><p>Copy these values into Caitlin Stream → Settings → Cloudflare Streaming.</p></div><button class="btn" id="copyall">Copy both</button></div>
<div class="field"><label>Worker URL</label><div class="value"><input id="workerurl" readonly><button class="btn copy" data-copy="workerurl">Copy</button></div></div>
<div class="field"><label>Shared Secret · SHARED_SECRET</label><div class="value"><input id="workersecret" readonly type="password"><button class="btn" id="reveal">Show</button><button class="btn copy" data-copy="workersecret">Copy</button></div></div>
<div class="field"><label>Worker ID / name</label><div class="value"><input id="workerid" readonly><button class="btn copy" data-copy="workerid">Copy</button></div></div>
<div class="note">The app currently asks for Worker URL and Shared Secret. Worker ID is shown for Cloudflare-side identification; it is not a separate app setting.</div>
</section>
<section class="card span-4"><div class="row"><h2>Origin connection</h2><span id="originstate" class="warning">Not checked</span></div><div class="metric" id="botcount">—</div><div class="metric-label">Telegram bots returned by the app</div><div class="actions"><button class="btn primary" id="check">Test app connection</button></div><div class="note" id="checkdetail">Tests the signed config endpoint using the same credentials as playback.</div></section>
<section class="card span-12"><h2>Traffic path</h2><p>Video payloads are fetched from Telegram by this Worker and sent directly from Cloudflare to the player. The Caitlin Stream VPS is used only for signed bot configuration and small usage/start reports — not for video bytes.</p><div class="steps"><div class="step"><b>1 · Player</b>Requests the signed Cloudflare stream URL.</div><div class="step"><b>2 · Cloudflare Worker</b>Reads Telegram media over MTProto and relays byte ranges to the player.</div><div class="step"><b>3 · Caitlin Stream VPS</b>Provides bot metadata and receives usage counters only. It does not proxy the media body.</div></div><p class="note warning">Counters on this page are isolate-local diagnostics, not account-wide Cloudflare billing analytics. Cloudflare Free has usage quotas; it is not unlimited bandwidth.</p></section>
<section class="card span-12"><div class="row"><div><h2>Quick setup</h2><p>After copying the integration values, save settings in the app.</p></div><button class="btn" id="logout">Lock dashboard</button></div><div class="steps"><div class="step"><b>Worker URL</b>Paste the URL shown above into the app's Worker URL field.</div><div class="step"><b>Shared Secret</b>Paste the exact same secret into the app's Shared Secret field.</div><div class="step"><b>Stremio Links</b>Choose Both first, test playback and seeking, then switch to Cloudflare only.</div></div></section>
</div></div></main>
<script>
let secret='';const $=id=>document.getElementById(id);const fmt=n=>{if(n<1024)return n+' B';const u=['KB','MB','GB','TB'];let i=-1;do{n/=1024;i++}while(n>=1024&&i<u.length-1);return n.toFixed(2)+' '+u[i]};
async function api(path){const r=await fetch(path,{headers:{authorization:'Bearer '+secret}});const d=await r.json().catch(()=>({}));if(!r.ok)throw new Error(d.error||('HTTP '+r.status));return d}
async function unlock(){secret=$('secret').value.trim();if(!secret){$('loginerr').textContent='Enter the shared secret.';return}try{const d=await api('/dashboard/api/overview');$('login').classList.add('hidden');$('app').classList.remove('hidden');$('workerurl').value=location.origin;$('workersecret').value=secret;$('workerid').value=d.workerId;$('streams').textContent=d.metrics.streams.toLocaleString();$('bytes').textContent=fmt(d.metrics.bytes);$('uptime').textContent=d.metrics.uptime;$('secret').value='';}catch(e){secret='';$('loginerr').textContent='Access denied: '+e.message}}
$('unlock').onclick=unlock;$('secret').addEventListener('keydown',e=>{if(e.key==='Enter')unlock()});$('logout').onclick=()=>{secret='';$('app').classList.add('hidden');$('login').classList.remove('hidden');$('workersecret').value='';$('secret').value=''};
$('reveal').onclick=()=>{$('workersecret').type=$('workersecret').type==='password'?'text':'password';$('reveal').textContent=$('workersecret').type==='password'?'Show':'Hide'};
async function copy(id){await navigator.clipboard.writeText($(id).value);const b=document.querySelector('[data-copy="'+id+'"]');if(b){const old=b.textContent;b.textContent='Copied';setTimeout(()=>b.textContent=old,1200)}}
document.querySelectorAll('.copy').forEach(b=>b.onclick=()=>copy(b.dataset.copy));$('copyall').onclick=async()=>{await navigator.clipboard.writeText('Worker URL: '+$('workerurl').value+'\nShared Secret: '+secret+'\nWorker ID: '+$('workerid').value);$('copyall').textContent='Copied';setTimeout(()=>$('copyall').textContent='Copy both',1200)};
$('check').onclick=async()=>{const b=$('check');b.disabled=true;b.textContent='Checking…';try{const d=await api('/dashboard/api/check');$('originstate').textContent='Connected';$('originstate').className='status';$('botcount').textContent=d.bots;$('checkdetail').textContent='Signed app config verified · '+d.bots+' bot(s) available · checked '+new Date().toLocaleTimeString()}catch(e){$('originstate').textContent='Failed';$('originstate').className='warning';$('checkdetail').textContent=e.message}finally{b.disabled=false;b.textContent='Test app connection'}};
</script></body></html>`;
function dashboardUnauthorized() { return json({ ok: false, error: "dashboard_auth_required" }, 401); }
function dashboardAuthorized(request: Request, env: Env) {
  const header = request.headers.get("authorization") || "";
  const supplied = header.startsWith("Bearer ") ? header.slice(7) : "";
  return !!supplied && safeEqual(supplied, env.SHARED_SECRET);
}
function formatUptime(ms: number) {
  const sec = Math.floor(ms / 1000), days = Math.floor(sec / 86400), hours = Math.floor(sec % 86400 / 3600), mins = Math.floor(sec % 3600 / 60);
  return days ? `${days}d ${hours}h` : hours ? `${hours}h ${mins}m` : `${mins}m`;
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    try {
      const url = new URL(request.url);
      if (url.pathname === "/" || url.pathname === "/dashboard") return new Response(dashboardHtml, { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "x-content-type-options": "nosniff", "referrer-policy": "no-referrer" } });
      if (url.pathname === "/healthz" || url.pathname === "/status") return json({ ok: true, service: "Caitlin Stream Cloudflare Proxy", version: "1.1.0" });
      if (url.pathname === "/dashboard/api/overview" && request.method === "GET") {
        if (!dashboardAuthorized(request, env)) return dashboardUnauthorized();
        return json({ ok: true, workerId: env.WORKER_ID || "caitlin-stremio-proxy", workerUrl: url.origin, metrics: { streams: runtimeMetrics.streams, bytes: runtimeMetrics.bytes, uptime: formatUptime(Date.now() - runtimeMetrics.startedAt), lastStreamAt: runtimeMetrics.lastStreamAt || null, scope: "isolate-local" } });
      }
      if (url.pathname === "/dashboard/api/check" && request.method === "GET") {
        if (!dashboardAuthorized(request, env)) return dashboardUnauthorized();
        const config = await loadConfig(env, true);
        return json({ ok: true, bots: config.bots.length, checkedAt: new Date().toISOString() });
      }
      if (url.pathname === "/api/sync" && request.method === "POST") {
        const body = await request.text();
        if (!(await verifyAppRequest(request, env, body))) return json({ ok: false, error: "bad_signature" }, 401);
        configCache = null;
        invalidateClients();
        const config = await loadConfig(env, true);
        return json({ ok: true, bots: config.bots.length });
      }
      if ((url.pathname.startsWith("/dl/") && (request.method === "GET" || request.method === "HEAD"))) {
        const parts = url.pathname.split("/");
        if (parts.length < 5) return new Response("Bad stream URL", { status: 400 });
        const token = decodeURIComponent(parts[2]);
        const encodedId = parts[3];
        const name = decodeURIComponent(parts.slice(4).join("/")) || "video";
        return await streamHandler(request, env, ctx, token, encodedId, name);
      }
      if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: { "access-control-allow-origin": "*", "access-control-allow-methods": "GET, HEAD, OPTIONS", "access-control-allow-headers": "Range, Content-Type" } });
      return new Response("Not Found", { status: 404 });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown Worker error";
      return new Response(`Cloudflare stream error: ${message}`, { status: 502, headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" } });
    }
  },
};
