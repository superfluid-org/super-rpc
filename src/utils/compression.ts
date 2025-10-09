import { gzip, gunzip } from 'zlib';
import { promisify } from 'util';

const gzipAsync = promisify(gzip);
const gunzipAsync = promisify(gunzip);

export interface CompressedData {
  compressed: boolean;
  data: Buffer | string;
  originalSize?: number;
  compressedSize?: number;
}

export class ResponseCompressor {
  private static readonly MIN_COMPRESSION_SIZE = 1024; // 1KB minimum to compress
  private static readonly COMPRESSION_THRESHOLD = 0.8; // Only compress if >20% reduction

  /**
   * Compress response data if beneficial
   */
  static async compress(data: string | Buffer): Promise<CompressedData> {
    const originalSize = Buffer.isBuffer(data) ? data.length : Buffer.byteLength(data);
    
    // Don't compress small responses
    if (originalSize < this.MIN_COMPRESSION_SIZE) {
      return {
        compressed: false,
        data,
        originalSize,
        compressedSize: originalSize
      };
    }

    try {
      const buffer = Buffer.isBuffer(data) ? data : Buffer.from(data);
      const compressed = await gzipAsync(buffer);
      
      // Only use compression if it provides significant benefit
      const compressionRatio = compressed.length / originalSize;
      if (compressionRatio < this.COMPRESSION_THRESHOLD) {
        return {
          compressed: true,
          data: compressed,
          originalSize,
          compressedSize: compressed.length
        };
      } else {
        return {
          compressed: false,
          data,
          originalSize,
          compressedSize: originalSize
        };
      }
    } catch (error) {
      // If compression fails, return uncompressed data
      return {
        compressed: false,
        data,
        originalSize,
        compressedSize: originalSize
      };
    }
  }

  /**
   * Decompress response data if it was compressed
   */
  static async decompress(compressedData: CompressedData): Promise<string | Buffer> {
    if (!compressedData.compressed) {
      return compressedData.data;
    }

    try {
      const buffer = Buffer.isBuffer(compressedData.data) 
        ? compressedData.data 
        : Buffer.from(compressedData.data);
      
      const decompressed = await gunzipAsync(buffer);
      return decompressed;
    } catch (error) {
      // If decompression fails, return original data
      return compressedData.data;
    }
  }

  /**
   * Get compression statistics
   */
  static getCompressionStats(compressedData: CompressedData): {
    compressed: boolean;
    originalSize: number;
    compressedSize: number;
    compressionRatio: number;
    spaceSaved: number;
    spaceSavedPercent: number;
  } {
    const originalSize = compressedData.originalSize || 0;
    const compressedSize = compressedData.compressedSize || originalSize;
    const compressionRatio = originalSize > 0 ? compressedSize / originalSize : 1;
    const spaceSaved = originalSize - compressedSize;
    const spaceSavedPercent = originalSize > 0 ? (spaceSaved / originalSize) * 100 : 0;

    return {
      compressed: compressedData.compressed,
      originalSize,
      compressedSize,
      compressionRatio,
      spaceSaved,
      spaceSavedPercent
    };
  }

  /**
   * Check if data should be compressed based on size and type
   */
  static shouldCompress(data: string | Buffer, contentType?: string): boolean {
    const size = Buffer.isBuffer(data) ? data.length : Buffer.byteLength(data);
    
    // Don't compress small data
    if (size < this.MIN_COMPRESSION_SIZE) {
      return false;
    }

    // Don't compress already compressed data
    if (contentType && (
      contentType.includes('gzip') || 
      contentType.includes('deflate') || 
      contentType.includes('br')
    )) {
      return false;
    }

    return true;
  }
}
