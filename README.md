# augmented-rpc

A lightweight, production-friendly JSON-RPC proxy for EVM chains with request logging, smart caching, retry/backoff, Prometheus metrics, and multi-network routing.

## Highlights
- JSON-RPC proxy for HTTP upstreams (works with any EVM RPC)
- Smart caching for immutable and time-sensitive methods
- Duplicate request detection and brief delay to increase cache hit rate
- Retries with exponential backoff and jitter for transient upstream issues
- Single-line structured logs with request duration and status
- Prometheus metrics at `/metrics`
- Optional SQLite-backed persistent cache
- Multi-network routing via simple JSON mapping: `POST /:network`
- Batch JSON-RPC support

## Requirements
- Node.js 18+ (tested with Node 21)
- npm

## Installation
```bash
npm i
```

## Configuration
You can configure via environment variables (see `.env.example`) and/or a networks map JSON file.

### Environment variables
- `RPC_URL`: upstream RPC URL (required only in single-RPC mode)
- `PORT` (default 3000): server port
- `HOST` (default 0.0.0.0): server bind host
- `LOG_LEVEL` (default info): logging level (`error`, `warn`, `info`, `debug`)
- `RPC_TIMEOUT` (default 30000): upstream request timeout (ms)
- `RPC_RETRIES` (default 10): maximum retry attempts
- `RPC_INITIAL_TIMEOUT` (default 2000): first backoff delay (ms)
- `CACHE_MAX_AGE` (default 10): TTL (seconds) for time-cacheable methods
- `CACHE_MAX_SIZE` (default 10000): in-memory cache size (entries)
- `ENABLE_DB_CACHE` (default false): enable SQLite cache if `true`
- `DB_FILE`: SQLite file path when DB cache is enabled
- `RPC_NETWORKS_FILE`: path to a JSON file with network→URL map (default: `rpc.networks.json` in project root)
- `ALLOWED_ORIGINS`: CSV of allowed CORS origins
- `DISABLE_HELMET` (default false): set `true` to disable Helmet
- `DISABLE_CORS` (default false): set `true` to disable CORS

See `.env.example` for a ready-to-copy template.

### Multi-network map (optional)
Create `rpc.networks.json` at the project root (or point `RPC_NETWORKS_FILE` to a file):
```json
{
  "base-mainnet": "https://mainnet.infura.io/v3/<key>",
  "polygon-mainnet": "https://mainnet.infura.io/v3/<key>"
}
```
This allows routing requests by network key via `POST /:network`.

## Running
### 1) Single upstream RPC
```bash
RPC_URL=https://mainnet.infura.io/v3/<key> npm run start
```
Optionally enable DB cache:
```bash
ENABLE_DB_CACHE=true DB_FILE=./cache.sqlite npm run start
```

### 2) Multi-network mode (no RPC_URL required)
```bash
npm run start
```
With `rpc.networks.json` present (or `RPC_NETWORKS_FILE` set), you can call per network:
```bash
curl -s localhost:3000/base-mainnet \
  -H 'content-type: application/json' \
  -d '{"jsonrpc":"2.0","method":"eth_blockNumber","params":[],"id":1}'

curl -s localhost:3000/polygon-mainnet \
  -H 'content-type: application/json' \
  -d '{"jsonrpc":"2.0","method":"eth_blockNumber","params":[],"id":1}'
```

## Routes
- POST `/` JSON-RPC proxy (single-RPC mode)
- POST `/:network` JSON-RPC proxy (multi-network mode)
- GET `/health` app and upstream connectivity
- GET `/stats` proxy and cache statistics
- GET `/cache/stats` cache stats
- POST `/cache/clear` clear cache
- GET `/metrics` Prometheus metrics (text exposition)

## Caching behavior
- Infinitely cacheable:
  - `eth_chainId`, `net_version`, `eth_getTransactionReceipt`
- Time-cacheable (TTL = `CACHE_MAX_AGE` seconds):
  - `eth_blockNumber`, `eth_call` (without explicit block bindings), `eth_getLogs`
- Immutable `eth_call` when bound to a specific block via `blockHash` or explicit block tag (e.g., hex block number) is cached indefinitely
- Duplicate request detection: brief randomized delay for rapid repeats to increase hit rate

Notes:
- Cache keys include the method name and request params. In multi-network mode they are namespaced by network to avoid collisions.
- If DB cache is enabled, reads promote entries to memory; expired DB entries are periodically cleaned up.

## Retries & backoff
- Exponential backoff with jitter for retryable upstream errors
- Non-retryable categories: 4xx (except 429), 401/403, malformed requests

## Logging
- Single-line per request upon completion: includes method, path, status code, duration, and JSON-RPC method
- Level escalates to `warn` if duration exceeds 1000 ms (configurable by editing `createPerformanceLogger` threshold)
- Set `LOG_LEVEL=debug` for deeper internal logs

Example line:
```
[YYYY-MM-DD HH:mm:ss] info: Request completed {"requestId":"...","method":"POST","url":"/","statusCode":200,"duration":42,"rpcMethod":"eth_blockNumber"}
```

## Metrics (Prometheus)
- Endpoint: `GET /metrics`
- Includes default Node process metrics and custom metrics:
  - `rpc_http_requests_total{method,cache_status,outcome}`
  - `rpc_http_upstream_responses_total{status_code}`
  - `rpc_http_cached_responses_total{method}`
  - `rpc_cache_hits_total{method}`
  - `rpc_cache_misses_total{method}`
  - `rpc_request_duration_ms{method,cache_status}` (histogram)

## Performance tips
- First request latency is typically DNS/TCP/TLS warmup; subsequent calls reuse keep-alive
- Tune `CACHE_MAX_AGE` to your upstream’s rate limits and consistency guarantees
- Enable DB cache for long-lived services that benefit from persistence across restarts

## Troubleshooting
- "RPC_URL required": either set `RPC_URL` (single-RPC mode) or create `rpc.networks.json`/set `RPC_NETWORKS_FILE`
- `/metrics` returns 404 or 400: ensure you are sending a GET request; JSON validation applies only to POST routes
- DB errors on startup: ensure `DB_FILE` path is writable; the table is created automatically
- CORS issues: set `ALLOWED_ORIGINS` or disable via `DISABLE_CORS=true` (only if you understand the risks)

## Development
Build:
```bash
npm run build
```
Run (dev):
```bash
npm run dev
```

## License
ISC
