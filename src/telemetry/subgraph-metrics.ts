import client from 'prom-client';

export class SubgraphMetrics {
  private static instance: SubgraphMetrics | undefined;
  private initialized = false;

  // Subgraph-specific metrics
  blockRangeRequests!: client.Counter<string>;
  logQueryDuration!: client.Histogram<string>;
  cacheHitRateByMethod!: client.Gauge<string>;
  subgraphSyncProgress!: client.Gauge<string>;
  duplicateRequestReduction!: client.Counter<string>;
  prefetchEffectiveness!: client.Gauge<string>;

  static getInstance(): SubgraphMetrics {
    if (!this.instance) {
      this.instance = new SubgraphMetrics();
    }
    return this.instance;
  }

  init(): void {
    if (this.initialized) return;

    this.blockRangeRequests = new client.Counter({
      name: 'subgraph_block_range_requests_total',
      help: 'Total block range requests processed',
      labelNames: ['network', 'range_size', 'optimization_type'],
    });

    this.logQueryDuration = new client.Histogram({
      name: 'subgraph_log_query_duration_ms',
      help: 'Duration of log queries in milliseconds',
      labelNames: ['network', 'block_range_size'],
      buckets: [10, 50, 100, 500, 1000, 5000, 10000, 30000],
    });

    this.cacheHitRateByMethod = new client.Gauge({
      name: 'subgraph_cache_hit_rate_by_method',
      help: 'Cache hit rate by RPC method',
      labelNames: ['method', 'network'],
    });

    this.subgraphSyncProgress = new client.Gauge({
      name: 'subgraph_sync_progress_percentage',
      help: 'Subgraph synchronization progress percentage',
      labelNames: ['network', 'subgraph_id'],
    });

    this.duplicateRequestReduction = new client.Counter({
      name: 'subgraph_duplicate_requests_reduced_total',
      help: 'Total duplicate requests reduced through optimization',
      labelNames: ['network', 'method'],
    });

    this.prefetchEffectiveness = new client.Gauge({
      name: 'subgraph_prefetch_effectiveness',
      help: 'Effectiveness of prefetching (hit rate)',
      labelNames: ['network', 'method'],
    });

    this.initialized = true;
  }

  recordBlockRangeRequest(network: string, rangeSize: number, optimizationType: string): void {
    this.blockRangeRequests.labels(network, rangeSize.toString(), optimizationType).inc();
  }

  recordLogQueryDuration(network: string, blockRangeSize: number, duration: number): void {
    this.logQueryDuration.labels(network, blockRangeSize.toString()).observe(duration);
  }

  updateCacheHitRate(method: string, network: string, hitRate: number): void {
    this.cacheHitRateByMethod.labels(method, network).set(hitRate);
  }

  updateSyncProgress(network: string, subgraphId: string, progress: number): void {
    this.subgraphSyncProgress.labels(network, subgraphId).set(progress);
  }

  recordDuplicateReduction(network: string, method: string, count: number): void {
    this.duplicateRequestReduction.labels(network, method).inc(count);
  }

  updatePrefetchEffectiveness(network: string, method: string, effectiveness: number): void {
    this.prefetchEffectiveness.labels(network, method).set(effectiveness);
  }

  getRegister(): typeof client.register {
    return client.register;
  }
}
