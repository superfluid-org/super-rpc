import sqlite3 from 'sqlite3';
import fs from 'fs';
import path from 'path';
import { Logger } from './logger';

export interface CacheEntry {
    val: any;
    ts: number;
    readCnt: number;
    writeCnt: number;
}

export class Cache {
    private db?: sqlite3.Database;
    private memCache = new Map<string, CacheEntry>();
    private logger: Logger;

    constructor(logger: Logger, dbPath?: string) {
        this.logger = logger;
        if (dbPath) {
            const dbDir = path.dirname(dbPath);
            if (!fs.existsSync(dbDir)) {
                fs.mkdirSync(dbDir, { recursive: true });
            }

            this.db = new sqlite3.Database(dbPath, (err) => {
                if (err) {
                    this.logger.error(`Error opening DB ${dbPath}: ${err.message}`);
                } else {
                    this.logger.info(`Opened DB ${dbPath}`);
                    this.db?.run(`CREATE TABLE IF NOT EXISTS data(key TEXT PRIMARY KEY, val TEXT, ts INTEGER)`, (err) => {
                        if (err) this.logger.error(`Create table failed: ${err.message}`);
                    });
                }
            });
        }
    }

    public async get(key: string): Promise<CacheEntry | undefined> {
        // Try memory first
        if (this.memCache.has(key)) {
            return this.memCache.get(key);
        }

        // Try DB
        if (this.db) {
            return new Promise((resolve, reject) => {
                this.db!.get(`SELECT val, ts FROM data WHERE key = ?`, [key], (err, row: any) => {
                    if (err) {
                        this.logger.error(`DB read error: ${err.message}`);
                        resolve(undefined);
                    } else if (row) {
                        try {
                            const val = JSON.parse(row.val);
                            // We don't have read/write counts in DB schema currently, so default to 0
                            const entry: CacheEntry = { val, ts: row.ts, readCnt: 0, writeCnt: 0 };
                            // Populate DB hit back to memory for speed? 
                            // original app didn't explicit doing this but it's good practice. 
                            // However, let's stick to original logic: if in DB, return it.
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

    public set(key: string, val: any) {
        const entry: CacheEntry = {
            val,
            ts: Date.now(),
            readCnt: 0,
            writeCnt: 1
        };

        // Update memory
        this.memCache.set(key, entry);

        // Update DB
        if (this.db) {
            this.db.run(`INSERT OR REPLACE INTO data(key, val, ts) VALUES(?, ?, ?)`,
                [key, JSON.stringify(val), entry.ts],
                (err) => {
                    if (err) this.logger.error(`DB write error: ${err.message}`);
                }
            );
        }
    }

    public close() {
        this.db?.close();
    }
}
