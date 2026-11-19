import { TelegramClient, Api } from "telegram";
import { StringSession } from "telegram/sessions";
import bigInt from "big-integer";
import { Buffer } from "node:buffer";

export interface WorkerEnv {
  ORIGIN_URL: string;
  SHARED_SECRET: string;
  WORKER_ID?: string;
  SESSIONS: KVNamespace;
}

export interface CfConfig {
  api_id: number;
  api_hash: string;
  bots: string[];
  user_session?: string;
}

const clients = new Map<string, Promise<TelegramClient>>();
let nextBot = 0;

async function digest(data: string): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(data)));
}

async function aesKey(secret: string): Promise<CryptoKey> {
  const raw = await digest(`caitlin-cf-session-v1:${secret}`);
  return crypto.subtle.importKey("raw", raw, "AES-GCM", false, ["encrypt", "decrypt"]);
}

async function encryptSession(value: string, secret: string): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const cipher = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, await aesKey(secret), new TextEncoder().encode(value)));
  const all = new Uint8Array(iv.length + cipher.length);
  all.set(iv); all.set(cipher, iv.length);
  return btoa(String.fromCharCode(...all));
}

async function decryptSession(value: string, secret: string): Promise<string | null> {
  try {
    const all = Uint8Array.from(atob(value), c => c.charCodeAt(0));
    const plain = await crypto.subtle.decrypt({ name: "AES-GCM", iv: all.slice(0, 12) }, await aesKey(secret), all.slice(12));
    return new TextDecoder().decode(plain);
  } catch { return null; }
}

async function tokenKey(token: string): Promise<string> {
  const h = await digest(token);
  return `gramjs:${Array.from(h).map(x => x.toString(16).padStart(2, "0")).join("")}`;
}

function pyrogramSessionToGramJs(value: string): string {
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
  const raw = Uint8Array.from(atob(normalized + "=".repeat((4 - normalized.length % 4) % 4)), c => c.charCodeAt(0));
  let dc: number, authKey: Uint8Array;
  if (raw.length === 271) {
    // Current Pyrogram format: >BI?256sQ? (the 64-bit variant is 356 bytes).
    dc = raw[0]; authKey = raw.slice(6, 262);
  } else if (raw.length === 263 || raw.length === 267) {
    // Legacy Pyrogram format: >B?256sI? / >B?256sQ?.
    dc = raw[0]; authKey = raw.slice(2, 258);
  } else {
    throw new Error(`Unsupported Telegram user session format (${raw.length} bytes)`);
  }
  const addresses: Record<number, string> = {
    1: "149.154.175.53", 2: "149.154.167.51", 3: "149.154.175.100",
    4: "149.154.167.91", 5: "91.108.56.130",
  };
  const address = addresses[dc];
  if (!address || authKey.length !== 256) throw new Error("Invalid Telegram user session DC/auth key");
  const host = new TextEncoder().encode(address);
  const packed = new Uint8Array(1 + 2 + host.length + 2 + 256);
  let p = 0; packed[p++] = dc;
  packed[p++] = (host.length >> 8) & 255; packed[p++] = host.length & 255;
  packed.set(host, p); p += host.length;
  packed[p++] = 1; packed[p++] = 187; // TCP port 443
  packed.set(authKey, p);
  let binary = ""; for (const b of packed) binary += String.fromCharCode(b);
  return `1${btoa(binary)}`;
}

async function userClientFor(config: CfConfig, env: WorkerEnv): Promise<TelegramClient | null> {
  if (!config.user_session) return null;
  const token = "__user_session__";
  const cached = clients.get(token);
  if (cached) return cached;
  const pending = (async () => {
    const key = await tokenKey(token);
    const encrypted = await env.SESSIONS.get(key);
    const saved = encrypted ? await decryptSession(encrypted, env.SHARED_SECRET) : null;
    const gramSession = saved || pyrogramSessionToGramJs(config.user_session!);
    const client = new TelegramClient(new StringSession(gramSession), Number(config.api_id), config.api_hash, {
      connectionRetries: 5, useWSS: true, autoReconnect: true, maxConcurrentDownloads: 4,
    } as any);
    client.setLogLevel("none" as any);
    await client.connect();
    await client.getMe();
    await client.getDialogs({ limit: 1000 } as any);
    if (!saved) await env.SESSIONS.put(key, await encryptSession((client.session as StringSession).save(), env.SHARED_SECRET));
    return client;
  })();
  clients.set(token, pending);
  try { return await pending; } catch (e) { clients.delete(token); throw e; }
}

