import chalk from 'chalk';
import { LLMClient } from '../../infrastructure/llm/LLMClient';
import { MultiAgentCoordinator } from '../../core/agent/MultiAgentCoordinator';
import { AutoRemediationEngine } from '../../core/agent/AutoRemediationEngine';
import { SshSession } from '../../infrastructure/protocols/SshSession';
import { TelnetSession } from '../../infrastructure/protocols/TelnetSession';
import { PlinkSerialSession } from '../../infrastructure/protocols/PlinkSerial';
import { logger } from '../ui/ui';

export async function daemonAction(options: any, coordinatorWrapper: { active: MultiAgentCoordinator | null }, cleanup: () => Promise<void>) {
    console.log(chalk.cyan(`\n[*] Starting Self-Healing Daemon Mode...`));

    try {
        let endpoint = options.endpoint || 'http://127.0.0.1:1234/v1';
        if (options.localType === 'ollama') endpoint = 'http://127.0.0.1:11434/v1';

        const localAIClient = new LLMClient('local', endpoint, options.model, undefined, options.localType || 'lmstudio');
        coordinatorWrapper.active = new MultiAgentCoordinator();

        let password = options.envPassword ? (process.env.CISCOLLM_PASS || '') : options.password;
        let protocol = options.protocol || 'serial';

        if (protocol === 'serial' && options.com) {
            const ports = options.com.split(',').map((p: string) => p.trim());
            for (const port of ports) coordinatorWrapper.active.registerSession(port, new PlinkSerialSession(port, parseInt(options.baud || '9600', 10)));
        } else if (protocol === 'ssh' && options.host && options.username) {
            const hosts = options.host.split(',').map((h: string) => h.trim());
            for (const h of hosts) coordinatorWrapper.active.registerSession(h, new SshSession({ host: h, port: options.port ? parseInt(options.port, 10) : 22, username: options.username, password }));
        } else if (protocol === 'telnet' && options.host) {
            const hosts = options.host.split(',').map((h: string) => h.trim());
            for (const h of hosts) coordinatorWrapper.active.registerSession(h, new TelnetSession({ host: h, port: options.port ? parseInt(options.port, 10) : 23, username: options.username, password }));
        } else {
            throw new Error('Missing connection parameters for daemon mode (host/com, username).');
        }

        await localAIClient.ensureReachable();
        await coordinatorWrapper.active.connectAll();

        const remediationEngine = new AutoRemediationEngine(localAIClient, coordinatorWrapper.active, options.webhookUrl);
        
        console.log(chalk.green(`\n[+] Daemon is now actively monitoring the network (polling every 15 seconds). Press Ctrl+C to exit.\n`));

        let isRunning = true;
        const pollInterval = 15000;

        const poll = async () => {
            if (!isRunning) return;
            const health = await remediationEngine.checkHealth();
            if (!health.healthy && health.issue) {
                await remediationEngine.autoRemediate(health.issue);
                console.log(chalk.cyan('\n[*] Resuming normal monitoring...\n'));
            }
            if (isRunning) setTimeout(poll, pollInterval);
        };

        poll();

    } catch (err: any) {
        logger.critical(`Daemon Initialization Error: ${err.message}`);
        await cleanup();
        process.exit(1);
    }
}


