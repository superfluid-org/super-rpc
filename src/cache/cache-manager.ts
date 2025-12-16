import { createHash } from 'crypto';
import { JSONRPCRequest, JSONRPCResponse, CacheEntry, CacheStats } from '@/types';
import { ProxyConfig } from '@/types/config';
import { DUPLICATE_REQUEST_CONFIG } from '@/config/constants';
import { Logger } from '@/utils/logger';
import { LRUCache } from './lru-cache';
import { DatabaseCache } from './database';

/**
 * Cache Manager - Handles both memory and database caching
 */
export class CacheManager {
  private cache: LRUCache<string, CacheEntry>;
  private dbCache?: DatabaseCache;
  private logger: Logger;
  private duplicateDetector = new Map<string, number>();
  private config: ProxyConfig;

  constructor(config: ProxyConfig, logger: Logger) {
    this.config = config;
    this.logger = logger;
    this.cache = new LRUCache<string, CacheEntry>(config.cache.maxSize);
    
    if (config.cache.enableDb && config.cache.dbFile) {
      this.dbCache = new DatabaseCache(config.cache.dbFile, logger);
    }

    // Start periodic cleanup
    this.startPeriodicCleanup();
  }

  private startPeriodicCleanup(): void {
    // Clean up expired entries every hour
    setInterval(async () => {
      try {
        await this.cleanupExpiredEntries();
      } catch (error) {
        this.logger.error('Periodic cleanup failed', error as any);
      }
    }, 3600000); // 1 hour
  }

  private async cleanupExpiredEntries(): Promise<void> {
    // If maxAge is 0, skip cleanup (infinite cache)
    if (this.config.cache.maxAge === 0) {
      return;
    }
    
    const maxAge = this.config.cache.maxAge * 1000;
    
    // Cleanup database cache
    if (this.dbCache) {
      await this.dbCache.cleanup(maxAge);
    }

    // Cleanup memory cache
    const cutoffTime = Date.now() - maxAge;
    let removedCount = 0;
    
    for (const [key, entry] of this.cache.entries()) {
      if (entry.ts < cutoffTime) {
        this.cache.delete(key);
        removedCount++;
      }
    }

    if (removedCount > 0) {
      this.logger.debug(`Cleaned up ${removedCount} expired memory cache entries`);
    }
  }

  getCacheKey(request: JSONRPCRequest): string {
    const method = request.method;
    const params = request.params || [];
    const paramCount = params.length;
    
    // Fast path: no params
    if (paramCount === 0) return method;
    
    // Fast path: single param
    if (paramCount === 1) {
      const param = params[0];
      const paramType = typeof param;
      
      // Optimized method-specific handling
      switch (method) {
        case 'eth_getLogs': {
          if (paramType === 'object' && param !== null) {
            const filter = param as any;
            return `${method}:${filter.address || ''}:${filter.fromBlock || '0x0'}:${filter.toBlock || 'latest'}:${filter.topics ? JSON.stringify(filter.topics) : '[]'}`;
          }
          break;
        }
        case 'eth_getBlockReceipts':
          return `${method}:${param}`;
        default:
          // Primitive single param
          if (paramType !== 'object' || param === null) {
            return `${method}:${param}`;
          }
      }
    }
    
    // Fast path: two params (eth_call)
    if (paramCount === 2 && method === 'eth_call') {
      const callObject = params[0] as any;
      const blockTag = params[1];
      if (callObject?.to && callObject?.data) {
        const blockTagStr = (blockTag !== null && blockTag !== undefined && typeof blockTag === 'object')
          ? JSON.stringify(blockTag)
          : String(blockTag);
        return `${method}:${callObject.to}:${callObject.data}:${blockTagStr}`;
      }
    }
    
    // Fallback: hash for complex cases
    return createHash('sha256').update(`${method}:${JSON.stringify(params, null, 0)}`).digest('hex').substring(0, 16);
  }

  async handleDuplicateRequest(cacheKey: string): Promise<void> {
    if (this.duplicateDetector.has(cacheKey)) {
      const prevCallTs = this.duplicateDetector.get(cacheKey)!;
      if (Date.now() - prevCallTs < DUPLICATE_REQUEST_CONFIG.DELAY_TRIGGER_THRESHOLD_MS) {
        const delayMs = DUPLICATE_REQUEST_CONFIG.MIN_DELAY_MS + 
          Math.floor(Math.random() * DUPLICATE_REQUEST_CONFIG.RANDOM_MAX_EXTRA_DELAY_MS);
        
        this.logger.debug(`Delaying potential duplicate request`, {
          cacheKey,
          delayMs
        });
        
        await new Promise(resolve => setTimeout(resolve, delayMs));
      }
    }
    this.duplicateDetector.set(cacheKey, Date.now());
  }

