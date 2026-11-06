import { unzipSync, brotliDecompressSync, deflateSync, gzipSync, brotliCompressSync, inflateSync } from 'zlib';

/**
 * @param options.maxOutputLength - The most bytes to unpack: past it the decoder throws (a
 *   RangeError) instead of allocating the rest.
 */
export function decodeContent(content: Buffer, contentEncoding?: string, options: { maxOutputLength?: number } = {}) {
  switch (contentEncoding) {
    case 'gzip':
      return unzipSync(content, options);

    case 'br':
      return brotliDecompressSync(content, options);

    case 'deflate':
      return inflateSync(content, options);

    default:
      return content;
  }
}

export function encodeContent(content: Buffer, contentEncoding?: string) {
  switch (contentEncoding) {
    case 'gzip':
      return gzipSync(content);

    case 'br':
      return brotliCompressSync(content);

    case 'deflate':
      return deflateSync(content);

    default:
      return content;
  }
}
