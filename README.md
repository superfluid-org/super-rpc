# Augmented RPC Proxy

A high-performance JSON-RPC proxy optimized for **subgraph syncing** and EVM blockchain interactions.

## 🚀 Quick Start

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

## ⚙️ Configuration

### YAML Configuration (Recommended)

Create a `config.yaml` file in the project root:

```yaml
server:
  port: 3000
  host: "0.0.0.0"

rpc:
  # Single RPC URL
  url: "https://mainnet.base.org"
  
  # Multi-network setup
  networks:
    base-mainnet:
      url: "https://mainnet.base.org"
      timeout: 30000
      retries: 3
    polygon-mainnet:
      url: "https://polygon-rpc.com"
      timeout: 30000
      retries: 3

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

## 🎯 Subgraph Optimizations

- **10-100x faster cache hits** than cache misses
- **Intelligent caching** for immutable blockchain data
- **Batch request processing** with parallel execution
- **Block range optimization** for `eth_getLogs` queries

## 📊 Usage

```bash
# Test basic functionality
curl -X POST http://localhost:3000/ \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc": "2.0", "method": "eth_blockNumber", "params": [], "id": 1}'

# Test multi-network
curl -X POST http://localhost:3000/base-mainnet \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc": "2.0", "method": "eth_blockNumber", "params": [], "id": 1}'

# Test batch requests
curl -X POST http://localhost:3000/ \
  -H "Content-Type: application/json" \
  -d '[
    {"jsonrpc": "2.0", "method": "eth_blockNumber", "params": [], "id": 1},
    {"jsonrpc": "2.0", "method": "eth_gasPrice", "params": [], "id": 2}
  ]'
```

## 📈 Metrics

- **Health**: `http://localhost:3000/health`
- **Metrics**: `http://localhost:3000/metrics`
- **Stats**: `http://localhost:3000/stats`

## 🧪 Testing

```bash
./test-augmented-rpc.sh
```

Perfect for subgraph syncing workloads that need fast, reliable RPC access with intelligent caching.