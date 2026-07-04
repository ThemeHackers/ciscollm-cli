#!/usr/bin/env node
import { Command } from 'commander';
import chalk from 'chalk';
import { MultiAgentCoordinator } from './core/agent/MultiAgentCoordinator';
import { PlinkSerialSession } from './infrastructure/protocols/PlinkSerial';
import { logger } from './cli/ui/ui';
import { readFileSync } from 'fs';
import { join } from 'path';


import { runAction } from './cli/commands/runCommand';
import { monitorAction } from './cli/commands/monitorCommand';
import { serverAction } from './cli/commands/serverCommand';

const program = new Command();
const coordinatorWrapper: { active: MultiAgentCoordinator | null } = { active: null };

const cleanup = async () => {
    if (coordinatorWrapper.active) {
        logger.info('Cleaning up active terminal connections and sub-processes...');
        try {
            await coordinatorWrapper.active.disconnectAll();
        } catch (e: any) {
            logger.error(`Cleanup Error: ${e.message}`);
        }
        coordinatorWrapper.active = null;
    }
};

process.on('SIGINT', async () => {
    logger.warn('SIGINT received. Shutting down...');
    await cleanup();
    process.exit(130);
});

process.on('SIGTERM', async () => {
    logger.warn('SIGTERM received. Shutting down...');
    await cleanup();
    process.exit(143);
});

process.on('exit', () => {
    if (coordinatorWrapper.active) {
        for (const [id, session] of coordinatorWrapper.active.getSessions().entries()) {
            if (session instanceof PlinkSerialSession) {
                const proc = session.getProcess();
                if (proc && !proc.killed) {
                    console.log(chalk.red(`[index.ts]: Killing Plink sub-process for "${id}" on exit...`));
                    proc.kill('SIGKILL');
                }
            }
        }
    }
});

process.on('uncaughtException', async (err) => {
    logger.critical(`Uncaught Exception: ${err.stack || err.message}`);
    await cleanup();
    process.exit(1);
});

let cliVersion = '1.0.0';
try {
    const pkgPath = join(__dirname, '../package.json');
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
    cliVersion = pkg.version;
} catch (e) {}

program
    .name('ciscollm')
    .description('Autonomous Agent Interface managing local Cisco Hardware using LLM Tooling.')
    .version(cliVersion);

function addConnectionOptions(cmd: Command) {
    return cmd
        .option('--protocol <type>', 'Connection protocol (serial | ssh | telnet)', 'serial')
        .option('--provider <type>', 'LLM provider mode (local | cloud)', 'local')
        .option('--api-key <key>', 'API key for cloud provider (OpenRouter)')
        .option('-c, --com <ports>', 'COM Port interface identifier(s), comma-separated (e.g. COM3 or COM3,COM4)')
        .option('-b, --baud <rate>', 'Serial transmission baud rate constraint', '9600')
        .option('--host <address>', 'Target IP address or hostname (comma-separated for multi-device)')
        .option('--port <port>', 'Target connection port')
        .option('-u, --username <name>', 'Device login username')
        .option('-p, --password <pass>', 'Device login password')
        .option('--env-password', 'Read device password from $CISCOLLM_PASS environment variable (safe for special chars)')
        .option('--private-key <path>', 'SSH private key file path for protocols that support key-based auth')
        .option('--passphrase <passphrase>', 'Passphrase for the SSH private key file')
        .option('--local-type <type>', 'Local service type (ollama | lmstudio)')
        .option('--model <name>', 'Model name for compilation')
        .option('--endpoint <url>', 'Ollama/LM Studio/compatibility API server endpoint')
        .option('--sessions <name>', 'Session name to save/load connection setup');
}

const runCmd = program
    .command('run')
    .description('Execute network configuration or optimization tasks on target Cisco hardware');
addConnectionOptions(runCmd)
    .option('--strict-command-ref', 'Enable strict command validation against cf_command_ref.pdf index')
    .option('--no-ref-telemetry', 'Disable command-reference telemetry logs during startup')
    .option('--non-interactive', 'Disable interactive human-in-the-loop prompts (automatically reject dangerous commands)')
    .option('--rbac-role <role>', 'Role-based Access Control role (admin | read_only)', 'admin')
    .option('-g, --goal <intent>', 'The execution goal for the agent to achieve')
    .action(async (options) => {
        await runAction(options, coordinatorWrapper, cleanup);
    });

const monitorCmd = program
    .command('monitor')
    .description('Start the Closed-Loop Auto-Diagnosis & Healing Monitor (AIOps)');
addConnectionOptions(monitorCmd)
    .option('--non-interactive', 'Enable completely autonomous, non-interactive healing')
    .option('--min-confidence <confidence>', 'Minimum AI confidence threshold to apply remediation', '0.80')
    .action(async (options) => {
        await monitorAction(options, coordinatorWrapper, cleanup);
    });

program
    .command('server')
    .description('Start the Cisco IOS Multi-Protocol Test Simulator (SSH, Telnet, and HTTP LLM Mock)')
    .option('--ssh-port <port>', 'Port for the mock SSH server', '2222')
    .option('--telnet-port <port>', 'Port for the mock Telnet server', '2323')
    .option('--http-port <port>', 'Port for the mock HTTP LLM server', '11434')
    .action((options) => {
        serverAction(options);
    });


program.parse(process.argv);
