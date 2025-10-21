export interface QueueConfig {
  concurrency: number;
  timeout: number;
}

export class RequestQueueManager {
  private queues: Map<string, SimpleQueue> = new Map();
  private config: QueueConfig;

  constructor(config: QueueConfig) {
    this.config = config;
  }

  getQueueForNetwork(networkKey: string): SimpleQueue {
    if (!this.queues.has(networkKey)) {
      const queue = new SimpleQueue({
        concurrency: this.config.concurrency,
        timeout: this.config.timeout,
      });
      this.queues.set(networkKey, queue);
    }
    return this.queues.get(networkKey)!;
  }

  async addToQueue<T>(
    networkKey: string, 
    fn: () => Promise<T>
  ): Promise<T> {
    const queue = this.getQueueForNetwork(networkKey);
    return queue.add(fn);
  }

  getQueueStats() {
    return {
      totalQueues: this.queues.size,
      networks: Array.from(this.queues.keys())
    };
  }

  destroy() {
    this.queues.clear();
  }
}

class SimpleQueue {
  private running = 0;
  private queue: Array<() => Promise<any>> = [];
  private config: QueueConfig;

  constructor(config: QueueConfig) {
    this.config = config;
  }

  async add<T>(fn: () => Promise<T>): Promise<T> {
    return new Promise((resolve, reject) => {
      this.queue.push(async () => {
        try {
          const result = await fn();
          resolve(result);
        } catch (error) {
          reject(error);
        }
      });
      this.process();
    });
  }

  private async process() {
    if (this.running >= this.config.concurrency || this.queue.length === 0) {
      return;
    }

    this.running++;
    const fn = this.queue.shift()!;
    
    try {
      await fn();
    } finally {
      this.running--;
      this.process();
    }
  }

}