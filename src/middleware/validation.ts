import { Request, Response, NextFunction } from 'express';
import { JSONRPCRequest, JSONRPCResponse } from '@/types';
import { JSONRPC_ERRORS } from '@/config/constants';

/**
 * JSON-RPC Request Validation Middleware
 */
export function validateJSONRPCRequest(req: Request, res: Response, next: NextFunction): void {
  const body = req.body as JSONRPCRequest | JSONRPCRequest[];

  if (Array.isArray(body)) {
    if (body.length === 0 || !body.every(isValidJSONRPCRequest)) {
      const errorResponse: JSONRPCResponse = {
        jsonrpc: '2.0',
        id: null,
        error: JSONRPC_ERRORS.INVALID_REQUEST,
      };
      res.status(400).json(errorResponse);
      return;
    }
  } else if (!isValidJSONRPCRequest(body)) {
    const errorResponse: JSONRPCResponse = {
      jsonrpc: '2.0',
      id: (body as any)?.id ?? null,
      error: JSONRPC_ERRORS.INVALID_REQUEST,
    };
    res.status(400).json(errorResponse);
    return;
  }

  next();
}

/**
 * Type guard for JSON-RPC request validation
 */
export function isValidJSONRPCRequest(request: any): request is JSONRPCRequest {
  return (
    request &&
    typeof request === 'object' &&
    request.jsonrpc === '2.0' &&
    typeof request.method === 'string' &&
    request.method.length > 0 &&
    (request.id === null || typeof request.id === 'string' || typeof request.id === 'number') &&
    (!request.params || Array.isArray(request.params))
  );
}

/**
 * Content Type Validation Middleware
 */
export function validateContentType(req: Request, res: Response, next: NextFunction): void {
  const contentType = req.get('Content-Type');
  
  if (!contentType || !contentType.includes('application/json')) {
    const errorResponse: JSONRPCResponse = {
      jsonrpc: '2.0',
      id: null,
      error: {
        code: -32700,
        message: 'Parse error - Content-Type must be application/json',
      },
    };
    res.status(400).json(errorResponse);
    return;
  }

  next();
}

/**
 * Request Size Validation Middleware
 */
export function validateRequestSize(maxSizeBytes: number = 1024 * 1024) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const contentLength = parseInt(req.get('Content-Length') || '0', 10);
    
    if (contentLength > maxSizeBytes) {
      const errorResponse: JSONRPCResponse = {
        jsonrpc: '2.0',
        id: null,
        error: {
          code: -32600,
          message: `Request too large. Maximum size is ${maxSizeBytes} bytes`,
        },
      };
      res.status(413).json(errorResponse);
      return;
    }

    next();
  };
}

/**
 * Method Whitelist Validation Middleware
 */
export function validateAllowedMethods(allowedMethods?: string[]) {
  return (req: Request, res: Response, next: NextFunction): void => {
    if (!allowedMethods || allowedMethods.length === 0) {
      return next();
    }

    const request = req.body as JSONRPCRequest | JSONRPCRequest[];
    const requests = Array.isArray(request) ? request : [request];

    if (!requests.every((r) => allowedMethods.includes(r.method))) {
      const errorResponse: JSONRPCResponse = {
        jsonrpc: '2.0',
        id: null,
        error: {
          ...JSONRPC_ERRORS.METHOD_NOT_FOUND,
          data: `One or more methods are not allowed`,
        },
      };
      res.status(405).json(errorResponse);
      return;
    }

    next();
  };
}

/**
 * Parameter Validation Middleware (basic validation)
 */
export function validateParameters(req: Request, res: Response, next: NextFunction): void {
  const body = req.body as JSONRPCRequest | JSONRPCRequest[];
  const requests = Array.isArray(body) ? body : [body];

  for (const request of requests) {
    // Basic parameter validation based on method
    if (request.method === 'eth_call' && (!request.params || request.params.length < 1)) {
      const errorResponse: JSONRPCResponse = {
        jsonrpc: '2.0',
        id: request.id ?? null,
        error: {
          ...JSONRPC_ERRORS.INVALID_PARAMS,
          data: 'eth_call requires at least 1 parameter (call object) and optional block tag',
        },
      };
      res.status(400).json(errorResponse);
      return;
    }

    if (request.method === 'eth_getTransactionReceipt' && (!request.params || request.params.length !== 1)) {
      const errorResponse: JSONRPCResponse = {
        jsonrpc: '2.0',
        id: request.id ?? null,
        error: {
          ...JSONRPC_ERRORS.INVALID_PARAMS,
          data: 'eth_getTransactionReceipt requires exactly 1 parameter',
        },
      };
      res.status(400).json(errorResponse);
      return;
    }
  }

  next();
}
