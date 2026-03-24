# Super RPC

High-performance EVM RPC proxy with caching, request coalescing, and automatic fallback to archival nodes.

## Quick Start

```bash
cp config.example.yaml config.yaml
# Edit config.yaml with your RPC endpoints
docker compose up -d --build
```

- **RPC**: `http://localhost:4500/<network-name>`
- **Metrics**: `http://localhost:4510/metrics`

## Configuration

```yaml
server:
  port: 4500
  dbPath: "/app/data/cache.db"
  logLevel: "info"

networks:
  - name: "base-mainnet"
    primary: "https://..."
    fallback: "https://..."
```

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `WORKERS` | CPU count | Cluster workers |
| `METRICS_PORT` | 4510 | Metrics port |
| `MAX_CONCURRENT` | 500 | Max concurrent requests per worker |
| `MAX_SOCKETS` | 50 | Max connections per upstream host |
| `CACHE_MAX_AGE` | 10 | Cache TTL (seconds) |
| `CACHE_MAX_ENTRIES` | 10000 | LRU memory cache size per worker |

## Testing

```bash
./scripts/test_rpc.sh http://localhost:4500 http://localhost:4510
```
