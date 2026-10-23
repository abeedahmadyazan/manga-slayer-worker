function dimensions(width: number, height: number): void {
  if (!width || !height || width > 4096 || height > 4096 || width * height > 16_000_000) throw new Error("invalid_image_size");
}
function join(parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let offset = 0;
  for (const part of parts) {out.set(part, offset); offset += part.length;}
  return out;
}
/** Strip location/EXIF/comments and enforce dimensions without decompressing pixels. */
export function sanitizeAvatar(bytes: Uint8Array, type: string): Uint8Array {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const ascii = (start: number, size: number) => new TextDecoder().decode(bytes.slice(start, start + size));
  if (type === "image/png" && bytes.length >= 33 && ascii(1, 3) === "PNG" && bytes[0] === 137 && bytes[4] === 13 && bytes[5] === 10 && bytes[6] === 26 && bytes[7] === 10) {
    const parts = [bytes.slice(0, 8)];
    let offset = 8, image = false, header = false;
    while (offset + 12 <= bytes.length) {
      const length = view.getUint32(offset), tag = ascii(offset + 4, 4), end = offset + 12 + length;
      if (end > bytes.length) throw new Error("invalid_image");
      if (!header) {
        if (tag !== "IHDR" || length !== 13) throw new Error("invalid_image");
        dimensions(view.getUint32(offset + 8), view.getUint32(offset + 12)); header = true;
      } else if (tag === "IHDR") throw new Error("invalid_image");
      if (tag === "IDAT") image = true;
      if (["IHDR", "PLTE", "tRNS", "IDAT", "IEND"].includes(tag)) parts.push(bytes.slice(offset, end));
      if (tag === "IEND") {
        if (length !== 0 || !image) throw new Error("invalid_image");
        return join(parts);
      }
      offset = end;
    }
  } else if (type === "image/jpeg" && bytes[0] === 255 && bytes[1] === 216) {
    const parts = [bytes.slice(0, 2)];
    let offset = 2, sized = false;
    while (offset + 4 <= bytes.length) {
      if (bytes[offset] !== 255) throw new Error("invalid_image");
      const marker = bytes[offset + 1], length = view.getUint16(offset + 2), end = offset + 2 + length;
      if (length < 2 || end > bytes.length) throw new Error("invalid_image");
      if ([192, 193, 194].includes(marker)) { if (length < 8) throw new Error("invalid_image"); dimensions(view.getUint16(offset + 7), view.getUint16(offset + 5)); sized = true; }
      if (marker === 218) {
        if (!sized) throw new Error("invalid_image");
        let tail = end;
        while (tail + 1 < bytes.length && !(bytes[tail] === 255 && bytes[tail + 1] === 217)) tail++;
        if (tail + 1 >= bytes.length) throw new Error("invalid_image");
        parts.push(bytes.slice(offset, tail + 2)); return join(parts);
      }
      if (!(marker >= 224 && marker <= 239) && marker !== 254) parts.push(bytes.slice(offset, end));
      offset = end;
    }
  } else if (type === "image/webp" && bytes.length >= 30 && ascii(0, 4) === "RIFF" && ascii(8, 4) === "WEBP") {
    const parts: Uint8Array[] = [];
    let offset = 12, sized = false, image = false;
    while (offset + 8 <= bytes.length) {
      const tag = ascii(offset, 4), length = view.getUint32(offset + 4, true), end = offset + 8 + length + (length % 2);
      if (end > bytes.length) throw new Error("invalid_image");
      let part = bytes.slice(offset, end);
      if (tag === "VP8X") {
        if (length < 10 || (bytes[offset + 8] & 2)) throw new Error("animated_avatar_not_supported");
        const u24 = (p: number) => bytes[p] + bytes[p + 1] * 256 + bytes[p + 2] * 65536;
        dimensions(u24(offset + 12) + 1, u24(offset + 15) + 1); sized = true;
        part[8] &= ~(0x20 | 0x08 | 0x04);
      } else if (tag === "VP8 ") {
        if (length < 10 || bytes[offset + 11] !== 157 || bytes[offset + 12] !== 1 || bytes[offset + 13] !== 42) throw new Error("invalid_image");
        dimensions(view.getUint16(offset + 14, true) & 0x3fff, view.getUint16(offset + 16, true) & 0x3fff); sized = true; image = true;
      } else if (tag === "VP8L") {
        if (length < 5 || bytes[offset + 8] !== 47) throw new Error("invalid_image");
        const bits = view.getUint32(offset + 9, true); dimensions((bits & 0x3fff) + 1, ((bits >>> 14) & 0x3fff) + 1); sized = true; image = true;
      }
      if (["VP8X", "VP8 ", "VP8L", "ALPH"].includes(tag)) parts.push(part);
      offset = end;
    }
    if (sized && image && offset === bytes.length) {
      const output = join([bytes.slice(0, 12), ...parts]); new DataView(output.buffer).setUint32(4, output.length - 8, true); return output;
    }
  }
  throw new Error("invalid_image");
}
