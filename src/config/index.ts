import { ProxyConfig } from '@/types/config';
import { DEFAULT_VALUES } from './constants';
import * as fs from 'fs';
import * as path from 'path';
import * as yaml from 'js-yaml';

/**
 * Configuration Manager - Supports YAML config files with environment variable overrides
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
    // Load YAML config if it exists
    const yamlConfig = this.loadYamlConfig();
    
    // Merge with environment variables (env vars take precedence)
    return {
      server: {
        port: parseInt(process.env.PORT || yamlConfig.server?.port || String(DEFAULT_VALUES.PORT), 10),
        host: process.env.HOST || yamlConfig.server?.host || DEFAULT_VALUES.HOST,
        environment: process.env.NODE_ENV || yamlConfig.server?.environment || 'development',
        log_level: process.env.LOG_LEVEL || yamlConfig.server?.log_level || 'info',
      },
      rpc: {
        url: process.env.RPC_URL || yamlConfig.rpc?.url || '',
        timeout: parseInt(process.env.RPC_TIMEOUT || yamlConfig.rpc?.timeout || String(DEFAULT_VALUES.RPC_TIMEOUT), 10),
        retries: parseInt(process.env.RPC_RETRIES || yamlConfig.rpc?.retries || String(DEFAULT_VALUES.RPC_RETRIES), 10),
        initialTimeoutMs: parseInt(
          process.env.RPC_INITIAL_TIMEOUT || yamlConfig.rpc?.initial_timeout_ms || String(DEFAULT_VALUES.RPC_INITIAL_TIMEOUT),
          10
        ),
        primaryTimeoutMs: parseInt(
          process.env.PRIMARY_TIMEOUT_MS || yamlConfig.rpc?.primary_timeout_ms || String(DEFAULT_VALUES.RPC_PRIMARY_TIMEOUT),
          10
        ),
        networks: this.loadNetworks(yamlConfig.rpc?.networks),
        batchConcurrencyLimit: parseInt(process.env.BATCH_CONCURRENCY_LIMIT || yamlConfig.rpc?.batch_concurrency_limit || '10', 10),
        batchTimeout: parseInt(process.env.BATCH_TIMEOUT || yamlConfig.rpc?.batch_timeout || '5000', 10),
      },
      cache: {
        maxAge: parseInt(process.env.CACHE_MAX_AGE || yamlConfig.cache?.max_age || String(DEFAULT_VALUES.CACHE_MAX_AGE), 10),
        dbFile: process.env.DB_FILE || yamlConfig.cache?.db_file,
        maxSize: parseInt(process.env.CACHE_MAX_SIZE || yamlConfig.cache?.max_size || String(DEFAULT_VALUES.CACHE_MAX_SIZE), 10),
        enableDb: process.env.ENABLE_DB_CACHE === 'true' || yamlConfig.cache?.enable_db === true,
      },
      rateLimit: {
        windowMs: parseInt(
          process.env.RATE_LIMIT_WINDOW || yamlConfig.rate_limit?.window_ms || String(DEFAULT_VALUES.RATE_LIMIT_WINDOW),
          10
        ),
        maxRequests: parseInt(
          process.env.RATE_LIMIT_MAX || yamlConfig.rate_limit?.max_requests || String(DEFAULT_VALUES.RATE_LIMIT_MAX),
          10
        ),
      },
      cors: {
        enabled: process.env.CORS_ENABLED !== 'false' && yamlConfig.cors?.enabled !== false,
        origin: process.env.CORS_ORIGIN || yamlConfig.cors?.origin || '*',
        credentials: process.env.CORS_CREDENTIALS === 'true' || yamlConfig.cors?.credentials === true,
      },
      helmet: {
        enabled: process.env.HELMET_ENABLED !== 'false' && yamlConfig.helmet?.enabled !== false,
        contentSecurityPolicy: process.env.HELMET_CSP === 'true' || yamlConfig.helmet?.content_security_policy === true,
      },
    };
  }

  private loadYamlConfig(): any {
    const configPaths = [
      path.join(process.cwd(), 'config.yaml'),
      path.join(process.cwd(), 'config.yml'),
      path.join(__dirname, '..', '..', 'config.yaml'),
      path.join(__dirname, '..', '..', 'config.yml'),
    ];

    for (const configPath of configPaths) {
      if (fs.existsSync(configPath)) {
        try {
          const fileContents = fs.readFileSync(configPath, 'utf8');
          const yamlConfig = yaml.load(fileContents) as any;
          console.log(`Loaded configuration from: ${configPath}`);
          return yamlConfig || {};
        } catch (error) {
          console.warn(`Failed to load YAML config from ${configPath}:`, error);
        }
      }
    }

    return {};
  }

  private loadNetworks(yamlNetworks?: Record<string, any>): Record<string, any> {
    const networks: Record<string, any> = {};
    
    // Load from YAML config first
    if (yamlNetworks && typeof yamlNetworks === 'object') {
      for (const [key, value] of Object.entries(yamlNetworks)) {
        if (typeof value === 'string') {
          networks[key] = { url: value, timeout: 30000, retries: 3, retry_delay: 1000 };
        } else if (typeof value === 'object' && value !== null) {
          // Support both old format (url) and new format (primary/fallbacks)
          if ('url' in value) {
            networks[key] = value;
          } else if ('primary' in value) {
            networks[key] = value;
          }
        }
      }
    }
    
    // Override with environment variables if present
    if (process.env.RPC_NETWORKS) {
      try {
        const parsed = JSON.parse(process.env.RPC_NETWORKS);
        if (typeof parsed === 'object' && parsed !== null) {
          for (const [key, value] of Object.entries(parsed)) {
            if (typeof value === 'string') {
              networks[key] = { url: value, timeout: 30000, retries: 3, retry_delay: 1000 };
            } else if (typeof value === 'object' && value !== null && 'url' in value) {
              networks[key] = value;
            }
          }
        }
      } catch (e) {
        console.warn('Failed to parse RPC_NETWORKS:', e);
      }
    }
    
    return networks;
  }

  private validateConfig(): void {
    if (!this.config.rpc.url && Object.keys(this.config.rpc.networks).length === 0) {
      console.warn('Warning: No RPC URL configured. Set RPC_URL environment variable or configure networks in config.yaml');
    }
    
    // Step 2: Validate upstream reliability - warn if archival nodes not detected
    this.validateArchivalNodes();
  }

  /**
   * Validate that upstream RPC nodes are archival nodes for historical data queries
   */
  private validateArchivalNodes(): void {
    const networks = this.config.rpc.networks || {};
    const warnings: string[] = [];

    // Check single RPC_URL
    if (this.config.rpc.url) {
      if (!this.isLikelyArchivalNode(this.config.rpc.url)) {
        warnings.push(`RPC_URL (${this.maskUrl(this.config.rpc.url)}) may not be an archival node. Historical queries may fail or return incomplete data.`);
      }
    }

    // Check network configurations
    for (const [networkKey, networkConfig] of Object.entries(networks)) {
      if (typeof networkConfig === 'object' && networkConfig !== null) {
        // Check primary
        if (networkConfig.primary?.url) {
          if (!this.isLikelyArchivalNode(networkConfig.primary.url)) {
            warnings.push(`Network "${networkKey}" primary RPC (${this.maskUrl(networkConfig.primary.url)}) may not be an archival node. Historical queries may fail or return incomplete data.`);
          }
        }
        
        // Check fallback
        if (networkConfig.fallback?.url) {
          if (!this.isLikelyArchivalNode(networkConfig.fallback.url)) {
            warnings.push(`Network "${networkKey}" fallback RPC (${this.maskUrl(networkConfig.fallback.url)}) may not be an archival node. Historical queries may fail or return incomplete data.`);
          }
        }
        
        // Check old format (url) - support legacy config format
        const legacyConfig = networkConfig as any;
        if (legacyConfig.url && !networkConfig.primary) {
          if (!this.isLikelyArchivalNode(legacyConfig.url)) {
            warnings.push(`Network "${networkKey}" RPC (${this.maskUrl(legacyConfig.url)}) may not be an archival node. Historical queries may fail or return incomplete data.`);
          }
        }
      }
    }

    // Emit warnings
    if (warnings.length > 0) {
      console.warn('\n⚠️  ARCHIVAL NODE WARNING:');
      console.warn('For reliable historical data queries (eth_getLogs, eth_getBlockReceipts, etc.),');
      console.warn('ensure your upstream RPC nodes are full archival nodes.\n');
      warnings.forEach(warning => console.warn(`  - ${warning}`));
      console.warn('\nTo suppress this warning, add "archival: true" to your network config or use');
      console.warn('RPC providers that explicitly support archival data (e.g., Alchemy Archive, Infura Archive).\n');
    }
  }

  /**
   * Check if URL is likely an archival node based on common patterns
   */
  private isLikelyArchivalNode(url: string): boolean {
    if (!url) return false;
    
    const lowerUrl = url.toLowerCase();
    
    // Check for explicit archival indicators
    const archivalIndicators = [
      'archive',
      'archival',
      'full',
      'complete',
    ];
    
    if (archivalIndicators.some(indicator => lowerUrl.includes(indicator))) {
      return true;
    }
    
    // These providers often have archival, but URL alone doesn't guarantee it
    // We'll be conservative and not assume archival unless explicitly indicated
    return false;
  }

  /**
   * Mask URL for logging (hide sensitive parts)
   */
  private maskUrl(url: string): string {
    try {
      const urlObj = new URL(url);
      // Mask path and query but keep host
      return `${urlObj.protocol}//${urlObj.host}${urlObj.pathname.substring(0, 20)}...`;
    } catch {
      return url.substring(0, 50) + '...';
    }
  }

  getConfig(): ProxyConfig {
    return this.config;
  }
}

export { DEFAULT_VALUES } from './constants';