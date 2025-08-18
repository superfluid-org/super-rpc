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
    return `${request.method}${JSON.stringify(request.params || [])}`;
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
      if (Date.now() - cachedEntry.ts <= maxAgeMs) {
        val = cachedEntry.val;
        // Update read count
        cachedEntry.readCnt++;
        this.cache.set(key, cachedEntry);
        
        this.logger.debug('Memory cache hit', { key, requestId });
      } else {
        this.logger.debug('Memory cache entry expired', { key, maxAgeMs });
        this.cache.delete(key); // Remove expired entry
      }
    } 
    // Try database cache if memory cache miss
    else if (this.dbCache) {
      try {
        const row = await this.dbCache.get(key);
        if (row && Date.now() - row.ts <= maxAgeMs) {
          this.logger.debug('Database cache hit', { key, requestId });
          val = JSON.parse(row.val);
          
          // Promote to memory cache for faster future access
          const cacheEntry: CacheEntry = {
            val,
            ts: row.ts,
            readCnt: 1,
            writeCnt: 0
          };
          this.cache.set(key, cacheEntry);
        } else if (row) {
          this.logger.debug('Database cache entry expired', { key, maxAgeMs });
          // Remove expired entry from database
          await this.dbCache.delete(key);
        }
      } catch (error) {
        this.logger.error('Database cache read error', { error: (error as any)?.message, key });
      }
    }

    if (val !== undefined && val !== null) {
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
    };

    this.logger.debug('Writing to cache', { key, timestamp });

    // Write to database cache if available
    if (this.dbCache) {
      try {
        await this.dbCache.set(key, JSON.stringify(newEntry.val), newEntry.ts);
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
