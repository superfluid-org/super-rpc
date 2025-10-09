import sqlite3 from 'sqlite3';
import { promisify } from 'util';
import { DatabaseRow } from '@/types';
import { Logger } from '@/utils/logger';

/**
 * Database Cache Implementation using SQLite
 */
export class DatabaseCache {
  private db?: sqlite3.Database;
  private dbGet?: (sql: string, params: unknown[]) => Promise<any>;
  private dbRun?: (sql: string, params: unknown[]) => Promise<any>;
  private logger: Logger;

  constructor(dbFile: string, logger: Logger) {
    this.logger = logger;
    this.initializeDatabase(dbFile);
  }

  private initializeDatabase(dbFile: string): void {
    this.db = new sqlite3.Database(dbFile, (err) => {
      if (err) {
        throw new Error(`Failed to open database at ${dbFile}: ${err.message}`);
      }

      this.db!.run(
        `CREATE TABLE IF NOT EXISTS data(
          key TEXT PRIMARY KEY,
          val TEXT NOT NULL,
          ts INTEGER NOT NULL,
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )`,
        (err) => {
          if (err) {
            throw new Error(`Failed to create table: ${err.message}`);
          }
          this.logger.info(`Database initialized: ${dbFile}`);
        }
      );

      // Create index for timestamp-based queries
      this.db!.run(
        `CREATE INDEX IF NOT EXISTS idx_data_ts ON data(ts)`,
        (err) => {
          if (err) {
            this.logger.warn('Failed to create timestamp index', { error: err.message });
          }
        }
      );
    });

    // Promisify database methods for async/await
    this.dbGet = promisify(this.db.get.bind(this.db));
    this.dbRun = promisify(this.db.run.bind(this.db));
  }

  async get(key: string): Promise<DatabaseRow | undefined> {
    if (!this.dbGet) {
      throw new Error('Database not initialized');
    }

    try {
      const row = await this.dbGet(`SELECT val, ts FROM data WHERE key = ?`, [key]);
      return row as DatabaseRow | undefined;
    } catch (error) {
      this.logger.error('Database read error', { error: (error as any)?.message, key });
      throw error;
    }
  }

  async set(key: string, value: string, timestamp: number): Promise<void> {
    if (!this.dbRun) {
      throw new Error('Database not initialized');
    }

    try {
      await this.dbRun(
        `INSERT OR REPLACE INTO data(key, val, ts, updated_at) VALUES(?, ?, ?, CURRENT_TIMESTAMP)`,
        [key, value, timestamp]
      );
    } catch (error) {
      this.logger.error('Database write error', { error: (error as any)?.message, key });
      throw error;
    }
  }

  async delete(key: string): Promise<boolean> {
    if (!this.dbRun) {
      throw new Error('Database not initialized');
    }

    try {
      const result = await this.dbRun(`DELETE FROM data WHERE key = ?`, [key]);
      return (result as any)?.changes > 0;
    } catch (error) {
      this.logger.error('Database delete error', { error: (error as any)?.message, key });
      throw error;
    }
  }

  async count(): Promise<number> {
    if (!this.dbGet) {
      throw new Error('Database not initialized');
    }

    try {
      const row = await this.dbGet(`SELECT COUNT(*) as count FROM data`, []);
      return (row as any)?.count || 0;
    } catch (error) {
      this.logger.error('Database count error', { error: (error as any)?.message });
      throw error;
    }
  }

  async cleanup(maxAge: number): Promise<number> {
    if (!this.dbRun) {
      throw new Error('Database not initialized');
    }

    const cutoffTime = Date.now() - maxAge;
    
    try {
      const result = await this.dbRun(`DELETE FROM data WHERE ts < ?`, [cutoffTime]);
      const deletedCount = (result as any)?.changes || 0;
      
      if (deletedCount > 0) {
        this.logger.info(`Cleaned up ${deletedCount} expired cache entries`);
      }
      
      return deletedCount;
    } catch (error) {
      this.logger.error('Database cleanup error', { error: (error as any)?.message });
      throw error;
    }
  }

  async getStats(): Promise<{ totalEntries: number; oldestEntry: number | null; newestEntry: number | null }> {
    if (!this.dbGet) {
      throw new Error('Database not initialized');
    }

    try {
      const statsRow = await this.dbGet(
        `SELECT 
          COUNT(*) as count,
          MIN(ts) as oldest,
          MAX(ts) as newest
        FROM data`,
        []
      );

      return {
        totalEntries: (statsRow as any)?.count || 0,
        oldestEntry: (statsRow as any)?.oldest || null,
        newestEntry: (statsRow as any)?.newest || null,
      };
    } catch (error) {
      this.logger.error('Database stats error', { error: (error as any)?.message });
      throw error;
    }
  }

  async batchWrite(entries: Array<{key: string, val: string, ts: number}>): Promise<void> {
    if (!this.dbRun) {
      throw new Error('Database not initialized');
    }

    if (entries.length === 0) return;

    try {
      await this.dbRun('BEGIN TRANSACTION', []);
      
      for (const entry of entries) {
        await this.dbRun(
          `INSERT OR REPLACE INTO data(key, val, ts, updated_at) VALUES(?, ?, ?, CURRENT_TIMESTAMP)`,
          [entry.key, entry.val, entry.ts]
        );
      }
      
      await this.dbRun('COMMIT', []);
      this.logger.debug(`Batch wrote ${entries.length} entries to database`);
    } catch (error) {
      await this.dbRun('ROLLBACK', []).catch(() => {}); // Ignore rollback errors
      this.logger.error('Database batch write error', { error: (error as any)?.message });
      throw error;
    }
  }

  async vacuum(): Promise<void> {
    if (!this.dbRun) {
      throw new Error('Database not initialized');
    }

    try {
      await this.dbRun(`VACUUM`, []);
      this.logger.info('Database vacuum completed');
    } catch (error) {
      this.logger.error('Database vacuum error', { error: (error as any)?.message });
      throw error;
    }
  }

  async close(): Promise<void> {
    if (!this.db) {
      return;
    }

    return new Promise((resolve, reject) => {
      this.db!.close((err) => {
        if (err) {
          this.logger.error('Error closing database', { error: err.message });
          reject(err);
        } else {
          this.logger.info('Database connection closed');
          resolve();
        }
      });
    });
  }
}
