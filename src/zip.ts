function u16(b: Uint8Array, o: number) { return b[o] | (b[o + 1] << 8); }
function u32(b: Uint8Array, o: number) { return (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0; }
function u64(b: Uint8Array, o: number): number { const n = BigInt(u32(b, o)) | (BigInt(u32(b, o + 4)) << 32n); return Number(n); }
function zip64(extra: Uint8Array, uncomp: number, comp: number, offset = 0) {
  for (let i = 0; i + 4 <= extra.length;) {
    const id = u16(extra, i), size = u16(extra, i + 2), body = i + 4;
    if (id === 1) {
      let p = body;
      if (uncomp === 0xffffffff) { uncomp = u64(extra, p); p += 8; }
      if (comp === 0xffffffff) { comp = u64(extra, p); p += 8; }
      if (offset === 0xffffffff) offset = u64(extra, p);
      break;
    }
    i += 4 + size;
  }
  return { uncomp, comp, offset };
}
function localHeader(b: Uint8Array) {
  if (b.length < 30 || u32(b, 0) !== 0x04034b50) return null;
  const flags = u16(b, 6), method = u16(b, 8);
  let comp = u32(b, 18), size = u32(b, 22);
  const nl = u16(b, 26), el = u16(b, 28), extra = b.slice(30 + nl, 30 + nl + el);
  if (size === 0xffffffff || comp === 0xffffffff) ({ uncomp: size, comp } = zip64(extra, size, comp));
  return { method, size, comp, offset: 30 + nl + el, descriptor: !!(flags & 8) };
}
export async function resolveZipEntry(read: (start: number, length: number) => Promise<Uint8Array>, total: number) {
  const head = await read(0, Math.min(65536, total));
  const lh = localHeader(head);
  if (lh && lh.method === 0 && !lh.descriptor && lh.size > 0 && lh.offset + lh.size <= total) return { offset: lh.offset, size: lh.size };
  const tailLen = Math.min(262144, total), tail = await read(total - tailLen, tailLen);
  let eocd = -1;
  for (let i = tail.length - 22; i >= 0; i--) if (u32(tail, i) === 0x06054b50) { eocd = i; break; }
  if (eocd < 0) return null;
  let cdOffset = u32(tail, eocd + 16);
  if (cdOffset === 0xffffffff) {
    let loc = -1;
    for (let i = tail.length - 20; i >= 0; i--) if (u32(tail, i) === 0x07064b50) { loc = i; break; }
    if (loc >= 0) {
      const zoff = u64(tail, loc + 8) - (total - tailLen);
      if (zoff >= 0 && u32(tail, zoff) === 0x06064b50) cdOffset = u64(tail, zoff + 48);
    }
  }
  const rel = cdOffset - (total - tailLen);
  if (rel < 0 || rel + 46 > tail.length || u32(tail, rel) !== 0x02014b50) return lh?.method === 0 && lh.size > 0 ? { offset: lh.offset, size: lh.size } : null;
  const method = u16(tail, rel + 10);
  let comp = u32(tail, rel + 20), size = u32(tail, rel + 24), local = u32(tail, rel + 42);
  const nl = u16(tail, rel + 28), el = u16(tail, rel + 30), extra = tail.slice(rel + 46 + nl, rel + 46 + nl + el);
  if (size === 0xffffffff || comp === 0xffffffff || local === 0xffffffff) ({ uncomp: size, comp, offset: local } = zip64(extra, size, comp, local));
  if (method !== 0 || size <= 0 || local < 0 || local >= total) return null;
  const innerHead = await read(local, Math.min(4096, total - local));
  const inner = localHeader(innerHead);
  if (!inner) return null;
  const offset = local + inner.offset;
  return offset + size <= total ? { offset, size } : null;
}