async function clientFor(token: string, config: CfConfig, env: WorkerEnv): Promise<TelegramClient> {
  const cached = clients.get(token);
  if (cached) return cached;
  const pending = (async () => {
    const key = await tokenKey(token);
    const encrypted = await env.SESSIONS.get(key);
    const saved = encrypted ? await decryptSession(encrypted, env.SHARED_SECRET) : null;
    const client = new TelegramClient(new StringSession(saved || ""), Number(config.api_id), config.api_hash, {
      connectionRetries: 5,
      useWSS: true,
      autoReconnect: true,
      maxConcurrentDownloads: 4,
    } as any);
    client.setLogLevel("none" as any);
    if (saved) {
      await client.connect();
      await client.getMe();
      await client.getDialogs({ limit: 1000 } as any);
    } else {
      await client.start({ botAuthToken: token } as any);
      await client.getDialogs({ limit: 1000 } as any);
      const session = (client.session as StringSession).save();
      await env.SESSIONS.put(key, await encryptSession(session, env.SHARED_SECRET));
    }
    return client;
  })();
  clients.set(token, pending);
  try { return await pending; }
  catch (e) { clients.delete(token); throw e; }
}

export async function getDocument(chatId: number, messageId: number, config: CfConfig, env: WorkerEnv, preferUser = false) {
  if (preferUser && config.user_session) {
    try {
      const client = await userClientFor(config, env);
      if (client) {
        const messages = await client.getMessages(chatId, { ids: [messageId] } as any);
        const document = (messages?.[0] as any)?.media?.document;
        if (document) return { client, document, botToken: "userbot" };
      }
    } catch (e) { /* public/authorized bot pool is the fallback */ }
  }
  const bots = (config.bots || []).filter(Boolean);
  if (!bots.length) throw new Error("No bot tokens were returned by /api/cf/config");
  const start = nextBot++ % bots.length;
  let lastError: unknown;
  for (let i = 0; i < bots.length; i++) {
    const token = bots[(start + i) % bots.length];
    try {
      const client = await clientFor(token, config, env);
      const messages = await client.getMessages(chatId, { ids: [messageId] } as any);
      const message = messages?.[0] as any;
      const document = message?.media?.document;
      if (!document) throw new Error(`Message ${messageId} has no downloadable document`);
      return { client, document, botToken: token };
    } catch (e) { lastError = e; }
  }
  throw lastError instanceof Error ? lastError : new Error("All configured Telegram bots failed to read the message");
}

export async function* downloadDocument(client: TelegramClient, document: any, offset: number, length: number): AsyncGenerator<Uint8Array> {
  if (length <= 0) return;
  const location = new Api.InputDocumentFileLocation({
    id: document.id,
    accessHash: document.accessHash,
    fileReference: Buffer.from(document.fileReference),
    thumbSize: "",
  });
  const iterator = client.iterDownload({
    file: location,
    offset: bigInt(offset),
    limit: bigInt(length),
    requestSize: 512 * 1024,
    chunkSize: 512 * 1024,
  } as any);
  let remaining = length;
  try {
    for await (const part of iterator as any) {
      if (remaining <= 0) break;
      const bytes = Buffer.from(part);
      const out = bytes.length > remaining ? bytes.subarray(0, remaining) : bytes;
      if (out.length) { remaining -= out.length; yield new Uint8Array(out); }
    }
    if (remaining > 0) throw new Error(`Telegram returned an incomplete range (${length - remaining}/${length} bytes)`);
  } finally {
    try { await (iterator as any).return?.(); } catch { /* stream already closed */ }
  }
}

export function invalidateClients() {
  for (const p of clients.values()) p.then(c => c.disconnect()).catch(() => undefined);
  clients.clear();
  nextBot = 0;
}
