import { ProxyConfig } from '@/types/config';
import { DEFAULT_VALUES } from './constants';
export { DEFAULT_VALUES } from './constants';

/**
 * Configuration Manager - Singleton pattern for app configuration
 */
export class ConfigManager {
  private static instance: ConfigManager;
  private config: ProxyConfig;

  private constructor() {
    this.config = this.loadConfig();
    this.validateConfig();
  }

  static getInstance(): ConfigManager {
    if (!ConfigManager.instance) {
      ConfigManager.instance = new ConfigManager();
    }
    return ConfigManager.instance;
  }

  private loadConfig(): ProxyConfig {
    const allowedOrigins = process.env.ALLOWED_ORIGINS?.split(',') || [];
    
    return {
      server: {
        port: parseInt(process.env.PORT || String(DEFAULT_VALUES.PORT), 10),
        host: process.env.HOST || DEFAULT_VALUES.HOST,
        environment: process.env.NODE_ENV || 'development',
      },
      rpc: {
        url: process.env.RPC_URL || '',
        timeout: parseInt(process.env.RPC_TIMEOUT || String(DEFAULT_VALUES.RPC_TIMEOUT), 10),
        retries: parseInt(process.env.RPC_RETRIES || String(DEFAULT_VALUES.RPC_RETRIES), 10),
        initialTimeoutMs: parseInt(
          process.env.RPC_INITIAL_TIMEOUT || String(DEFAULT_VALUES.RPC_INITIAL_TIMEOUT),
          10
        ),
      },
      cache: {
        maxAge: parseInt(process.env.CACHE_MAX_AGE || String(DEFAULT_VALUES.CACHE_MAX_AGE), 10),
        dbFile: process.env.DB_FILE,
        maxSize: parseInt(process.env.CACHE_MAX_SIZE || String(DEFAULT_VALUES.CACHE_MAX_SIZE), 10),
        enableDb: process.env.ENABLE_DB_CACHE === 'true',
      },
      rateLimit: {
        windowMs: parseInt(
          process.env.RATE_LIMIT_WINDOW || String(DEFAULT_VALUES.RATE_LIMIT_WINDOW),
          10
        ),
        max: parseInt(process.env.RATE_LIMIT_MAX || String(DEFAULT_VALUES.RATE_LIMIT_MAX), 10),
      },
      logging: {
        level: process.env.LOG_LEVEL || DEFAULT_VALUES.LOG_LEVEL,
        enableConsole: process.env.NODE_ENV !== 'production',
      },
      security: {
        allowedOrigins,
        enableHelmet: process.env.DISABLE_HELMET !== 'true',
        enableCors: process.env.DISABLE_CORS !== 'true',
      },
    };
  }

  private validateConfig(): void {
    // rpc.url is optional in multi-network mode. Only validate if provided.
    if (this.config.rpc.url) {
      try {
        new URL(this.config.rpc.url);
      } catch {
        throw new Error('Invalid RPC_URL format. Must be a valid URL');
      }
    }

    // Validate port range
    if (this.config.server.port < 1 || this.config.server.port > 65535) {
      throw new Error('Invalid port number. Must be between 1 and 65535');
    }
  }

  getConfig(): ProxyConfig {
    return { ...this.config };
  }

  isProduction(): boolean {
    return this.config.server.environment === 'production';
  }

  isDevelopment(): boolean {
    return this.config.server.environment === 'development';
  }
}