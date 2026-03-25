import cluster from 'cluster';
import os from 'os';
import Fastify from 'fastify';
import { AggregatorRegistry } from 'prom-client';
import { loadConfig } from './config';
import { Cache } from './cache';
import { ProxyService } from './proxy';
import { Logger } from './logger';
import { Metrics } from './metrics';

const NUM_WORKERS = parseInt(process.env.WORKERS || '0') || os.cpus().length;
const METRICS_PORT = parseInt(process.env.METRICS_PORT || '4510');

if (cluster.isPrimary) {
    const config = loadConfig('./config.yaml');
    const logger = new Logger(config.server.logLevel);

    logger.info(`Master ${process.pid} starting ${NUM_WORKERS} workers (rpc:${config.server.port}, metrics:${METRICS_PORT})`);

    for (let i = 0; i < NUM_WORKERS; i++) {
        cluster.fork();
    }

    // Crash-loop protection
    const restartTimestamps: number[] = [];
    const MAX_RESTARTS_PER_MINUTE = 10;

    cluster.on('exit', (worker, code, signal) => {
        logger.warn(`Worker ${worker.process.pid} died (${signal || code})`);

        if (shuttingDown) return;

        const now = Date.now();
        restartTimestamps.push(now);
        while (restartTimestamps.length > 0 && now - restartTimestamps[0] > 60_000) {
            restartTimestamps.shift();
        }

        if (restartTimestamps.length > MAX_RESTARTS_PER_MINUTE) {
            logger.error(`Workers crash-looping (${restartTimestamps.length} restarts in 60s) — exiting master`);
            process.exit(1);
        }

        logger.info('Restarting worker...');
        cluster.fork();
    });

    let shuttingDown = false;

    for (const sig of ['SIGINT', 'SIGTERM'] as const) {
        process.on(sig, () => {
            shuttingDown = true;
            logger.info(`${sig} received — shutting down workers`);
            for (const id in cluster.workers) {
                cluster.workers[id]?.process.kill(sig);
            }
            setTimeout(() => process.exit(0), 16000).unref();
        });
    }

    // --- Aggregated metrics server in master ---
    const aggregatorRegistry = new AggregatorRegistry();
    const metricsApp = Fastify();

    metricsApp.get('/metrics', async (_request, reply) => {
        reply.header('Content-Type', aggregatorRegistry.contentType);
        return aggregatorRegistry.clusterMetrics();
    });

    metricsApp.listen({ port: METRICS_PORT, host: '0.0.0.0' }).then(() => {
        logger.info(`Metrics server ready on port ${METRICS_PORT}`);
    });

} else {
    const config = loadConfig('./config.yaml');
    const logger = new Logger(config.server.logLevel);
    const metrics = new Metrics();
    // Register IPC listener so master can aggregate metrics from this worker
    new AggregatorRegistry();
    const cache = new Cache(logger, config.server.dbPath);
    const proxyService = new ProxyService(cache, logger, metrics);

    const networkMap = new Map(config.networks.map(n => [n.name, n]));

    const app = Fastify({ bodyLimit: 1_048_576 });

    app.post<{ Params: { networkName: string } }>('/:networkName', async (request, reply) => {
        const { networkName } = request.params;
        const network = networkMap.get(networkName);

        if (!network) {
            reply.code(404);
            return { error: { code: -32602, message: "Network not found in config" } };
        }

        const body = request.body as any;

        if (Array.isArray(body)) {
            return Promise.all(
                body.map(single => proxyService.handleRequest(network, single))
            );
        }

        return proxyService.handleRequest(network, body);
    });

    app.get('/health', async () => {
        return { status: "OK", activeRequests: proxyService.activeRequests, pid: process.pid };
    });

    const start = async () => {
        try {
            await app.listen({ port: config.server.port, host: '0.0.0.0' });
            logger.info(`Worker ${process.pid} ready`);
        } catch (err: any) {
            logger.error(`Worker ${process.pid} failed to start: ${err.message}`);
            process.exit(1);
        }
    };

    function gracefulShutdown(signal: string) {
        logger.info(`Worker ${process.pid}: ${signal} — draining`);
        app.close().then(() => {
            cache.close();
            process.exit(0);
        });

        setTimeout(() => {
            logger.warn(`Worker ${process.pid}: shutdown timeout — forcing exit`);
            cache.close();
            process.exit(1);
        }, 15000).unref();
    }

    process.on('SIGINT', () => gracefulShutdown('SIGINT'));
    process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));

    process.on('uncaughtException', (err) => {
        logger.error(`Uncaught exception: ${err.message}`);
        if (err.message && err.message.startsWith('SQLITE_')) {
            logger.warn(`Non-fatal SQLite error, continuing with memory cache`);
            return;
        }
        gracefulShutdown('uncaughtException');
    });
    process.on('unhandledRejection', (reason) => {
        logger.error(`Unhandled rejection: ${reason}`);
    });

    start();
}