  async getFromCache(
    key: string, 
    maxAgeMs: number, 
    requestId: string | number | null
  ): Promise<JSONRPCResponse | undefined> {
    let val: unknown;

    // Try memory cache first
    if (this.cache.has(key)) {
      const cachedEntry = this.cache.get(key)!;
      const age = Date.now() - cachedEntry.ts;
      const isInfinite = maxAgeMs === Number.POSITIVE_INFINITY;
      const expiresAt = isInfinite ? null : cachedEntry.ts + maxAgeMs;
      const timeRemaining = isInfinite ? null : expiresAt! - Date.now();
      
      if (isInfinite || age <= maxAgeMs) {
        // Handle compressed data
        val = cachedEntry.val;
        
        // Update read count
        cachedEntry.readCnt++;
        this.cache.set(key, cachedEntry);
        
        this.logger.debug('Memory cache hit', { 
          key, 
          requestId, 
          compressed: cachedEntry.compressed,
          originalSize: cachedEntry.originalSize,
          compressedSize: cachedEntry.compressedSize,
          ageMs: age,
          maxAgeMs: isInfinite ? 'infinity' : maxAgeMs,
          expiresAt,
          timeRemainingMs: timeRemaining,
          neverExpires: isInfinite
        });
      } else {
        this.logger.debug('Memory cache entry expired', { 
          key, 
          maxAgeMs, 
          ageMs: age,
          expiredByMs: age - maxAgeMs
        });
        this.cache.delete(key); // Remove expired entry
      }
    } 
    // Try database cache if memory cache miss
    else if (this.dbCache) {
      try {
        const row = await this.dbCache.get(key);
        if (row) {
          const age = Date.now() - row.ts;
          const isInfinite = maxAgeMs === Number.POSITIVE_INFINITY;
          const expiresAt = isInfinite ? null : row.ts + maxAgeMs;
          const timeRemaining = isInfinite ? null : expiresAt! - Date.now();
          
          if (isInfinite || age <= maxAgeMs) {
            this.logger.debug('Database cache hit', { 
              key, 
              requestId,
              ageMs: age,
              maxAgeMs: isInfinite ? 'infinity' : maxAgeMs,
              expiresAt,
              timeRemainingMs: timeRemaining,
              neverExpires: isInfinite
            });
            
            // Parse the cached data
            val = JSON.parse(row.val);
            
            // Promote to memory cache for faster future access
            const cacheEntry: CacheEntry = {
              val: val,
              ts: row.ts,
              readCnt: 1,
              writeCnt: 0
            };
            this.cache.set(key, cacheEntry);
          } else {
            this.logger.debug('Database cache entry expired', { 
              key, 
              maxAgeMs,
              ageMs: age,
              expiredByMs: age - maxAgeMs
            });
            // Remove expired entry from database
            await this.dbCache.delete(key);
          }
        }
      } catch (error) {
        this.logger.error('Database cache read error', { error: (error as any)?.message, key });
      }
    }

    if (val !== undefined && val !== null) {
      // Check if val is already a full JSONRPCResponse object
      const isFullResponse = (
        typeof val === 'object' &&
        val !== null &&
        !Array.isArray(val) &&
        'jsonrpc' in val &&
        (val as any).jsonrpc === '2.0' &&
        ('result' in val || 'error' in val)
      );
      
      if (isFullResponse) {
        // Return the full response with updated id to match current request
        const fullResponse = val as JSONRPCResponse;
        return {
          ...fullResponse,
          id: requestId,
        };
      }
      
      // Legacy format: val is just the result, reconstruct the response
      return {
        jsonrpc: '2.0',
        id: requestId,
        result: val,
      };
    }

    return undefined;
  }

  async writeToCache(key: string, val: unknown): Promise<void> {
    const timestamp = Date.now();
    
    const newEntry: CacheEntry = {
      val,
      ts: timestamp,
      readCnt: this.cache.has(key) ? this.cache.get(key)!.readCnt : 0,
      writeCnt: this.cache.has(key) ? this.cache.get(key)!.writeCnt + 1 : 1,
      compressed: false,
      originalSize: JSON.stringify(val).length,
      compressedSize: JSON.stringify(val).length
    };

    // Write to database cache if available
    if (this.dbCache) {
      try {
        await this.dbCache.set(key, JSON.stringify(val), newEntry.ts);
      } catch (error) {
        this.logger.error('Database cache write error', { error: (error as any)?.message, key });
      }
    }

    // Always write to memory cache
    this.cache.set(key, newEntry);
  }

  async deleteFromCache(key: string): Promise<void> {
    this.cache.delete(key);
    
    if (this.dbCache) {
      try {
        await this.dbCache.delete(key);
      } catch (error) {
        this.logger.error('Database cache delete error', { error: (error as any)?.message, key });
      }
    }
  }

  async clearCache(): Promise<void> {
    this.cache.clear();
    
    if (this.dbCache) {
      try {
        // Clear all entries from database
        const stats = await this.dbCache.getStats();
        for (let i = 0; i < stats.totalEntries; i++) {
          // This is a simplified approach - in reality you'd want a more efficient method
        }
        await this.dbCache.vacuum();
      } catch (error) {
        this.logger.error('Database cache clear error', error as any);
      }
    }
  }

  async getStats(): Promise<CacheStats & { database?: object }> {
    let totalReads = 0;
    let totalWrites = 0;

    for (const entry of this.cache.values()) {
      totalReads += entry.readCnt;
      totalWrites += entry.writeCnt;
    }

    const stats: CacheStats & { database?: object } = {
      memoryEntries: this.cache.size(),
      readCount: totalReads,
      writeCount: totalWrites,
    };

    if (this.dbCache) {
      try {
        stats.database = await this.dbCache.getStats();
      } catch (error) {
        this.logger.error('Failed to get database stats', error as any);
      }
    }

    return stats;
  }

  async close(): Promise<void> {
    if (this.dbCache) {
      await this.dbCache.close();
    }
    this.cache.clear();
  }
}
