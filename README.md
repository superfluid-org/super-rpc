# Super RPC

**Super RPC** is a high-performance middleware for EVM RPCs, designed to augment and optimize RPC requests for reliability and speed, especially for subgraphs and indexers.

## Features

*   **Multi-Network Support**: Configure multiple networks (e.g., Base, Optimism) via `config.yaml`.
*   **Performance**:
    *   **Keep-Alive**: Connection pooling for low-latency upstream requests.
    *   **Smart Throttling**: Optimized duplicate request handling (100ms delay).
*   **Smart Caching**:
    *   **Persistent Cache**: SQLite-based caching.
    *   **Immutable Data**: Permanently caches `eth_chainId`, `net_version`, etc.
*   **Fallback Mechanism**: Switches to Archival Node if Primary receives "missing state" errors.
*   **Production Logging**: Structured logs with internal request tracing.


## Docker

You can run the application using Docker Compose. This automatically handles dependencies and mounts the configuration file.

1.  **Prepare Configuration**:
    ensure you have a `config.yaml` file (copy from example if needed).
    ```bash
    cp config.example.yaml config.yaml
    ```

2.  **Run with Docker Compose**:
    ```bash
    docker compose up -d --build
    ```

    The application will be available at `http://localhost:4500`.
    Data will be persisted in the `./data` directory.

## Local Installation

```bash
npm install
npm run build
```

## Configuration

1.  Copy the example configuration:
    ```bash
    cp config.example.yaml config.yaml
    ```
2.  Edit `config.yaml` to add your RPC endpoints:
    ```yaml
    server:
      port: 4500
      dbPath: "./cache.db"
      logLevel: "info"

    networks:
      - name: "base-mainnet"
        primary: "https://... (Full Node)"
        fallback: "https://... (Archival Node)"
    ```

## Usage

Start the server:

```bash
npm start
# OR for development
npm run dev
```

### Accessing Networks

Send requests to `http://localhost:PORT/<network-name>`:

```bash
curl -X POST -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","method":"eth_blockNumber","params":[],"id":1}' \
  http://localhost:4500/base-mainnet
```

## Testing

Run the included test script:

```bash
./scripts/test_rpc.sh
```
