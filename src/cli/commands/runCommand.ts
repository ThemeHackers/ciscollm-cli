import inquirer from 'inquirer';
import chalk from 'chalk';
import { readFileSync, writeFileSync, existsSync } from 'fs';
import { join } from 'path';
import { MultiAgentCoordinator } from '../../core/agent/MultiAgentCoordinator';
import { PlinkSerialSession } from '../../infrastructure/protocols/PlinkSerial';
import { SshSession } from '../../infrastructure/protocols/SshSession';
import { TelnetSession } from '../../infrastructure/protocols/TelnetSession';
import { LLMClient, LLMProvider } from '../../infrastructure/llm/LLMClient';
import { CiscoAgentLoop } from '../../core/agent/AgentLoop';
import { logger, createSpinner } from '../ui/ui';
import { runInteractiveWizard } from '../ui/interactiveWizard';
import { NetworkPlanner } from '../../core/agent/NetworkPlanner';
export async function runAction(
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

    logger.banner();

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


    let sessionName = options.sessions;
    const sessionsFilePath = join(process.cwd(), 'sessions.json');
    let savedSessions: any = {};
    if (existsSync(sessionsFilePath)) {
        try {
            savedSessions = JSON.parse(readFileSync(sessionsFilePath, 'utf8'));
        } catch(e) {}
    }

    if (sessionName && savedSessions[sessionName]) {
        const s = savedSessions[sessionName];
        provider = provider || s.provider;
        localType = localType || s.localType;
        apiKey = apiKey || s.apiKey;
        model = model || s.model;
        endpoint = endpoint || s.endpoint;
        protocol = protocol || s.protocol;
        com = com || s.com;
        baud = baud || s.baud;
        host = host || s.host;
        port = port || s.port;
        username = username || s.username;
        password = password || s.password;
        logger.info(`Loaded session '${sessionName}' from ${sessionsFilePath}`);
    }

    options.provider = provider;
    options.localType = localType;
    options.apiKey = apiKey;
    options.model = model;
    options.endpoint = endpoint;
    options.protocol = protocol;
    options.com = com;
    options.baud = baud;
    options.host = host;
    options.port = port;
    options.username = username;
    options.password = password;

    if (!com && !host) {
        const answers = await runInteractiveWizard(options, false);
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
        if (answers.goal) goal = answers.goal;
    }

    if (sessionName) {
        savedSessions[sessionName] = {
            provider, localType, apiKey, model, endpoint, protocol, com, baud, host, port, username, password
        };
        try {
            writeFileSync(sessionsFilePath, JSON.stringify(savedSessions, null, 2), 'utf8');
            logger.info(`Session setup saved to '${sessionName}' in ${sessionsFilePath}`);
        } catch (err: any) {
            logger.warn(`Failed to save session: ${err.message}`);
        }
    }

    logger.info(`Initializing system link in [${provider.toUpperCase()}] mode using ${protocol.toUpperCase()}...`);
    logger.info(`Command reference policy: strict=${strictCommandRef ? 'on' : 'off'}, telemetry=${refTelemetry ? 'on' : 'off'}`);
    
    
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
            apiKey,
            localType
        );

        const llmSpinner = createSpinner('Preflight check: validating LLM endpoint reachability...').start();
        try {
            await localAIClient.ensureReachable();
            const setupOk = await localAIClient.setupModelIfNeeded(status => {
                llmSpinner.text = `LLM preflight: ${status}`;
            });
            if (setupOk) {
                llmSpinner.succeed('LLM endpoint is reachable and model is ready.');
            } else {
                llmSpinner.warn('LLM endpoint is reachable (model auto-load skipped/not supported by this provider).');
            }
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

        const agent = new CiscoAgentLoop(localAIClient, coordinatorWrapper.active, {
            strictReferenceMode: strictCommandRef,
            referenceTelemetry: refTelemetry,
            rbacRole: rbacRole
        });
        
        const { wantToContinue } = await inquirer.prompt([
            {
                type: 'confirm',
                name: 'wantToContinue',
                message: chalk.cyan('Setup completed successfully. Do you want to continue chatting / start execution?'),
                default: true
            }
        ]);

        if (wantToContinue) {
            if (!goal) {
                const { chatGoal } = await inquirer.prompt([
                    {
                        type: 'input',
                        name: 'chatGoal',
                        message: 'Enter your goal or instruction:',
                        validate: (input: string) => input.trim().length > 0 ? true : 'Goal cannot be empty.'
                    }
                ]);
                goal = chatGoal;
            }

            const planner = new NetworkPlanner(localAIClient, coordinatorWrapper.active);
            let planApproved = false;
            let currentGoal = goal;
            
            while (!planApproved) {
                const plan = await planner.generatePlan(currentGoal);
                
                const { planAction } = await inquirer.prompt([
                    {
                        type: 'list',
                        name: 'planAction',
                        message: chalk.cyan('Review the Orchestration Plan above. What would you like to do?'),
                        choices: [
                            { name: 'Approve and Execute', value: 'approve' },
                            { name: 'Provide Feedback / Revise Plan', value: 'revise' },
                            { name: 'Cancel Execution', value: 'cancel' }
                        ]
                    }
                ]);

                if (planAction === 'approve') {
                    planApproved = true;
                    currentGoal = `Approved Execution Blueprint:\n${plan}\n\nUser Goal: ${currentGoal}`;
                } else if (planAction === 'revise') {
                    const { feedback } = await inquirer.prompt([
                        {
                            type: 'input',
                            name: 'feedback',
                            message: 'Enter your feedback to revise the plan:'
                        }
                    ]);
                    currentGoal = `${currentGoal}\nFeedback for revision: ${feedback}`;
                } else {
                    logger.info('Execution cancelled by user.');
                    return;
                }
            }

            await agent.run(currentGoal);
        } else {
            logger.info('Exiting normally as requested.');
        }

    } catch (err: any) {
        logger.critical(`Execution Error: ${err.message}`);
    } finally {
        await cleanup();
        logger.info('Session Terminated. Pipelines detached.');
        process.exit(0);
    }
}
