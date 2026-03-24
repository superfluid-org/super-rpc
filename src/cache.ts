import sqlite3 from 'sqlite3';
import fs from 'fs';
import path from 'path';
import { Logger } from './logger';

const MAX_MEMORY_ENTRIES = parseInt(process.env.CACHE_MAX_ENTRIES || '10000');
const CLEANUP_INTERVAL_MS = 60_000;

export interface CacheEntry {
    val: any;
    ts: number;
    immutable: boolean;
}

class LRUMap<V> {
    private map = new Map<string, V>();
    private maxSize: number;

    constructor(maxSize: number) {
        this.maxSize = maxSize;
    }

    get(key: string): V | undefined {
        const val = this.map.get(key);
        if (val === undefined) return undefined;
        this.map.delete(key);
        this.map.set(key, val);
        return val;
    }

    set(key: string, val: V) {
        if (this.map.has(key)) {
            this.map.delete(key);
        }
        this.map.set(key, val);
        while (this.map.size > this.maxSize) {
            const oldest = this.map.keys().next().value!;
            this.map.delete(oldest);
        }
    }

    delete(key: string) {
        this.map.delete(key);
    }

    get size(): number {
        return this.map.size;
    }

    entries(): IterableIterator<[string, V]> {
        return this.map.entries();
    }
}

export class Cache {
    private db?: sqlite3.Database;
    private dbReady = false;
    private memCache: LRUMap<CacheEntry>;
    private logger: Logger;
    private cleanupTimer?: NodeJS.Timeout;
    private pendingWrites: Array<{ key: string; val: string; ts: number }> = [];
    private flushTimer?: NodeJS.Timeout;

    constructor(logger: Logger, dbPath?: string) {
        this.logger = logger;
        this.memCache = new LRUMap(MAX_MEMORY_ENTRIES);

        if (dbPath) {
            const dbDir = path.dirname(dbPath);
            if (!fs.existsSync(dbDir)) {
                fs.mkdirSync(dbDir, { recursive: true });
            }

            this.db = new sqlite3.Database(dbPath, (err) => {
                if (err) {
                    this.logger.error(`Error opening DB ${dbPath}: ${err.message}`);
                    return;
                }
                this.logger.info(`Opened DB ${dbPath}`);
                // Catch async DB errors (e.g. corruption) to prevent crashing the worker
                this.db!.on('error', (err) => {
                    this.logger.error(`SQLite error: ${err.message}`);
                });
                this.db!.serialize(() => {
                    this.db!.run(`PRAGMA journal_mode=WAL`, (err) => {
                        if (err) this.logger.error(`WAL mode failed: ${err.message}`);
                        else this.logger.info('SQLite WAL mode enabled');
                    });
                    this.db!.run(`PRAGMA busy_timeout=5000`);
                    this.db!.run(`PRAGMA synchronous=NORMAL`);
                    this.db!.run(`CREATE TABLE IF NOT EXISTS data(key TEXT PRIMARY KEY, val TEXT, ts INTEGER)`, (err) => {
                        if (err) this.logger.error(`Create table failed: ${err.message}`);
                    });
                    this.db!.run(`CREATE INDEX IF NOT EXISTS idx_data_ts ON data(ts)`, () => {
                        this.dbReady = true;
                    });
                });
            });
        }

        this.cleanupTimer = setInterval(() => this.cleanup(), CLEANUP_INTERVAL_MS);
    }

    public async get(key: string): Promise<CacheEntry | undefined> {
        const memEntry = this.memCache.get(key);
        if (memEntry) {
            return memEntry;
        }

        if (this.db && this.dbReady) {
            return new Promise((resolve) => {
                this.db!.get(`SELECT val, ts FROM data WHERE key = ?`, [key], (err, row: any) => {
                    if (err) {
                        this.logger.error(`DB read error: ${err.message}`);
                        resolve(undefined);
                    } else if (row) {
                        try {
                            const val = JSON.parse(row.val);
                            const entry: CacheEntry = { val, ts: row.ts, immutable: false };
                            this.memCache.set(key, entry);
                            resolve(entry);
                        } catch (e) {
                            resolve(undefined);
                        }
                    } else {
                        resolve(undefined);
                    }
                });
            });
        }
        return undefined;
    }

    public set(key: string, val: any, immutable: boolean = false) {
        const entry: CacheEntry = {
            val,
            ts: Date.now(),
            immutable,
        };

        this.memCache.set(key, entry);

        if (this.db) {
            this.pendingWrites.push({ key, val: JSON.stringify(val), ts: entry.ts });
            this.scheduleFlush();
        }
    }

    private scheduleFlush() {
        if (this.flushTimer) return;
        this.flushTimer = setTimeout(() => {
            this.flushTimer = undefined;
            this.flushWrites();
        }, 100);
    }

    private flushWrites() {
        if (!this.db || !this.dbReady || this.pendingWrites.length === 0) return;

        const batch = this.pendingWrites.splice(0);
        const db = this.db;

        try {
            db.serialize(() => {
                db.run('BEGIN TRANSACTION');
                const stmt = db.prepare(`INSERT OR REPLACE INTO data(key, val, ts) VALUES(?, ?, ?)`);
                for (const w of batch) {
                    stmt.run(w.key, w.val, w.ts);
                }
                stmt.finalize();
                db.run('COMMIT', (err) => {
                    if (err) this.logger.error(`Batch write commit error: ${err.message}`);
                });
            });
        } catch (err: any) {
            this.logger.error(`SQLite flush error: ${err.message}`);
        }
    }

    private cleanup() {
        const now = Date.now();
        const defaultMaxAge = (parseInt(process.env.CACHE_MAX_AGE || '10')) * 1000;
        const keysToDelete: string[] = [];

        for (const [key, entry] of this.memCache.entries()) {
            if (entry.immutable) continue;
            if (now - entry.ts > defaultMaxAge) {
                keysToDelete.push(key);
            }
        }
        for (const key of keysToDelete) {
            this.memCache.delete(key);
        }

        if (this.db && this.dbReady) {
            try {
                const cutoff = now - defaultMaxAge;
                this.db.run(`DELETE FROM data WHERE ts < ?`, [cutoff], (err) => {
                    if (err) this.logger.error(`DB cleanup error: ${err.message}`);
                });
            } catch (err: any) {
                this.logger.error(`SQLite cleanup error: ${err.message}`);
            }
        }
    }

    public close() {
        if (this.cleanupTimer) clearInterval(this.cleanupTimer);
        if (this.flushTimer) {
            clearTimeout(this.flushTimer);
            this.flushWrites();
        }
        this.db?.close();
    }
}
