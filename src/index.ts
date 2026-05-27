#!/usr/bin/env node
import { Command } from 'commander';
import inquirer from 'inquirer';
import chalk from 'chalk';
import { MultiAgentCoordinator } from './core/agent/MultiAgentCoordinator';
import { PlinkSerialSession } from './infrastructure/protocols/PlinkSerial';
import { SshSession } from './infrastructure/protocols/SshSession';
import { TelnetSession } from './infrastructure/protocols/TelnetSession';
import { LLMClient, LLMProvider } from './infrastructure/llm/LLMClient';
import { CiscoAgentLoop } from './core/agent/AgentLoop';
import { MockSession } from './infrastructure/protocols/MockSession';
import { NetconfSession } from './infrastructure/protocols/NetconfSession';
import { CmlSession } from './infrastructure/protocols/CmlSession';
import { logger, createSpinner } from './cli/ui/ui';
import { readFileSync } from 'fs';

const program = new Command();
let activeCoordinator: MultiAgentCoordinator | null = null;


const cleanup = async () => {
    if (activeCoordinator) {
        logger.info('Cleaning up active terminal connections and sub-processes...');
        try {
            await activeCoordinator.disconnectAll();
        } catch (e: any) {
            logger.error(`Cleanup Error: ${e.message}`);
        }
        activeCoordinator = null;
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
    
    if (activeCoordinator) {
        for (const [id, session] of activeCoordinator.getSessions().entries()) {
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

program
    .name('ciscollm')
    .description('Autonomous Agent Interface managing local Cisco Hardware using LLM Tooling.')
    .version('1.0.0');

program
    .command('run')
    .description('Execute network configuration or optimization tasks on target Cisco hardware')
    .option('--protocol <type>', 'Connection protocol (serial | ssh | telnet | mock | netconf | cml)', 'serial')
    
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
    .option('--netconf-ready-timeout <ms>', 'NETCONF SSH ready timeout in milliseconds')
    .option('--netconf-hello-timeout <ms>', 'NETCONF hello exchange timeout in milliseconds')
    .option('--netconf-rpc-timeout <ms>', 'NETCONF RPC timeout in milliseconds')
    .option('--netconf-keepalive-interval <ms>', 'NETCONF SSH keepalive interval in milliseconds')
    
    .option('--local-type <type>', 'Local service type (ollama | lmstudio)')
    .option('--model <name>', 'Model name for compilation')
    .option('--endpoint <url>', 'Ollama/LM Studio/compatibility API server endpoint')
    .option('--strict-command-ref', 'Enable strict command validation against cf_command_ref.pdf index')
    .option('--no-ref-telemetry', 'Disable command-reference telemetry logs during startup')
    .option('--non-interactive', 'Disable interactive human-in-the-loop prompts (automatically reject dangerous commands)')
    .option('--rbac-role <role>', 'Role-based Access Control role (admin | read_only)', 'admin')
    
    .option('-g, --goal <intent>', 'The execution goal for the agent to achieve')
    .action(async (options) => {
        let provider = options.provider as LLMProvider;
        let localType = options.localType as string | undefined;
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
        let netconfPassphrase = options.passphrase;

        let password = options.envPassword
            ? (process.env.CISCOLLM_PASS || '')
            : options.password;
        let goal = options.goal;
        let strictCommandRef = options.strictCommandRef === true;
        let refTelemetry = options.refTelemetry !== false;
        let nonInteractive = options.nonInteractive === true;
        let rbacRole = options.rbacRole || 'admin';

        if (nonInteractive) {
            process.env.CISCOLLM_NON_INTERACTIVE = 'true';
        }

     
        if (goal && !localType && provider === 'local') {
            const { chosenLocalType } = await inquirer.prompt([
                {
                    type: 'list',
                    name: 'chosenLocalType',
                    message: chalk.cyan('Select Local LLM Service:'),
                    choices: [
                        { name: `${chalk.green('●')} Ollama          ${chalk.dim('(http://127.0.0.1:11434/v1)')}`, value: 'ollama' },
                        { name: `${chalk.magenta('●')} LM Studio       ${chalk.dim('(http://127.0.0.1:1234/v1)')}`, value: 'lmstudio' },
                        { name: `${chalk.yellow('●')} OpenRouter      ${chalk.dim('(Cloud API)')}`, value: '__cloud__' }
                    ],
                    default: 'ollama'
                }
            ]);
            if (chosenLocalType === '__cloud__') {
                provider = 'cloud';
                localType = undefined;
                if (!apiKey) {
                    const { key } = await inquirer.prompt([{ type: 'password', name: 'key', message: 'OpenRouter API Key:' }]);
                    apiKey = key;
                }
            } else {
                localType = chosenLocalType;
            }
        }

        if (!localType) localType = 'ollama';

        
        if (!goal) {
            logger.heading('Cisco LLM Agent Interactive Setup Wizard');

            const detectedComs = await PlinkSerialSession.listAvailableComPorts();
            if (detectedComs.length > 0) {
                logger.info(`Detected active COM ports on system: ${chalk.bold.yellow(detectedComs.join(', '))}`);
            }

            type StepName = 
                | 'PROVIDER'
                | 'LOCAL_TYPE'
                | 'API_KEY'
                | 'MODEL'
                | 'ENDPOINT'
                | 'PROTOCOL'
                | 'SERIAL_COM'
                | 'SERIAL_BAUD'
                | 'IP_HOST'
                | 'IP_PORT'
                | 'IP_USER'
                | 'IP_PASS'
                | 'NETCONF_AUTH'
                | 'NETCONF_KEY_PATH'
                | 'NETCONF_PASSPHRASE'
                | 'GOAL'
                | 'CONFIRMATION';

            let currentStep: StepName = 'PROVIDER';
            const history: StepName[] = [];

            const answers: any = {
                provider: provider || 'local',
                localType: localType || 'ollama',
                apiKey: apiKey || '',
                model: model || '',
                endpoint: endpoint || '',
                protocol: protocol || 'serial',
                com: com || '',
                baud: baud || '9600',
                host: host || '',
                port: port || '',
                username: username || '',
                password: password || '',
                netconfAuth: 'password',
                netconfPrivateKey: '',
                netconfPassphrase: '',
                goal: ''
            };

            const goForward = (nextStep: StepName) => {
                history.push(currentStep);
                currentStep = nextStep;
            };

            const goBack = () => {
                if (history.length > 0) {
                    currentStep = history.pop()!;
                } else {
                    logger.warn('Already at the first step.');
                }
            };

            const refreshConsole = () => {
                console.clear();
                logger.heading('Cisco LLM Agent Interactive Setup Wizard');
                if (detectedComs.length > 0) {
                    logger.info(`Detected active COM ports on system: ${chalk.bold.yellow(detectedComs.join(', '))}`);
                }
                console.log('');
            };

            while (currentStep !== 'CONFIRMATION') {
                refreshConsole();
                switch (currentStep as StepName) {
                    case 'PROVIDER': {
                        const ans = await inquirer.prompt([
                            {
                                type: 'list',
                                name: 'provider',
                                message: 'Select LLM Provider:',
                                choices: [
                                    { name: 'Local (Ollama / LM Studio)', value: 'local' },
                                    { name: 'Cloud (OpenRouter)', value: 'cloud' }
                                ],
                                default: answers.provider
                            }
                        ]);
                        answers.provider = ans.provider;
                        if (answers.provider === 'local') {
                            goForward('LOCAL_TYPE');
                        } else {
                            goForward('API_KEY');
                        }
                        break;
                    }

                    case 'LOCAL_TYPE': {
                        const ans = await inquirer.prompt([
                            {
                                type: 'list',
                                name: 'localType',
                                message: 'Select Local LLM Service:',
                                choices: [
                                    { name: 'Ollama', value: 'ollama' },
                                    { name: 'LM Studio', value: 'lmstudio' },
                                    { name: chalk.dim('< Go Back'), value: '__back__' }
                                ],
                                default: answers.localType
                            }
                        ]);
                        if (ans.localType === '__back__') {
                            goBack();
                        } else {
                            answers.localType = ans.localType;
                            goForward('MODEL');
                        }
                        break;
                    }

                    case 'API_KEY': {
                        const ans = await inquirer.prompt([
                            {
                                type: 'input',
                                name: 'apiKey',
                                message: 'Enter OpenRouter API Key (or type "back" to go back):',
                                default: answers.apiKey || undefined
                            }
                        ]);
                        if (ans.apiKey.trim().toLowerCase() === 'back') {
                            goBack();
                        } else {
                            answers.apiKey = ans.apiKey;
                            goForward('MODEL');
                        }
                        break;
                    }

                    case 'MODEL': {
                        const defaultModel = answers.model || (answers.provider === 'cloud' 
                            ? 'nvidia/nemotron-3-super-120b-a12b:free' 
                            : 'qwen3.5:4b');

                        const ans = await inquirer.prompt([
                            {
                                type: 'input',
                                name: 'model',
                                message: 'Enter LLM Model Name (or type "back" to go back):',
                                default: defaultModel
                            }
                        ]);
                        if (ans.model.trim().toLowerCase() === 'back') {
                            goBack();
                        } else {
                            answers.model = ans.model;
                            goForward('ENDPOINT');
                        }
                        break;
                    }

                    case 'ENDPOINT': {
                        const defaultEndpoint = answers.endpoint || (answers.provider === 'cloud'
                            ? 'https://openrouter.ai/api/v1'
                            : (answers.localType === 'lmstudio'
                                ? 'http://127.0.0.1:1234/v1'
                                : 'http://127.0.0.1:11434/v1'));

                        const ans = await inquirer.prompt([
                            {
                                type: 'input',
                                name: 'endpoint',
                                message: 'Enter LLM API Endpoint URL (or type "back" to go back):',
                                default: defaultEndpoint
                            }
                        ]);
                        if (ans.endpoint.trim().toLowerCase() === 'back') {
                            goBack();
                        } else {
                            answers.endpoint = ans.endpoint;
                            goForward('PROTOCOL');
                        }
                        break;
                    }

                    case 'PROTOCOL': {
                        const ans = await inquirer.prompt([
                            {
                                type: 'list',
                                name: 'protocol',
                                message: 'Select Connection Protocol:',
                                choices: [
                                    { name: 'serial', value: 'serial' },
                                    { name: 'ssh', value: 'ssh' },
                                    { name: 'telnet', value: 'telnet' },
                                    { name: 'netconf', value: 'netconf' },
                                    { name: 'cml', value: 'cml' },
                                    { name: 'mock', value: 'mock' },
                                    { name: chalk.dim('< Go Back'), value: '__back__' }
                                ],
                                default: answers.protocol
                            }
                        ]);
                        if (ans.protocol === '__back__') {
                            goBack();
                        } else {
                            answers.protocol = ans.protocol;
                            if (answers.protocol === 'serial') {
                                goForward('SERIAL_COM');
                            } else if (
                                answers.protocol === 'ssh' || 
                                answers.protocol === 'telnet' || 
                                answers.protocol === 'netconf' || 
                                answers.protocol === 'cml'
                            ) {
                                goForward('IP_HOST');
                            } else {
                                goForward('GOAL');
                            }
                        }
                        break;
                    }

                    case 'SERIAL_COM': {
                        if (detectedComs.length > 0) {
                            const choices = detectedComs.map(port => ({ name: port, value: port }));
                            choices.push({ name: 'Enter COM port(s) manually', value: '__manual__' });
                            choices.push({ name: chalk.dim('< Go Back'), value: '__back__' });

                            const ans = await inquirer.prompt([
                                {
                                    type: 'checkbox',
                                    name: 'coms',
                                    message: 'Select COM Port(s) (Use Space to select, Enter to confirm):',
                                    choices: choices,
                                    validate: (input) => {
                                        if (input.length === 0) {
                                            return 'You must select at least one option.';
                                        }
                                        if (input.includes('__back__') && input.length > 1) {
                                            return 'Cannot select "< Go Back" along with other ports.';
                                        }
                                        if (input.includes('__manual__') && input.length > 1) {
                                            return 'Cannot select "Enter COM port(s) manually" along with other ports.';
                                        }
                                        return true;
                                    }
                                }
                            ]);

                            if (ans.coms.includes('__back__')) {
                                goBack();
                            } else if (ans.coms.includes('__manual__')) {
                                const manualAns = await inquirer.prompt([
                                    {
                                        type: 'input',
                                        name: 'com',
                                        message: 'Enter COM Port name(s) (comma-separated, e.g. COM3 or COM3,COM4):',
                                        validate: (input) => input.trim().length > 0 ? true : 'COM port is required.'
                                    }
                                ]);
                                answers.com = manualAns.com;
                                goForward('SERIAL_BAUD');
                            } else {
                                answers.com = ans.coms.join(',');
                                goForward('SERIAL_BAUD');
                            }
                        } else {
                            const ans = await inquirer.prompt([
                                {
                                    type: 'input',
                                    name: 'com',
                                    message: 'Enter COM Port name(s) (comma-separated, e.g. COM3 or COM3,COM4) (or type "back" to go back):',
                                    default: answers.com || undefined,
                                    validate: (input) => {
                                        if (input.trim().toLowerCase() === 'back') return true;
                                        return input.trim().length > 0 ? true : 'COM port is required.';
                                    }
                                }
                            ]);
                            if (ans.com.trim().toLowerCase() === 'back') {
                                goBack();
                            } else {
                                answers.com = ans.com;
                                goForward('SERIAL_BAUD');
                            }
                        }
                        break;
                    }

                    case 'SERIAL_BAUD': {
                        const ans = await inquirer.prompt([
                            {
                                type: 'list',
                                name: 'baud',
                                message: 'Select Serial Baud Rate:',
                                choices: [
                                    '9600', '19200', '38400', '57600', '115200',
                                    { name: chalk.dim('< Go Back'), value: '__back__' }
                                ],
                                default: answers.baud
                            }
                        ]);
                        if (ans.baud === '__back__') {
                            goBack();
                        } else {
                            answers.baud = ans.baud;
                            goForward('GOAL');
                        }
                        break;
                    }

                    case 'IP_HOST': {
                        const ans = await inquirer.prompt([
                            {
                                type: 'input',
                                name: 'host',
                                message: 'Enter Target IP address(es) / Hostname(s) (comma-separated) (or type "back" to go back):',
                                default: answers.host || undefined,
                                validate: (input) => {
                                    if (input.trim().toLowerCase() === 'back') return true;
                                    return input.trim().length > 0 ? true : 'Host address is required.';
                                }
                            }
                        ]);
                        if (ans.host.trim().toLowerCase() === 'back') {
                            goBack();
                        } else {
                            answers.host = ans.host;
                            goForward('IP_PORT');
                        }
                        break;
                    }

                    case 'IP_PORT': {
                        const ans = await inquirer.prompt([
                            {
                                type: 'input',
                                name: 'port',
                                message: 'Enter Connection Port (leave empty for default) (or type "back" to go back):',
                                default: answers.port || undefined
                            }
                        ]);
                        if (ans.port.trim().toLowerCase() === 'back') {
                            goBack();
                        } else {
                            answers.port = ans.port;
                            goForward('IP_USER');
                        }
                        break;
                    }

                    case 'IP_USER': {
                        const ans = await inquirer.prompt([
                            {
                                type: 'input',
                                name: 'username',
                                message: 'Enter Device Username (leave empty if none) (or type "back" to go back):',
                                default: answers.username || undefined
                            }
                        ]);
                        if (ans.username.trim().toLowerCase() === 'back') {
                            goBack();
                        } else {
                            answers.username = ans.username;
                            goForward(answers.protocol === 'netconf' ? 'NETCONF_AUTH' : 'IP_PASS');
                        }
                        break;
                    }

                    case 'NETCONF_AUTH': {
                        const ans = await inquirer.prompt([
                            {
                                type: 'list',
                                name: 'netconfAuth',
                                message: 'NETCONF authentication method: choose password or SSH key-based auth.',
                                choices: [
                                    { name: 'Password login', value: 'password' },
                                    { name: 'SSH private key', value: 'key' },
                                    { name: chalk.dim('< Go Back'), value: '__back__' }
                                ],
                                default: answers.netconfAuth || 'password'
                            }
                        ]);

                        if (ans.netconfAuth === '__back__') {
                            goBack();
                        } else {
                            answers.netconfAuth = ans.netconfAuth;
                            goForward(ans.netconfAuth === 'key' ? 'NETCONF_KEY_PATH' : 'IP_PASS');
                        }
                        break;
                    }

                    case 'NETCONF_KEY_PATH': {
                        const ans = await inquirer.prompt([
                            {
                                type: 'input',
                                name: 'netconfPrivateKey',
                                message: 'Enter SSH private key file path for NETCONF (or type "back" to change auth method):',
                                default: answers.netconfPrivateKey || undefined,
                                validate: (input) => {
                                    if (input.trim().toLowerCase() === 'back') return true;
                                    return input.trim().length > 0 ? true : 'Private key path is required for key-based auth.';
                                }
                            }
                        ]);

                        if (ans.netconfPrivateKey.trim().toLowerCase() === 'back') {
                            goBack();
                        } else {
                            answers.netconfPrivateKey = ans.netconfPrivateKey;
                            goForward('NETCONF_PASSPHRASE');
                        }
                        break;
                    }

                    case 'NETCONF_PASSPHRASE': {
                        const ans = await inquirer.prompt([
                            {
                                type: 'password',
                                name: 'netconfPassphrase',
                                message: 'Enter SSH key passphrase for NETCONF (leave empty if none) (or type "back" to go back):',
                                default: answers.netconfPassphrase || undefined
                            }
                        ]);

                        if (ans.netconfPassphrase === 'back') {
                            goBack();
                        } else {
                            answers.netconfPassphrase = ans.netconfPassphrase;
                            goForward('GOAL');
                        }
                        break;
                    }

                    case 'IP_PASS': {
                        const ans = await inquirer.prompt([
                            {
                                type: 'password',
                                name: 'password',
                                message: 'Enter Device Password (leave empty if none) (or type "back" to go back):',
                                default: answers.password || undefined
                            }
                        ]);
                        if (ans.password === 'back') {
                            goBack();
                        } else {
                            answers.password = ans.password;
                            goForward('GOAL');
                        }
                        break;
                    }

                    case 'GOAL': {
                        const ans = await inquirer.prompt([
                            {
                                type: 'input',
                                name: 'goal',
                                message: 'Enter your configuration goal for the Cisco device (or type "back" to go back):',
                                default: answers.goal || undefined,
                                validate: (input) => {
                                    if (input.trim().toLowerCase() === 'back') return true;
                                    return input.trim().length > 0 ? true : 'Goal is required.';
                                }
                            }
                        ]);
                        if (ans.goal.trim().toLowerCase() === 'back') {
                            goBack();
                        } else {
                            answers.goal = ans.goal;
                          
                            console.log(chalk.bold.yellow('Configuration Summary:'));
                            console.log(`- LLM Provider:   ${chalk.cyan(answers.provider)}` + (answers.provider === 'local' ? ` (${answers.localType})` : ''));
                            console.log(`- Model Name:     ${chalk.cyan(answers.model || (answers.provider === 'cloud' ? 'nvidia/nemotron-3-super-120b-a12b:free' : 'qwen3.5:4b'))}`);
                            console.log(`- API Endpoint:   ${chalk.cyan(answers.endpoint || 'default')}`);
                            console.log(`- Protocol:       ${chalk.cyan(answers.protocol)}`);
                            if (answers.protocol === 'serial') {
                                console.log(`- COM Port:       ${chalk.cyan(answers.com)}`);
                                console.log(`- Baud Rate:      ${chalk.cyan(answers.baud)}`);
                            } else if (
                                answers.protocol === 'ssh' || 
                                answers.protocol === 'telnet' || 
                                answers.protocol === 'netconf' || 
                                answers.protocol === 'cml'
                            ) {
                                console.log(`- Host Target:    ${chalk.cyan(answers.host)}`);
                                console.log(`- Port:           ${chalk.cyan(answers.port || 'default')}`);
                                console.log(`- Username:       ${chalk.cyan(answers.username || '(none)')}`);
                                if (answers.protocol === 'netconf') {
                                    console.log(`- NETCONF Auth:   ${chalk.cyan(answers.netconfAuth || 'password')}` + (answers.netconfAuth === 'key' ? ` (${chalk.cyan(answers.netconfPrivateKey || '(unset)')})` : ''));
                                }
                            }
                            console.log(`- Config Goal:    ${chalk.green(`"${answers.goal}"`)}`);
                          

                            const confirmAns = await inquirer.prompt([
                                {
                                    type: 'list',
                                    name: 'confirm',
                                    message: 'Proceed with this configuration?',
                                    choices: [
                                        { name: 'Yes, start agent execution', value: 'yes' },
                                        { name: 'No, edit goal again', value: 'edit_goal' },
                                        { name: 'No, start wizard from the beginning', value: 'restart' },
                                        { name: 'Cancel and exit', value: 'cancel' }
                                    ]
                                }
                            ]);

                            if (confirmAns.confirm === 'yes') {
                                currentStep = 'CONFIRMATION';
                            } else if (confirmAns.confirm === 'edit_goal') {
                                currentStep = 'GOAL';
                            } else if (confirmAns.confirm === 'restart') {
                                history.length = 0;
                                currentStep = 'PROVIDER';
                            } else {
                                logger.info('Configuration wizard cancelled.');
                                process.exit(0);
                            }
                        }
                        break;
                    }
                }
            }

            provider = answers.provider;
            localType = answers.localType;
            apiKey = answers.apiKey;
            model = answers.model;
            endpoint = answers.endpoint;
            protocol = answers.protocol;
            com = answers.com;
            baud = answers.baud;
            host = answers.host;
            port = answers.port;
            username = answers.username;
            password = answers.password;
            if (answers.netconfAuth === 'key' && answers.netconfPrivateKey) {
                privateKey = readFileSync(answers.netconfPrivateKey, 'utf8');
            }
            netconfPassphrase = answers.netconfPassphrase || netconfPassphrase;
            goal = answers.goal;
        }

        logger.info(`Initializing system link in [${provider.toUpperCase()}] mode using ${protocol.toUpperCase()}...`);
            logger.info(`Command reference policy: strict=${strictCommandRef ? 'on' : 'off'}, telemetry=${refTelemetry ? 'on' : 'off'}`);
        activeCoordinator = new MultiAgentCoordinator();

        const netconfSessionOptions = {
            username,
            password,
            privateKey,
            passphrase: netconfPassphrase,
            readyTimeoutMs: options.netconfReadyTimeout ? parseInt(options.netconfReadyTimeout, 10) : undefined,
            helloTimeoutMs: options.netconfHelloTimeout ? parseInt(options.netconfHelloTimeout, 10) : undefined,
            rpcTimeoutMs: options.netconfRpcTimeout ? parseInt(options.netconfRpcTimeout, 10) : undefined,
            keepaliveInterval: options.netconfKeepaliveInterval ? parseInt(options.netconfKeepaliveInterval, 10) : undefined
        };

        try {
            
            if (protocol === 'serial') {
                if (!com) {
                    throw new Error('COM port (-c, --com) is required for serial protocol connections.');
                }
                const ports = com.split(',').map((p: string) => p.trim()).filter((p: string) => p.length > 0);
                for (const port of ports) {
                    const session = new PlinkSerialSession(port, parseInt(baud, 10));
                    activeCoordinator.registerSession(port, session);
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
                    activeCoordinator.registerSession(h, session);
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
                    activeCoordinator.registerSession(h, session);
                }
            } else if (protocol === 'mock') {
                const names = (com || host || 'Switch1').split(',').map((n: string) => n.trim()).filter((n: string) => n.length > 0);
                for (const name of names) {
                    const session = new MockSession(name);
                    activeCoordinator.registerSession(name, session);
                }
            } else if (protocol === 'netconf') {
                if (!host) {
                    throw new Error('Host (--host) is required for NETCONF protocol connections.');
                }
                const hosts = host.split(',').map((h: string) => h.trim()).filter((h: string) => h.length > 0);
                for (const h of hosts) {
                    const session = new NetconfSession(h, port ? parseInt(port, 10) : 830, netconfSessionOptions);
                    activeCoordinator.registerSession(h, session);
                }
            } else if (protocol === 'cml') {
                let endpointUrl = host || endpoint || 'http://127.0.0.1:8080';
                if (endpointUrl && !endpointUrl.startsWith('http://') && !endpointUrl.startsWith('https://')) {
                    endpointUrl = `https://${endpointUrl}`;
                }
                const session = new CmlSession(endpointUrl, username, password);
                activeCoordinator.registerSession('cml-sandbox', session);
            } else {
                throw new Error(`Unsupported connection protocol type: ${protocol}`);
            }

            if (provider === 'local' && !endpoint) {
                if (localType === 'lmstudio') {
                    endpoint = 'http://127.0.0.1:1234/v1';
                    logger.info(`LM Studio endpoint: ${chalk.cyan(endpoint)}`);
                } else {
                    endpoint = 'http://127.0.0.1:11434/v1';
                    logger.info(`Ollama endpoint: ${chalk.cyan(endpoint)}`);
                }
            }

            const localAIClient = new LLMClient(
                provider,
                endpoint,
                model,
                apiKey
            );

            const llmSpinner = createSpinner('Preflight check: validating LLM endpoint reachability...').start();
            try {
                await localAIClient.ensureReachable();
                llmSpinner.succeed('LLM endpoint is reachable.');
            } catch (err: any) {
                llmSpinner.fail('LLM endpoint preflight failed.');
                throw err;
            }

            const connSpinner = createSpinner('Connecting to target network devices...').start();
            try {
                await activeCoordinator.connectAll();
                connSpinner.succeed('All hardware sessions synchronized successfully.');
            } catch (err: any) {
                connSpinner.fail('Connection failed.');
                throw err;
            }

            const agent = new CiscoAgentLoop(localAIClient, activeCoordinator, {
                strictReferenceMode: strictCommandRef,
                referenceTelemetry: refTelemetry,
                rbacRole: rbacRole
            });
            await agent.run(goal);

        } catch (err: any) {
            logger.critical(`Execution Error: ${err.message}`);
        } finally {
            await cleanup();
            logger.info('Session Terminated. Pipelines detached.');
            process.exit(0);
        }
    });

program.parse(process.argv);
