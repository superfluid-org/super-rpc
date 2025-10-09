import { Logger } from './logger';

export type CircuitBreakerState = 'CLOSED' | 'OPEN' | 'HALF_OPEN';

export interface CircuitBreakerConfig {
	failureThreshold: number;
	recoveryTimeout: number;
	monitoringPeriod: number;
}

export class CircuitBreaker {
	private failures = 0;
	private lastFailureTime = 0;
	private state: CircuitBreakerState = 'CLOSED';
	private config: CircuitBreakerConfig;
	private logger: Logger;
	private successCount = 0;

	constructor(config: CircuitBreakerConfig, logger: Logger) {
		this.config = config;
		this.logger = logger;
	}

	async execute<T>(fn: () => Promise<T>, context?: string): Promise<T> {
		if (this.state === 'OPEN') {
			if (Date.now() - this.lastFailureTime > this.config.recoveryTimeout) {
				this.state = 'HALF_OPEN';
				this.successCount = 0;
				this.logger.info('Circuit breaker transitioning to HALF_OPEN', { context });
			} else {
				const error = new Error(`Circuit breaker is OPEN for ${context || 'operation'}`);
				this.logger.warn('Circuit breaker blocked request', { 
					context, 
					state: this.state,
					failures: this.failures,
					timeSinceLastFailure: Date.now() - this.lastFailureTime
				});
				throw error;
			}
		}

		try {
			const result = await fn();
			this.onSuccess(context);
			return result;
		} catch (error) {
			this.onFailure(error as Error, context);
			throw error;
		}
	}

	private onSuccess(context?: string): void {
		this.failures = 0;
		
		if (this.state === 'HALF_OPEN') {
			this.successCount++;
			// Require multiple successes to fully close the circuit
			if (this.successCount >= 3) {
				this.state = 'CLOSED';
				this.logger.info('Circuit breaker closed after successful recovery', { 
					context,
					successCount: this.successCount 
				});
			}
		} else if (this.state === 'OPEN') {
			this.state = 'CLOSED';
			this.logger.info('Circuit breaker closed', { context });
		}
	}

	private onFailure(error: Error, context?: string): void {
		this.failures++;
		this.lastFailureTime = Date.now();
		
		this.logger.warn('Circuit breaker recorded failure', {
			context,
			failures: this.failures,
			threshold: this.config.failureThreshold,
			error: error.message
		});

		if (this.failures >= this.config.failureThreshold) {
			this.state = 'OPEN';
			this.logger.error('Circuit breaker opened due to failures', {
				context,
				failures: this.failures,
				threshold: this.config.failureThreshold
			});
		}
	}

	getState(): CircuitBreakerState {
		return this.state;
	}

	getStats(): { state: CircuitBreakerState; failures: number; successCount: number; lastFailureTime: number } {
		return {
			state: this.state,
			failures: this.failures,
			successCount: this.successCount,
			lastFailureTime: this.lastFailureTime
		};
	}

	reset(): void {
		this.failures = 0;
		this.successCount = 0;
		this.state = 'CLOSED';
		this.lastFailureTime = 0;
		this.logger.info('Circuit breaker manually reset');
	}
}
