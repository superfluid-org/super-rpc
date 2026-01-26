import fs from 'fs';
import yaml from 'js-yaml';

export interface NetworkConfig {
    name: string;
    primary: string;
    fallback: string;
}

export interface Config {
    server: {
        port: number;
        dbPath: string;
        logLevel?: string;
    };
    networks: NetworkConfig[];
}

export function loadConfig(path: string): Config {
    try {
        const fileContents = fs.readFileSync(path, 'utf8');
        const config = yaml.load(fileContents) as Config;

        // Basic validation
        if (!config.server || !config.server.port) {
            throw new Error("Config missing server.port");
        }
        if (!config.networks || !Array.isArray(config.networks)) {
            throw new Error("Config missing networks array");
        }

        return config;
    } catch (e) {
        console.error(`Failed to load config from ${path}:`, e);
        process.exit(1);
    }
}
