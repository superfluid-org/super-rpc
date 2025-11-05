import 'dotenv/config';
import { Application } from './app';

/**
 * Application Entry Point
 */
async function bootstrap(): Promise<void> {
  // Configuration validation is now handled by ConfigManager
  // It will load from config.yaml or environment variables
  
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
