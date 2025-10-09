import { Logger } from './logger';

// Simple queue implementation to avoid external dependency
interface QueueTask<T> {
	fn: () => Promise<T>;
	priority: number;
	resolve: (value: T) => void;
	reject: (error: Error) => void;
}

export interface QueueConfig {
	concurrency: number;
	interval: number;
	intervalCap: number;
	timeout: number;
	throwOnTimeout: boolean;
}

export class RequestQueueManager {
	private queues: Map<string, SimpleQueue> = new Map();
	private config: QueueConfig;
	private logger: Logger;

	constructor(config: QueueConfig, logger: Logger) {
		this.config = config;
		this.logger = logger;
	}

	getQueueForNetwork(networkKey: string): SimpleQueue {
		if (!this.queues.has(networkKey)) {
		const queue = new SimpleQueue({
			concurrency: this.config.concurrency,
			interval: this.config.interval,
			intervalCap: this.config.intervalCap,
			timeout: this.config.timeout,
			throwOnTimeout: this.config.throwOnTimeout,
		});

			this.queues.set(networkKey, queue);
			this.logger.debug('Created new request queue', { 
				networkKey,
				concurrency: this.config.concurrency,
				intervalCap: this.config.intervalCap
			});
		}

		return this.queues.get(networkKey)!;
	}

	async addToQueue<T>(
		networkKey: string, 
		fn: () => Promise<T>, 
		priority: number = 0
	): Promise<T> {
		const queue = this.getQueueForNetwork(networkKey);
		return queue.add(fn, { priority });
	}

	getQueueStats(networkKey?: string): Array<{
		networkKey: string;
		size: number;
		pending: number;
		isPaused: boolean;
	}> {
		if (networkKey) {
			const queue = this.queues.get(networkKey);
			if (!queue) return [];
			
			return [{
				networkKey,
				size: queue.size(),
				pending: queue.pending(),
				isPaused: queue.isPaused()
			}];
		}

		return Array.from(this.queues.entries()).map(([key, queue]) => ({
			networkKey: key,
			size: queue.size(),
			pending: queue.pending(),
			isPaused: queue.isPaused()
		}));
	}

	pauseQueue(networkKey: string): void {
		const queue = this.queues.get(networkKey);
		if (queue) {
			queue.pause();
			this.logger.info('Paused request queue', { networkKey });
		}
	}

	resumeQueue(networkKey: string): void {
		const queue = this.queues.get(networkKey);
		if (queue) {
			queue.start();
			this.logger.info('Resumed request queue', { networkKey });
		}
	}

	clearQueue(networkKey: string): void {
		const queue = this.queues.get(networkKey);
		if (queue) {
			queue.clear();
			this.logger.info('Cleared request queue', { networkKey });
		}
	}

	destroy(): void {
		for (const [networkKey, queue] of this.queues.entries()) {
			queue.clear();
			this.logger.debug('Destroyed request queue', { networkKey });
		}
		this.queues.clear();
		this.logger.info('Destroyed all request queues');
	}
}

class SimpleQueue {
	private tasks: QueueTask<any>[] = [];
	private running = 0;
	private paused = false;
	private config: QueueConfig;
	private intervalTimer?: NodeJS.Timeout;
	private intervalCount = 0;

	constructor(config: QueueConfig) {
		this.config = config;
		this.startInterval();
	}

	private startInterval(): void {
		this.intervalTimer = setInterval(() => {
			this.intervalCount = 0;
		}, this.config.interval);
	}

	async add<T>(fn: () => Promise<T>, options: { priority: number } = { priority: 0 }): Promise<T> {
		return new Promise((resolve, reject) => {
			this.tasks.push({
				fn,
				priority: options.priority,
				resolve,
				reject
			});

			// Sort by priority (higher priority first)
			this.tasks.sort((a, b) => b.priority - a.priority);

			this.processNext();
		});
	}

	private async processNext(): Promise<void> {
		if (this.paused || this.running >= this.config.concurrency || this.intervalCount >= this.config.intervalCap) {
			return;
		}

		const task = this.tasks.shift();
		if (!task) return;

		this.running++;
		this.intervalCount++;

		try {
			const result = await Promise.race([
				task.fn(),
				new Promise((_, reject) => 
					setTimeout(() => reject(new Error('Task timeout')), this.config.timeout)
				)
			]);

			task.resolve(result);
		} catch (error) {
			task.reject(error as Error);
		} finally {
			this.running--;
			this.processNext();
		}
	}

	size(): number {
		return this.tasks.length;
	}

	pending(): number {
		return this.running;
	}

	isPaused(): boolean {
		return this.paused;
	}

	pause(): void {
		this.paused = true;
	}

	start(): void {
		this.paused = false;
		this.processNext();
	}

	clear(): void {
		this.tasks.forEach(task => {
			task.reject(new Error('Queue cleared'));
		});
		this.tasks = [];
		this.running = 0;
	}

	destroy(): void {
		if (this.intervalTimer) {
			clearInterval(this.intervalTimer);
		}
		this.clear();
	}
}
