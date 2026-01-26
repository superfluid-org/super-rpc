import { Request, Response, NextFunction } from 'express';
import { Logger } from '@/utils/logger';

/**
 * Request Logging Middleware - generates request ID for tracking
 */
export function createRequestLogger(_logger: Logger) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const requestId = generateRequestId();
    (req as any).requestId = requestId;

    res.on('finish', () => {
      // Request completion details are logged by the proxy service
      // No need for redundant logging here
    });

    next();
  };
}

/**
 * Preserve RPC method logging only at debug level (optional deep dive)
 */
export function createRPCLogger(_logger: Logger) {
  return (_req: Request, _res: Response, next: NextFunction): void => {
    // We keep this lightweight to avoid multi-line noise. Users can enable debug to see more.
    next();
  };
}

/**
 * Error Logging Middleware
 */
export function createErrorLogger(logger: Logger) {
  return (error: Error, req: Request, _res: Response, next: NextFunction): void => {
    const requestId = (req as any).requestId;
    logger.error('Request error', {
      requestId,
      error: error.message,
      stack: error.stack,
      method: req.method,
      url: req.url,
    });
    next(error);
  };
}

function generateRequestId(): string {
  return `req_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
}

/**
 * Performance Monitoring Middleware
 */
export function createPerformanceLogger(logger: Logger, slowRequestThreshold: number = 1000) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const startTime = process.hrtime.bigint();
    const requestId = (req as any).requestId;

    res.on('finish', () => {
      const endTime = process.hrtime.bigint();
      const duration = Number(endTime - startTime) / 1000000; // Convert to milliseconds

      if (duration > slowRequestThreshold) {
        logger.warn('Slow request detected', {
          requestId,
          method: req.method,
          url: req.url,
          duration: Math.round(duration),
          threshold: slowRequestThreshold,
          rpcMethod: req.body?.method,
        });
      }

      // Performance metrics are already captured by Prometheus - no need to log
    });

    next();
  };
}
