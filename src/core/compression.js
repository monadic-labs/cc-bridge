import zlib from 'zlib';
import { promisify } from 'util';
import { Result } from './types.js';

const gunzipAsync = promisify(zlib.gunzip);
const inflateAsync = promisify(zlib.inflate);
const brotliDecompressAsync = promisify(zlib.brotliDecompress);

const gzipAsync = promisify(zlib.gzip);
const deflateAsync = promisify(zlib.deflate);
const brotliCompressAsync = promisify(zlib.brotliCompress);

const DECOMPRESSORS = Object.freeze(new Map([
  ['gzip', gunzipAsync],
  ['deflate', inflateAsync],
  ['br', brotliDecompressAsync],
]));

const COMPRESSORS = Object.freeze(new Map([
  ['gzip', gzipAsync],
  ['deflate', deflateAsync],
  ['br', brotliCompressAsync],
]));

export async function decompress(buffer, encoding) {
  if (!encoding) return Result.ok(buffer);
  const decompressFn = DECOMPRESSORS.get(encoding);
  if (!decompressFn) return Result.ok(buffer);
  try {
    const decompressed = await decompressFn(buffer);
    return Result.ok(decompressed);
  } catch (e) {
    return Result.fail(e);
  }
}

export async function compress(buffer, encoding) {
  if (!encoding) return Result.ok(buffer);
  const compressFn = COMPRESSORS.get(encoding);
  if (!compressFn) return Result.ok(buffer);
  try {
    const compressed = await compressFn(buffer);
    return Result.ok(compressed);
  } catch (e) {
    return Result.fail(e);
  }
}
