# Augmented RPC Proxy

A high-performance JSON-RPC proxy with intelligent caching and failover for EVM blockchain interactions.

## Quick Start

```bash
# Install dependencies
npm install

# Copy and configure
cp config.sample.yaml config.yaml
# Edit config.yaml with your RPC URLs

# Build and run
npm run build
npm start
```

## Configuration

### YAML Configuration (Recommended)

Create a `config.yaml` file in the project root:

```yaml
server:
  port: 3000
  host: "0.0.0.0"

rpc:
  # Single RPC URL
  url: "https://mainnet.base.org"
  
  # Multi-network setup with primary/fallback
  networks:
    base-mainnet:
      primary:
        url: "https://mainnet.base.org"
      fallback:
        url: "https://base-mainnet.g.alchemy.com/v2/demo"
    polygon-mainnet:
      primary:
        url: "https://polygon-rpc.com"
      fallback:
        url: "https://polygon-mainnet.g.alchemy.com/v2/demo"

cache:
  max_age: 300000  # 5 minutes
  enable_db: true

rate_limit:
  window_ms: 60000
  max_requests: 100

cors:
  enabled: true
  origin: "*"
  credentials: false

helmet:
  enabled: true
  content_security_policy: true
```

### Configuration File Locations

The system looks for configuration files in this order:
1. `./config.yaml` (project root)
2. `./config.yml` (project root)
3. `../config.yaml` (relative to dist)
4. `../config.yml` (relative to dist)

### Environment Variables (Override YAML)

Environment variables override YAML settings:

```bash
PORT=3000                    # Server port
RPC_URL=https://...          # Single RPC endpoint
CACHE_MAX_AGE=300000         # Cache TTL (milliseconds)
ENABLE_DB_CACHE=true         # Enable SQLite cache
CORS_ENABLED=false           # Disable CORS
HELMET_ENABLED=false         # Disable security headers
```

**Note**: Multi-network configuration is now handled through YAML only. Environment variable `RPC_NETWORKS` is deprecated.

### Failover Behavior

The proxy uses **immediate failover** - no retries on primary:
- Primary fails → **immediately** tries fallback
- Primary returns invalid data → **automatically** tries fallback
- Fallback has retries (for transient errors)
- Smart detection of historical data errors (missing trie node, etc.)

## Key Features

- **10-100x faster cache hits** than cache misses
- **Intelligent caching** for immutable blockchain data (historical data cached forever)
- **Batch request processing** with parallel execution
- **Automatic failover** with immediate primary/fallback switching
- **Smart fallback detection** for historical data errors (missing trie node, etc.)
- **No retries on primary** - immediate failover on failure for faster response

## Usage

```bash
# Test basic functionality
curl -X POST http://localhost:3000/ \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc": "2.0", "method": "eth_blockNumber", "params": [], "id": 1}'

# Test multi-network with primary/fallback
curl -X POST http://localhost:3000/base-mainnet \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc": "2.0", "method": "eth_blockNumber", "params": [], "id": 1}'

# Test historical data (triggers fallback if primary lacks archive node)
curl -X POST http://localhost:3000/base-mainnet \
  -H "Content-Type: application/json" \
  -d '{
    "jsonrpc": "2.0",
    "method": "eth_call",
    "params": [
      {"to": "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", "data": "0x18160ddd"},
      "0xF4240"
    ],
    "id": 1
  }'

# Test batch requests
curl -X POST http://localhost:3000/ \
  -H "Content-Type: application/json" \
  -d '[
    {"jsonrpc": "2.0", "method": "eth_blockNumber", "params": [], "id": 1},
    {"jsonrpc": "2.0", "method": "eth_gasPrice", "params": [], "id": 2}
  ]'
```

## Metrics

- **Health**: `http://localhost:3000/health`
- **Metrics**: `http://localhost:3000/metrics`
- **Stats**: `http://localhost:3000/stats`

## Testing

```bash
./test-augmented-rpc.sh
```

Perfect for high-throughput workloads that need fast, reliable RPC access with intelligent caching and automatic failover.