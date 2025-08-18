/**
 * Application Constants
 */

export const DEFAULT_VALUES = {
  PORT: 3000,
  HOST: '0.0.0.0',
  RPC_TIMEOUT: 30000,
  RPC_RETRIES: 10,
  RPC_INITIAL_TIMEOUT: 2000,
  CACHE_MAX_AGE: 10,
  CACHE_MAX_SIZE: 10000,
  RATE_LIMIT_WINDOW: 900000, // 15 minutes
  RATE_LIMIT_MAX: 1000,
  LOG_LEVEL: 'info',
} as const;

export const CACHEABLE_METHODS = {
  INFINITELY_CACHEABLE: [
    'eth_chainId',
    'net_version',
    'eth_getTransactionReceipt',
  ],
  TIME_CACHEABLE: [
    'eth_blockNumber',
    'eth_call',
  ],
} as const;

export const DUPLICATE_REQUEST_CONFIG = {
  DELAY_TRIGGER_THRESHOLD_MS: 1000,
  MIN_DELAY_MS: 500,
  RANDOM_MAX_EXTRA_DELAY_MS: 1000,
} as const;

export const HTTP_STATUS = {
  OK: 200,
  BAD_REQUEST: 400,
  UNAUTHORIZED: 401,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  TOO_MANY_REQUESTS: 429,
  INTERNAL_SERVER_ERROR: 500,
  SERVICE_UNAVAILABLE: 503,
} as const;

export const JSONRPC_ERRORS = {
  INVALID_REQUEST: { code: -32600, message: 'Invalid Request' },
  METHOD_NOT_FOUND: { code: -32601, message: 'Method not found' },
  INVALID_PARAMS: { code: -32602, message: 'Invalid params' },
  INTERNAL_ERROR: { code: -32603, message: 'Internal error' },
  PARSE_ERROR: { code: -32700, message: 'Parse error' },
  RATE_LIMIT_EXCEEDED: { code: -32000, message: 'Rate limit exceeded' },
} as const;