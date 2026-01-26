import { RPCProxy } from './services/proxy';
import { ConfigManager } from './config';
import { Logger } from './utils/logger';

/**
 * Main Application Class
 */
export class Application {
  private proxy: RPCProxy;
  private config = ConfigManager.getInstance().getConfig();
  private logger: Logger;

  constructor() {
    this.logger = Logger.getInstance(this.config);
    this.proxy = new RPCProxy();
  }

  async start(): Promise<void> {
    this.logger.info('Starting RPC Proxy Application', {
      version: process.env.npm_package_version || '1.0.0',
      environment: this.config.server.environment,
      nodeVersion: process.version,
      platform: process.platform,
      arch: process.arch,
    });

    try {
      await this.proxy.start();
      this.logger.info('Application started successfully');
    } catch (error) {
      this.logger.error('Failed to start application', error as any);
      throw error;
    }
  }

  async stop(): Promise<void> {
    this.logger.info('Stopping application...');
    await this.proxy.stop();
    this.logger.info('Application stopped successfully');
  }
}
