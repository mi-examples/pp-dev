import { unzipSync, brotliDecompressSync, deflateSync, gzipSync, brotliCompressSync, inflateSync } from 'zlib';

export function decodeContent(content: Buffer, contentEncoding?: string) {
  switch (contentEncoding) {
    case 'gzip':
      return unzipSync(content);

    case 'br':
      return brotliDecompressSync(content);

    case 'deflate':
      return deflateSync(content);

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
      return inflateSync(content);

    default:
      return content;
  }
}
