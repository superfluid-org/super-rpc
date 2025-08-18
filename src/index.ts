import 'dotenv/config';
import fs from 'fs';
import path from 'path';
import { Application } from './app';

/**
 * Application Entry Point
 */
async function bootstrap(): Promise<void> {
  // Validate required configuration: either RPC_URL or a networks map file
  const networksPath = process.env.RPC_NETWORKS_FILE
    ? path.resolve(process.env.RPC_NETWORKS_FILE)
    : path.resolve(process.cwd(), 'rpc.networks.json');

  const hasNetworksFile = fs.existsSync(networksPath);
  const hasSingleUrl = !!process.env.RPC_URL;

  if (!hasSingleUrl && !hasNetworksFile) {
    console.error('Error: Provide either RPC_URL or a networks map file.');
    console.error('Set RPC_NETWORKS_FILE=<path/to/json> or create rpc.networks.json in project root.');
    console.error('Example networks JSON: { "base-mainnet": "https://...", "polygon-mainnet": "https://..." }');
    process.exit(1);
  }

  try {
    const app = new Application();
    await app.start();
  } catch (error) {
    console.error('Failed to start application:', error);
    process.exit(1);
  }
}

// Global error handlers
process.on('unhandledRejection', (reason, promise) => {
  console.error('Unhandled Rejection at:', promise, 'reason:', reason);
  process.exit(1);
});

process.on('uncaughtException', (error) => {
  console.error('Uncaught Exception:', error);
  process.exit(1);
});

// Start the application
if (require.main === module) {
  bootstrap().catch((error) => {
    console.error('Bootstrap failed:', error);
    process.exit(1);
  });
}
