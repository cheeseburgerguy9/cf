const ALPHABET = "0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ";

function base62Decode(value: string): Uint8Array {
  let n = 0n;
  for (const ch of value) {
    const digit = ALPHABET.indexOf(ch);
    if (digit < 0) throw new Error("Invalid encoded stream id");
    n = n * 62n + BigInt(digit);
  }
  let hex = n.toString(16);
  if (hex.length % 2) hex = `0${hex}`;
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i++) bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  // Python int.to_bytes() preserves leading zero bytes only if they were present in the input.
  // The zlib stream starts with a non-zero header, so this representation is lossless.
  return bytes;
}

async function inflateZlib(data: Uint8Array): Promise<string> {
  const stream = new Blob([data]).stream().pipeThrough(new DecompressionStream("deflate"));
  return new Response(stream).text();
}

export async function decodeStreamId(value: string): Promise<any> {
  const compressed = base62Decode(value);
  return JSON.parse(await inflateZlib(compressed));
}

export function normalizeChatId(raw: number, global = false): number {
  if (global || raw < 0) return raw;
  return Number(`-100${raw}`);
}
