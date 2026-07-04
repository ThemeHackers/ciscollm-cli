import { readFileSync } from 'fs';
import { MultiAgentCoordinator } from '../../core/agent/MultiAgentCoordinator';
import { PlinkSerialSession } from '../../infrastructure/protocols/PlinkSerial';
import { SshSession } from '../../infrastructure/protocols/SshSession';
import { TelnetSession } from '../../infrastructure/protocols/TelnetSession';
import { LLMClient, LLMProvider } from '../../infrastructure/llm/LLMClient';
import { logger, createSpinner } from '../ui/ui';

export async function monitorAction(
    options: any,
    coordinatorWrapper: { active: MultiAgentCoordinator | null },
    cleanup: () => Promise<void>
) {
    let provider = options.provider as LLMProvider;
    let localType = options.localType as string | undefined;
    if (localType) {
        localType = localType.toLowerCase().trim();
        if (localType === 'llmstudio') {
            localType = 'lmstudio';
        }
    }
    let apiKey = options.api_key || options.apiKey;
    let model = options.model;
    let endpoint = options.endpoint;
    let protocol = options.protocol;
    let com = options.com;
    let baud = options.baud;
    let host = options.host;
    let port = options.port;
    let username = options.username;
    let privateKey: string | undefined;
    if (options.privateKey) {
        privateKey = readFileSync(options.privateKey, 'utf8');
    }

    let password = options.envPassword
        ? (process.env.CISCOLLM_PASS || '')
        : options.password;
    let nonInteractive = options.nonInteractive === true;
    let minConfidence = parseFloat(options.minConfidence || '0.80');

    logger.banner();
    logger.info(`Initializing auto-healing monitoring in [${provider.toUpperCase()}] mode...`);

    if (!localType) localType = 'ollama';

    coordinatorWrapper.active = new MultiAgentCoordinator();

    try {
        if (protocol === 'serial') {
            if (!com) {
                throw new Error('COM port (-c, --com) is required for serial protocol connections.');
            }
            const ports = com.split(',').map((p: string) => p.trim()).filter((p: string) => p.length > 0);
            for (const port of ports) {
                const session = new PlinkSerialSession(port, parseInt(baud, 10));
                coordinatorWrapper.active.registerSession(port, session);
            }
        } else if (protocol === 'ssh') {
            if (!host || !username) {
                throw new Error('Host (--host) and Username (-u, --username) are required for SSH connections.');
            }
            const hosts = host.split(',').map((h: string) => h.trim()).filter((h: string) => h.length > 0);
            for (const h of hosts) {
                const session = new SshSession({
                    host: h,
                    port: port ? parseInt(port, 10) : 22,
                    username: username,
                    password: password
                });
                coordinatorWrapper.active.registerSession(h, session);
            }
        } else if (protocol === 'telnet') {
            if (!host) {
                throw new Error('Host (--host) is required for Telnet connections.');
            }
            const hosts = host.split(',').map((h: string) => h.trim()).filter((h: string) => h.length > 0);
            for (const h of hosts) {
                const session = new TelnetSession({
                    host: h,
                    port: port ? parseInt(port, 10) : 23,
                    username: username,
                    password: password
                });
                coordinatorWrapper.active.registerSession(h, session);
            }
        } else {
            throw new Error(`Unsupported protocol for monitoring: ${protocol}`);
        }

        if (provider === 'local' && !endpoint) {
            if (localType === 'lmstudio') {
                endpoint = 'http://127.0.0.1:1234/v1';
            } else {
                endpoint = 'http://127.0.0.1:11434/v1';
            }
        }

        const localAIClient = new LLMClient(
            provider,
            endpoint,
            model,
            apiKey,
            localType
        );

        const llmSpinner = createSpinner('Preflight check: validating LLM endpoint reachability...').start();
        try {
            await localAIClient.ensureReachable();
            llmSpinner.succeed('LLM endpoint is ready.');
        } catch (err: any) {
            llmSpinner.fail('LLM endpoint preflight failed.');
            throw err;
        }

        const connSpinner = createSpinner('Connecting to target network devices...').start();
        try {
            await coordinatorWrapper.active.connectAll();
            connSpinner.succeed('All hardware sessions synchronized successfully.');
        } catch (err: any) {
            connSpinner.fail('Connection failed.');
            throw err;
        }

        const { AutoHealer } = require('../../core/agent/AutoHealer');
        const healer = new AutoHealer(localAIClient, coordinatorWrapper.active, {
            nonInteractive,
            minConfidence
        });
        healer.start();

        logger.info('Monitoring active. Press Ctrl+C to terminate session.');
        await new Promise(() => {});

    } catch (err: any) {
        logger.critical(`Monitoring Error: ${err.message}`);
    } else {
        await cleanup();
        logger.info('Session Terminated. Pipelines detached.');
        process.exit(0);
    }
}
