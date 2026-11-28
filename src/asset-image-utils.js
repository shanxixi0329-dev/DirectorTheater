'use strict';
const { createHash } = require('node:crypto');
const { inflateSync, deflateSync, crc32 } = require('node:zlib');

const signature = Buffer.from('89504e470d0a1a0a', 'hex');
const channels = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 };
const depths = { 0: [1, 2, 4, 8, 16], 2: [8, 16], 3: [1, 2, 4, 8], 4: [8, 16], 6: [8, 16] };
const adam7 = [[0,0,8,8],[4,0,8,8],[0,4,4,8],[2,0,4,4],[0,2,2,4],[1,0,2,2],[0,1,1,2]];
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
function check(condition) { if (!condition) throw new Error('无效或超限的 PNG 图像'); }

function inspectPng(bytes) {
  check(Buffer.isBuffer(bytes) && bytes.length >= 45 && bytes.length <= 128 * 1024 ** 2 && bytes.subarray(0,8).equals(signature));
  let width, height, depth, type, interlace, palette = 0, transparent = false, end = false, afterData = false;
  const compressed = [];
  for (let pos = 8; pos < bytes.length;) {
    check(pos + 12 <= bytes.length);
    const size = bytes.readUInt32BE(pos), next = pos + 12 + size;
    check(next <= bytes.length && crc32(bytes.subarray(pos + 4, next - 4)) === bytes.readUInt32BE(next - 4));
    const name = bytes.toString('ascii', pos + 4, pos + 8), data = bytes.subarray(pos + 8, next - 4);
    check(pos !== 8 || name === 'IHDR');
    if (compressed.length && name !== 'IDAT') afterData = true;
    switch (name) {
      case 'IHDR':
        check(pos === 8 && size === 13);
        width = data.readUInt32BE(0); height = data.readUInt32BE(4); depth = data[8]; type = data[9]; interlace = data[12];
        check(width > 0 && height > 0 && width * height <= 32 * 1024 ** 2 && depths[type]?.includes(depth) &&
          !data[10] && !data[11] && interlace <= 1);
        break;
      case 'PLTE':
        check(!palette && !compressed.length && ![0,4].includes(type) && size > 0 && size <= 768 && size % 3 === 0);
        palette = size / 3;
        check(type !== 3 || palette <= 2 ** depth);
        break;
      case 'tRNS':
        check(!transparent && !compressed.length && ((type === 0 && size === 2) || (type === 2 && size === 6) ||
          (type === 3 && size > 0 && size <= palette)));
        transparent = true;
        break;
      case 'IDAT':
        check(!afterData && (type !== 3 || palette));
        compressed.push(data);
        break;
      case 'IEND':
        check(!size && compressed.length && next === bytes.length);
        end = true;
        break;
      default:
        check(/^[a-z][a-zA-Z]{3}$/.test(name));
    }
    pos = next;
  }
  check(end);
  const passes = (interlace ? adam7 : [[0,0,1,1]]).map(([x,y,dx,dy]) => {
    const w = Math.max(0, Math.ceil((width-x)/dx)), h = Math.max(0, Math.ceil((height-y)/dy));
    return { stride: w ? 1 + Math.ceil(w * channels[type] * depth / 8) : 0, rows: h };
  });
  const length = passes.reduce((sum, p) => sum + p.stride * p.rows, 0);
  const raw = inflateSync(Buffer.concat(compressed), { maxOutputLength: length });
  check(raw.length === length);
  let offset = 0;
  for (const { stride, rows } of passes) {
    if (stride) for (let row = 0; row < rows; row++, offset += stride) check(raw[offset] <= 4);
  }
  return { width, height, colorType: type, hasTransparency: transparent || type === 4 || type === 6, sha256: sha256(bytes) };
}

function chunk(name, payload) {
  const result = Buffer.alloc(12 + payload.length);
  result.writeUInt32BE(payload.length);
  result.write(name, 4, 'ascii');
  payload.copy(result, 8);
  result.writeUInt32BE(crc32(result.subarray(4,-4)), result.length - 4);
  return result;
}
function isConvertibleImage(bytes) {
  if (!Buffer.isBuffer(bytes) || bytes.length < 12 || bytes.length > 128 * 1024 ** 2) return false;
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return true; // JPEG
  if (bytes.subarray(0, 4).toString('ascii') === 'RIFF' && bytes.subarray(8, 12).toString('ascii') === 'WEBP') return true; // WebP
  if (bytes[0] === 0x42 && bytes[1] === 0x4d) return true; // BMP
  const head6 = bytes.subarray(0, 6).toString('ascii');
  if (head6 === 'GIF87a' || head6 === 'GIF89a') return true; // GIF
  return false;
}
function prepareImage(bytes, job, nativeImage) {
  if (Buffer.isBuffer(bytes) && !bytes.subarray(0, 8).equals(signature) && isConvertibleImage(bytes) && typeof nativeImage?.createFromBuffer === 'function') {
    const decoded = nativeImage.createFromBuffer(bytes);
    check(!decoded.isEmpty() && typeof decoded.toPNG === 'function');
    bytes = decoded.toPNG();
  }
  const info = inspectPng(bytes);
  if (job.category !== 'character' || job.background === 'transparent' || !info.hasTransparency) return { bytes, info };
  const decoded = nativeImage.createFromBuffer(bytes);
  const {width, height} = info;
  check(!decoded.isEmpty() && decoded.getSize().width === width && decoded.getSize().height === height);
  // Skia's Windows bitmap is premultiplied BGRA. Compositing over white adds (255 - alpha).
  const bitmap = decoded.toBitmap(), stride = width * 3 + 1, rgb = Buffer.alloc(height * stride);
  check(bitmap.length === width * height * 4);
  for (let y = 0, src = 0; y < height; y++) {
    let dst = y * stride + 1;
    for (let x = 0; x < width; x++, src += 4) {
      const white = 255 - bitmap[src+3];
      for (const channel of [2,1,0]) rgb[dst++] = Math.min(255, bitmap[src+channel] + white);
    }
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width); header.writeUInt32BE(height,4); header[8] = 8; header[9] = 2;
  const output = Buffer.concat([signature, chunk('IHDR',header), chunk('IDAT',deflateSync(rgb)), chunk('IEND',Buffer.alloc(0))]);
  return { bytes: output, info: inspectPng(output) };
}
module.exports = { sha256, inspectPng, prepareImage };
