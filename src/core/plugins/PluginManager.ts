import { readFileSync, existsSync, readdirSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { execFile } from 'child_process';
import { logger } from '../../cli/ui/ui';

export interface PluginDefinition {
    name: string;
    description: string;
    script: string;
    parameters: any;
    pluginDir: string;
}

export class PluginManager {
    private plugins: Map<string, PluginDefinition> = new Map();
    private static instance: PluginManager;

    private constructor() {
        this.discoverPlugins();
    }

    public static getInstance(): PluginManager {
        if (!PluginManager.instance) {
            PluginManager.instance = new PluginManager();
        }
        return PluginManager.instance;
    }

    private discoverPlugins() {
        const searchPaths = [
            join(homedir(), '.ciscollm', 'plugins'),
            join(process.cwd(), 'plugins')
        ];

        for (const basePath of searchPaths) {
            if (!existsSync(basePath)) continue;

            try {
                const entries = readdirSync(basePath, { withFileTypes: true });
                for (const entry of entries) {
                    if (entry.isDirectory()) {
                        const pluginDir = join(basePath, entry.name);
                        const manifestPath = join(pluginDir, 'plugin.json');
                        if (existsSync(manifestPath)) {
                            try {
                                const manifestData = readFileSync(manifestPath, 'utf8');
                                const manifest = JSON.parse(manifestData);
                                
                                if (manifest.name && manifest.description && manifest.script && manifest.parameters) {
                                    this.plugins.set(manifest.name, {
                                        ...manifest,
                                        pluginDir
                                    });
                                } else {
                                    logger.warn(`Invalid plugin.json in ${pluginDir}. Missing required fields.`);
                                }
                            } catch (e: any) {
                                logger.warn(`Failed to parse plugin.json in ${pluginDir}: ${e.message}`);
                            }
                        }
                    }
                }
            } catch (e: any) {
                logger.warn(`Failed to read plugin directory ${basePath}: ${e.message}`);
            }
        }
        
        if (this.plugins.size > 0) {
            logger.info(`Loaded ${this.plugins.size} plugin tool(s) automatically.`);
        }
    }

    public getDynamicTools(): any[] {
        const tools: any[] = [];
        for (const [name, def] of this.plugins.entries()) {
            tools.push({
                type: 'function',
                function: {
                    name: def.name,
                    description: def.description,
                    parameters: def.parameters
                }
            });
        }
        return tools;
    }

    public hasPlugin(name: string): boolean {
        return this.plugins.has(name);
    }

    public static parseScriptCommand(script: string): { command: string; args: string[] } {
        const parts = script.match(/(?:[^"\s]+|"[^"]*")+/g) || [];
        const tokens = parts.map((part) => part.replace(/^"(.*)"$/, '$1'));

        if (tokens.length === 0) {
            throw new Error('Plugin script is empty.');
        }

        return {
            command: tokens[0],
            args: tokens.slice(1)
        };
    }

    public executePlugin(name: string, args: any): Promise<string> {
        return new Promise((resolve) => {
            const def = this.plugins.get(name);
            if (!def) {
                return resolve(`Error: Plugin ${name} not found.`);
            }

            const env = { ...process.env };
            for (const [key, value] of Object.entries(args)) {
                env[`CISCOLLM_ARG_${key.toUpperCase()}`] = String(value);
            }

            let argsJson = JSON.stringify(args).replace(/"/g, '\\"');
            if (process.platform === 'win32') {
                argsJson = argsJson.replace(/\\"/g, '""');
            }

            let commandParts: { command: string; args: string[] };
            try {
                commandParts = PluginManager.parseScriptCommand(def.script);
            } catch (error: any) {
                return resolve(`Error: Invalid plugin script for ${name}: ${error.message}`);
            }

            execFile(commandParts.command, [...commandParts.args, argsJson], { cwd: def.pluginDir, env }, (error, stdout, stderr) => {
                if (error) {
                    resolve(`PLUGIN ERROR:\n${stderr || error.message}`);
                } else {
                    resolve(stdout || stderr || 'Plugin executed successfully with no output.');
                }
            });
        });
    }
}
