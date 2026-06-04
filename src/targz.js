// Minimal gzip + tar reading, using only browser-native APIs.

/** Gunzip an ArrayBuffer/Uint8Array via the native DecompressionStream. */
export async function gunzip(buf) {
  const ds = new DecompressionStream('gzip');
  const stream = new Blob([buf]).stream().pipeThrough(ds);
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

export function isGzip(bytes) {
  return bytes.length > 2 && bytes[0] === 0x1f && bytes[1] === 0x8b;
}

const td = new TextDecoder();

function readStr(bytes, off, len) {
  let end = off;
  const stop = off + len;
  while (end < stop && bytes[end] !== 0) end++;
  return td.decode(bytes.subarray(off, end));
}

function readOctal(bytes, off, len) {
  const s = readStr(bytes, off, len).trim();
  if (!s) return 0;
  // GNU base-256 extension for large sizes.
  if (bytes[off] & 0x80) {
    let v = bytes[off] & 0x7f;
    for (let i = 1; i < len; i++) v = v * 256 + bytes[off + i];
    return v;
  }
  return parseInt(s, 8) || 0;
}

/**
 * Parse a tar archive (already decompressed).
 * Returns [{name, data: Uint8Array}], regular files only.
 */
export function untar(bytes) {
  const files = [];
  let off = 0;
  let longName = null;
  let paxPath = null;
  while (off + 512 <= bytes.length) {
    // End of archive: two zero blocks (or just zero padding).
    if (bytes[off] === 0) {
      let allZero = true;
      for (let i = 0; i < 512; i++) if (bytes[off + i] !== 0) { allZero = false; break; }
      if (allZero) { off += 512; continue; }
    }
    const name = readStr(bytes, off, 100);
    const size = readOctal(bytes, off + 124, 12);
    const type = bytes[off + 156];
    const prefix = readStr(bytes, off + 345, 155);
    const dataStart = off + 512;
    const dataEnd = dataStart + size;
    if (dataEnd > bytes.length) break;
    const data = bytes.subarray(dataStart, dataEnd);
    const typeCh = String.fromCharCode(type || 0x30);

    if (typeCh === 'L') {                       // GNU long name
      longName = td.decode(data).replace(/\0+$/, '');
    } else if (typeCh === 'x' || typeCh === 'g') { // pax header
      const text = td.decode(data);
      for (const line of text.split('\n')) {
        const m = line.match(/^\d+ path=(.*)$/);
        if (m && typeCh === 'x') paxPath = m[1];
      }
    } else if (typeCh === '0' || typeCh === '\0' || type === 0) { // regular file
      let fullName = paxPath ?? longName ?? (prefix ? prefix + '/' + name : name);
      longName = null; paxPath = null;
      if (fullName && size >= 0) files.push({ name: fullName, data });
    } else {
      longName = null; paxPath = null;          // dirs, links, … skipped
    }
    off = dataStart + Math.ceil(size / 512) * 512;
  }
  return files;
}
