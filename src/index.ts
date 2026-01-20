import express from 'express';
import bodyParser from 'body-parser';
import { loadConfig } from './config';
import { Cache } from './cache';
import { ProxyService } from './proxy';
import { Logger } from './logger';

const config = loadConfig('./config.yaml');
const app = express();
const logger = new Logger(config.server.logLevel);
const cache = new Cache(logger, config.server.dbPath);
const proxyService = new ProxyService(cache, logger);

app.use(bodyParser.json());

// Main route: /:networkName
app.post('/:networkName', async (req, res) => {
    const { networkName } = req.params;
    const network = config.networks.find(n => n.name === networkName);

    if (!network) {
        res.status(404).json({ error: { code: -32602, message: "Network not found in config" } });
        return;
    }

    try {
        const response = await proxyService.handleRequest(network, req.body);
        res.json(response);
    } catch (e: any) {
        logger.error(`Error processing request for ${networkName}: ${e}`);
        res.status(500).json({ error: { code: -32603, message: "Internal server error" } });
    }
});

// Stats or health check
app.get('/health', (req, res) => {
    res.send("OK");
});

app.listen(config.server.port, () => {
    logger.info(`Super RPC listening on port ${config.server.port}`);
    logger.info(`Configured networks: ${config.networks.map(n => n.name).join(', ')}`);
});

// Cleanup
process.on('SIGINT', () => {
    cache.close();
    process.exit();
});
