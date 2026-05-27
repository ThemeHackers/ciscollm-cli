import { LLMClient } from '../../infrastructure/llm/LLMClient';
import { MultiAgentCoordinator } from './MultiAgentCoordinator';
import { CommandFirewall } from '../guardrails/CommandFirewall';
import { ErrorAnalyzer } from '../guardrails/ErrorAnalyzer';
import { TransactionManager } from '../rollback/TransactionManager';
import { PromptEngine } from './PromptEngine';
import { CommandReferenceEngine } from './CommandReferenceEngine';
import { ChatMessage, ToolCall } from '../../shared/types';
import { CiscoAgentTools } from '../../infrastructure/llm/ToolDefinitions';
import { exec } from 'child_process';
import { logger, createSpinner } from '../../cli/ui/ui';
import chalk from 'chalk';

type AgentLoopOptions = {
    strictReferenceMode?: boolean;
    referenceTelemetry?: boolean;
};

export class CiscoAgentLoop {
    private messages: ChatMessage[] = [];
    private transactions: Map<string, TransactionManager> = new Map();
    private firewall = new CommandFirewall();
    private lastCommandPerDevice: Record<string, { command: string; count: number }> = {};
    private commandHints = 'Reference status: not loaded.';
    private commandReferenceEngine = CommandReferenceEngine.getInstance();
    private strictReferenceMode = false;
    private referenceTelemetry = true;
    private options: AgentLoopOptions;
    private validationNudgeCount = 0;
    private lastTopologyDiscoveryAt = 0;
    private readonly topologyRefreshIntervalMs = 15000;

    constructor(
        private llmClient: LLMClient,
        private coordinator: MultiAgentCoordinator,
        options: AgentLoopOptions = {}
    ) {
        this.options = options;
        this.applyOptions(this.options);
    }

    private applyOptions(options: AgentLoopOptions): void {
        if (typeof options.referenceTelemetry === 'boolean') {
            this.referenceTelemetry = options.referenceTelemetry;
        }

        if (typeof options.strictReferenceMode === 'boolean') {
            this.commandReferenceEngine.setStrictMode(options.strictReferenceMode);
        }
    }

    public async run(userGoal: string): Promise<void> {
        const backupSpinner = createSpinner('Initializing device configuration backups to flash...').start();
        try {
            
            for (const [id, session] of this.coordinator.getSessions().entries()) {
                const tx = new TransactionManager();
                await tx.initializeBackup(session);
                this.transactions.set(id, tx);
            }
            backupSpinner.succeed('Atomic configuration backups initialized.');
        } catch (e: any) {
            backupSpinner.warn(`Backup initialization skipped or partially completed: ${e.message}`);
        }

        this.strictReferenceMode = this.commandReferenceEngine.isStrictModeEnabled();
        const refSpinner = createSpinner(
            `Loading Cisco command reference from cf_command_ref.pdf${this.strictReferenceMode ? ' (strict mode ON)' : ''}...`
        ).start();
        try {
            this.commandHints = await this.commandReferenceEngine.getPromptHints(userGoal, 14);
            const telemetry = this.commandReferenceEngine.getWarmupTelemetry();
            refSpinner.succeed(
                `Cisco command reference hints loaded${this.strictReferenceMode ? ' with strict-mode validation enabled' : ''}.`
            );
            if (this.referenceTelemetry) {
                logger.info(
                    `[RefTelemetry] source=${telemetry.source} commands=${telemetry.commandCount} loadMs=${telemetry.durationMs} strict=${telemetry.strictMode ? 'on' : 'off'}`
                );
                logger.info(`[RefTelemetry] cache=${telemetry.cachePath}`);
                if (telemetry.error) {
                    logger.warn(`[RefTelemetry] detail=${telemetry.error}`);
                }
            }
        } catch (err: any) {
            this.commandHints = `Reference status: unavailable (${err.message}).`;
            refSpinner.warn('Cisco command reference hints unavailable. Continuing with base policy.');
        }

        const stateInfo = this.buildStateInfoString();
        const topologyInfo = await this.buildTopologyInfoString();

        
        this.messages.push({
            role: 'system',
            content: PromptEngine.getSystemPrompt(stateInfo, this.commandHints, this.strictReferenceMode, topologyInfo)
        });
        
        this.messages.push({ role: 'user', content: userGoal });

        let dynamicLoopActive = true;
        let executionDepth = 0;
        const MAX_STEPS = 15;

        while (dynamicLoopActive && executionDepth < MAX_STEPS) {
            executionDepth++;
            
            
            const updatedStateInfo = this.buildStateInfoString();
            const updatedTopologyInfo = await this.buildTopologyInfoString();
            this.messages[0] = {
                role: 'system',
                content: PromptEngine.getSystemPrompt(updatedStateInfo, this.commandHints, this.strictReferenceMode, updatedTopologyInfo)
            };

        
            let shellEnabled = false;
            for (const session of this.coordinator.getSessions().values()) {
                if (session.isShellEnabled()) {
                    shellEnabled = true;
                    break;
                }
            }

         
            const activeTools = CiscoAgentTools.filter(tool => {
                const shellTools = ['define_shell_variable', 'execute_shell_loop', 'define_shell_function'];
                if (shellTools.includes(tool.function.name)) {
                    return shellEnabled;
                }
                return true;
            });

            const modelSpinner = createSpinner(`[Step ${executionDepth}/${MAX_STEPS}] Agent is thinking...`).start();
            let response: ChatMessage;
            try {
                response = await this.llmClient.generateCompletion(this.messages, activeTools);
                this.messages.push(response);
                modelSpinner.succeed(`[Step ${executionDepth}/${MAX_STEPS}] Thinking complete.`);
                
                const thoughts = response.reasoning_content || response.content;
                if (thoughts && thoughts.trim()) {
                    console.log(chalk.gray('  ' + '─'.repeat(40)));
                    thoughts.trim().split('\n').forEach(line => {
                        console.log(chalk.dim(`  | ${line}`));
                    });
                    console.log(chalk.gray('  ' + '─'.repeat(40)));
                }
            } catch (err: any) {
                modelSpinner.fail(`[Step ${executionDepth}/${MAX_STEPS}] LLM Client failed to respond.`);
                throw err;
            }

            if (response.tool_calls && response.tool_calls.length > 0) {
                for (const call of response.tool_calls) {
                    if (call.function.name === 'execute_ios_command') {
                        await this.handleExecuteCommandCall(call);
                    } else if (call.function.name === 'ping_test') {
                        await this.handlePingTestCall(call);
                    } else if (call.function.name === 'enable_ios_shell') {
                        await this.handleEnableIosShellCall(call);
                    } else if (call.function.name === 'define_shell_variable') {
                        await this.handleDefineShellVariableCall(call);
                    } else if (call.function.name === 'execute_shell_loop') {
                        await this.handleExecuteShellLoopCall(call);
                    } else if (call.function.name === 'define_shell_function') {
                        await this.handleDefineShellFunctionCall(call);
                    }
                }
            } else {
                
                const lastMutatedDevice = this.findLastMutatedDevice();
                const hasRunPing = this.messages.some(m => m.role === 'tool' && m.name === 'ping_test');
                
                if (lastMutatedDevice && !hasRunPing) {
                    this.validationNudgeCount++;
                    logger.info('Agent finished configuration without running validation ping. Enforcing closed-loop validation...');

                    if (this.validationNudgeCount >= 2) {
                        logger.warn('Model skipped ping_test repeatedly. Triggering automatic ping fallback.');
                        await this.triggerAutomaticValidationPing(lastMutatedDevice);
                        logger.heading('FINAL AGENT REASONING SUMMARY');
                        console.log(chalk.yellow('Validation ping was auto-triggered by fallback policy after repeated non-tool responses.'));
                        dynamicLoopActive = false;
                    } else {
                        this.messages.push({
                            role: 'user',
                            content: `System Validation Request: Your configurations are applied. You MUST perform exactly one ping_test tool call in your next response. If destination is unknown, use destination "127.0.0.1" and device "${lastMutatedDevice}". Do not declare success until ping_test has executed.`
                        });
                    }
                } else {
                    logger.heading('FINAL AGENT REASONING SUMMARY');
                    console.log(chalk.green(response.reasoning_content || response.content || '(No final response content provided)'));
                    dynamicLoopActive = false;
                }
            }
        }

        if (executionDepth >= MAX_STEPS && dynamicLoopActive) {
            logger.warn('Maximum loop steps limit reached.');
        }
    }

    private async buildTopologyInfoString(): Promise<string> {
        const now = Date.now();
        if (now - this.lastTopologyDiscoveryAt > this.topologyRefreshIntervalMs) {
            await this.coordinator.discoverTopology();
            this.lastTopologyDiscoveryAt = now;
        }
        const topology = this.coordinator.getTopology();
        if (topology.links.length === 0) {
            return `Discovered at: ${topology.discoveredAt}\nNodes: ${topology.nodes.join(', ') || '(none)'}\nLinks: none`; 
        }

        const links = topology.links
            .map(link => `- ${link.localDeviceId} [${link.localInterface}] <-> ${link.remoteDeviceId} [${link.remoteInterface}] via ${link.protocol.toUpperCase()}`)
            .join('\n');
        return `Discovered at: ${topology.discoveredAt}\nNodes: ${topology.nodes.join(', ')}\n${links}`;
    }

    private async triggerAutomaticValidationPing(deviceId: string): Promise<void> {
        const destination = await this.resolveValidationDestination(deviceId);
        const fallbackCall: ToolCall = {
            id: `auto_ping_${Date.now()}`,
            type: 'function',
            function: {
                name: 'ping_test',
                arguments: JSON.stringify({ destination, device: deviceId })
            }
        };
        await this.handlePingTestCall(fallbackCall);
    }

    private async resolveValidationDestination(deviceId: string): Promise<string> {
        try {
            const session = this.coordinator.getSession(deviceId);
            if (!session) {
                return '127.0.0.1';
            }

            const output = await session.execute('show ip interface brief');
            const lines = output.split(/\r?\n/).map(l => l.trim()).filter(Boolean);

            for (const line of lines) {
                if (/^Interface\s+/i.test(line)) continue;
                const ipMatch = line.match(/\b(\d{1,3}(?:\.\d{1,3}){3})\b/);
                if (!ipMatch) continue;
                const ip = ipMatch[1];
                if (ip.toLowerCase() !== 'unassigned') {
                    return ip;
                }
            }
        } catch {
            // Fall through to safe default.
        }

        return '127.0.0.1';
    }

    private buildStateInfoString(): string {
        const states = this.coordinator.getAllStates();
        let stateInfo = '';
        for (const [id, state] of Object.entries(states)) {
            stateInfo += `- Device ID: "${id}"\n  Hostname: "${state.hostname}"\n  Access Mode: "${state.currentMode}"\n  CLI Prompt: "${state.prompt}"\n`;
        }
        return stateInfo;
    }

    private findLastMutatedDevice(): string | null {
        for (const [deviceId, tx] of this.transactions.entries()) {
            if (tx.hasMutations()) {
                return deviceId;
            }
        }
        return null;
    }

    private resolveTargetDevice(requestedDevice?: string): string {
        const devices = Array.from(this.coordinator.getSessions().keys());
        if (devices.length === 0) {
            throw new Error('No devices are currently registered.');
        }

        if (requestedDevice) {
            if (this.coordinator.getSession(requestedDevice)) {
                return requestedDevice;
            }
            const match = devices.find(d => d.toLowerCase() === requestedDevice.toLowerCase());
            if (match) return match;
            throw new Error(`Device "${requestedDevice}" is not recognized. Available devices: ${devices.join(', ')}`);
        }

        if (devices.length === 1) {
            return devices[0];
        }

        throw new Error(`Multiple devices connected (${devices.join(', ')}). You must specify the "device" parameter.`);
    }

    private async handleExecuteCommandCall(call: ToolCall): Promise<void> {
        let args;
        try {
            args = JSON.parse(call.function.arguments);
        } catch (e) {
            this.injectToolResponse(call.id, 'execute_ios_command', `Format Error: Invalid Tool Call arguments. Must be JSON.`);
            return;
        }

        const targetCommand = args.command;
        const requestedDevice = args.device;
        const cleanCommand = targetCommand.trim();

        const commandValidation = await this.commandReferenceEngine.validateCommand(cleanCommand);
        if (this.strictReferenceMode && !commandValidation.allowed) {
            const suggestions = commandValidation.suggestions.length
                ? `\nReference suggestions:\n- ${commandValidation.suggestions.join('\n- ')}`
                : '';
            this.injectToolResponse(
                call.id,
                'execute_ios_command',
                `CRITICAL ERROR: Strict command-reference policy blocked execution. ${commandValidation.reason}${suggestions}`
            );
            return;
        }

        let targetDeviceId: string;
        try {
            targetDeviceId = this.resolveTargetDevice(requestedDevice);
        } catch (err: any) {
            this.injectToolResponse(call.id, 'execute_ios_command', `Error: ${err.message}`);
            return;
        }

       
        const lastCmdInfo = this.lastCommandPerDevice[targetDeviceId];
        if (lastCmdInfo && lastCmdInfo.command === cleanCommand) {
            lastCmdInfo.count++;
        } else {
            this.lastCommandPerDevice[targetDeviceId] = { command: cleanCommand, count: 1 };
        }

        if (this.lastCommandPerDevice[targetDeviceId].count > 3) {
            logger.error(`Loop detected on command "${cleanCommand}" on device ${targetDeviceId}.`);
            this.injectToolResponse(call.id, 'execute_ios_command', `CRITICAL ERROR: Loop check block. You have run "${cleanCommand}" multiple times with errors. Re-verify your settings before retrying.`);
            return;
        }

        
        const tx = this.transactions.get(targetDeviceId);
        const currentInterface = tx ? (tx as any).targetInterface : null;
        const firewallResult = this.firewall.checkCommand(cleanCommand, currentInterface);

        if (firewallResult.dangerous) {
            const allowed = await this.firewall.verifyWithHuman(cleanCommand, firewallResult.reason || 'High-risk token');
            if (!allowed) {
                this.injectToolResponse(call.id, 'execute_ios_command', 'CRITICAL ERROR: Execution denied by administrator.');
                return;
            }
        }

        
        if (tx) {
            tx.trackMutation(cleanCommand);
        }

        
        const cmdSpinner = createSpinner(`[${targetDeviceId}] Executing command: "${cleanCommand}"...`).start();
        try {
            const session = this.coordinator.getSession(targetDeviceId)!;

            // Normalize context for read-only inspection commands to avoid mode-related failures.
            const state = session.getState();
            if (/^show\s+/i.test(cleanCommand) && (state.currentMode === 'GLOBAL_CONFIG' || state.currentMode === 'INTERFACE_CONFIG')) {
                await session.execute('end');
            }

            const rawOutput = await session.execute(cleanCommand);
            const processedOutput = this.truncateOutput(rawOutput);

            const verification = ErrorAnalyzer.checkOutput(processedOutput);
            if (verification.hasError) {
                cmdSpinner.fail(`[${targetDeviceId}] Command failed: "${cleanCommand}" (${verification.errorType})`);
                
                const rbSpinner = createSpinner(`[${targetDeviceId}] Reverting configuration changes...`).start();
                let rollbackLogs = '';
                if (tx) {
                    rollbackLogs = await tx.executeRollback(session);
                }
                rbSpinner.succeed(`[${targetDeviceId}] Rollback execution complete.`);
                
                this.injectToolResponse(
                    call.id,
                    'execute_ios_command',
                    `IOS Error [${verification.errorType}]:\n${processedOutput}\n\nAutomated configuration rollback executed:\n${rollbackLogs}`
                );
            } else {
                cmdSpinner.succeed(`[${targetDeviceId}] Command completed: "${cleanCommand}"`);
                this.injectToolResponse(call.id, 'execute_ios_command', processedOutput);
            }
        } catch (error: any) {
            cmdSpinner.fail(`[${targetDeviceId}] Command failed: "${cleanCommand}" (${error.message})`);
            this.injectToolResponse(call.id, 'execute_ios_command', `Hardware Session Fault: ${error.message}`);
        }
    }

    private async handleEnableIosShellCall(call: ToolCall): Promise<void> {
        let args;
        try {
            args = JSON.parse(call.function.arguments);
        } catch (e) {
            this.injectToolResponse(call.id, 'enable_ios_shell', `Format Error: Invalid Tool Call arguments. Must be JSON.`);
            return;
        }

        const mode = args.mode;
        const requestedDevice = args.device;

        let targetDeviceId: string;
        try {
            targetDeviceId = this.resolveTargetDevice(requestedDevice);
        } catch (err: any) {
            this.injectToolResponse(call.id, 'enable_ios_shell', `Error: ${err.message}`);
            return;
        }

        const cmdSpinner = createSpinner(`[${targetDeviceId}] Enabling Cisco IOS Shell (${mode})...`).start();
        try {
            const session = this.coordinator.getSession(targetDeviceId)!;
            let output = '';
            if (mode === 'global') {
                await session.execute('configure terminal');
                output += await session.execute('shell processing full');
                await session.execute('end');
            } else {
                output += await session.execute('terminal shell');
            }
            cmdSpinner.succeed(`[${targetDeviceId}] Cisco IOS Shell enabled (${mode}).`);
            this.injectToolResponse(call.id, 'enable_ios_shell', output || 'Shell enabled successfully.');
        } catch (error: any) {
            cmdSpinner.fail(`[${targetDeviceId}] Failed to enable Cisco IOS Shell: ${error.message}`);
            this.injectToolResponse(call.id, 'enable_ios_shell', `Error: ${error.message}`);
        }
    }

    private async handleDefineShellVariableCall(call: ToolCall): Promise<void> {
        let args;
        try {
            args = JSON.parse(call.function.arguments);
        } catch (e) {
            this.injectToolResponse(call.id, 'define_shell_variable', `Format Error: Invalid Tool Call arguments. Must be JSON.`);
            return;
        }

        const { name, value, device } = args;

        let targetDeviceId: string;
        try {
            targetDeviceId = this.resolveTargetDevice(device);
        } catch (err: any) {
            this.injectToolResponse(call.id, 'define_shell_variable', `Error: ${err.message}`);
            return;
        }

        const cmdSpinner = createSpinner(`[${targetDeviceId}] Defining shell variable: ${name}=${value}...`).start();
        try {
            const session = this.coordinator.getSession(targetDeviceId)!;
            const output = await session.execute(`${name}=${value}`);
            cmdSpinner.succeed(`[${targetDeviceId}] Defined shell variable: ${name}=${value}`);
            this.injectToolResponse(call.id, 'define_shell_variable', output || `Variable ${name} defined.`);
        } catch (error: any) {
            cmdSpinner.fail(`[${targetDeviceId}] Failed to define shell variable: ${error.message}`);
            this.injectToolResponse(call.id, 'define_shell_variable', `Error: ${error.message}`);
        }
    }

    private async handleExecuteShellLoopCall(call: ToolCall): Promise<void> {
        let args;
        try {
            args = JSON.parse(call.function.arguments);
        } catch (e) {
            this.injectToolResponse(call.id, 'execute_shell_loop', `Format Error: Invalid Tool Call arguments. Must be JSON.`);
            return;
        }

        const { variable, items, command, device } = args;
        const itemsStr = Array.isArray(items) ? items.join(' ') : items;
        const loopCommand = `for ${variable} in ${itemsStr}; do ${command}; done`;

        let targetDeviceId: string;
        try {
            targetDeviceId = this.resolveTargetDevice(device);
        } catch (err: any) {
            this.injectToolResponse(call.id, 'execute_shell_loop', `Error: ${err.message}`);
            return;
        }

        const cmdSpinner = createSpinner(`[${targetDeviceId}] Executing shell loop: "${loopCommand}"...`).start();
        try {
            const session = this.coordinator.getSession(targetDeviceId)!;
            const output = await session.execute(loopCommand);
            cmdSpinner.succeed(`[${targetDeviceId}] Shell loop completed: "${loopCommand}"`);
            this.injectToolResponse(call.id, 'execute_shell_loop', output);
        } catch (error: any) {
            cmdSpinner.fail(`[${targetDeviceId}] Shell loop failed: ${error.message}`);
            this.injectToolResponse(call.id, 'execute_shell_loop', `Error: ${error.message}`);
        }
    }

    private async handleDefineShellFunctionCall(call: ToolCall): Promise<void> {
        let args;
        try {
            args = JSON.parse(call.function.arguments);
        } catch (e) {
            this.injectToolResponse(call.id, 'define_shell_function', `Format Error: Invalid Tool Call arguments. Must be JSON.`);
            return;
        }

        const { name, body, device } = args;
        const funcCommand = `${name}() { ${body}; }`;

        let targetDeviceId: string;
        try {
            targetDeviceId = this.resolveTargetDevice(device);
        } catch (err: any) {
            this.injectToolResponse(call.id, 'define_shell_function', `Error: ${err.message}`);
            return;
        }

        const cmdSpinner = createSpinner(`[${targetDeviceId}] Defining shell function: ${name}()...`).start();
        try {
            const session = this.coordinator.getSession(targetDeviceId)!;
            const output = await session.execute(funcCommand);
            cmdSpinner.succeed(`[${targetDeviceId}] Defined shell function: ${name}()`);
            this.injectToolResponse(call.id, 'define_shell_function', output || `Function ${name} defined.`);
        } catch (error: any) {
            cmdSpinner.fail(`[${targetDeviceId}] Failed to define shell function: ${error.message}`);
            this.injectToolResponse(call.id, 'define_shell_function', `Error: ${error.message}`);
        }
    }

    private async handlePingTestCall(call: ToolCall): Promise<void> {
        let args;
        try {
            args = JSON.parse(call.function.arguments);
        } catch (e) {
            this.injectToolResponse(call.id, 'ping_test', `Format Error: Invalid Tool Call arguments. Must be JSON.`);
            return;
        }

        const destination = args.destination;
        const requestedDevice = args.device;

        if (requestedDevice) {
            
            let targetDeviceId: string;
            try {
                targetDeviceId = this.resolveTargetDevice(requestedDevice);
            } catch (err: any) {
                this.injectToolResponse(call.id, 'ping_test', `Error: ${err.message}`);
                return;
            }

            const pingSpinner = createSpinner(`[${targetDeviceId}] Executing remote ping to ${destination}...`).start();
            try {
                const session = this.coordinator.getSession(targetDeviceId)!;
                const pingOutput = await session.execute(`ping ${destination}`);
                
                const successMatch = /success rate is (\d+) percent/i.exec(pingOutput);
                const isFail = successMatch ? parseInt(successMatch[1], 10) === 0 : pingOutput.includes('.....');
                
                if (isFail) {
                    pingSpinner.fail(`[${targetDeviceId}] Remote ping to ${destination} failed.`);
                    const failReason = `Remote ping failed from device "${targetDeviceId}" to ${destination}. Success rate is 0%. Analyze routing table, interfaces, and trunk links to troubleshoot.`;
                    this.injectToolResponse(call.id, 'ping_test', `PING TEST FAILED:\n${pingOutput}\n\n[Diagnostic Alert]: ${failReason}`);
                } else {
                    pingSpinner.succeed(`[${targetDeviceId}] Remote ping to ${destination} succeeded.`);
                    this.injectToolResponse(call.id, 'ping_test', pingOutput);
                }
            } catch (err: any) {
                pingSpinner.fail(`[${targetDeviceId}] Remote ping request errored.`);
                this.injectToolResponse(call.id, 'ping_test', `Cisco Remote Ping Error: ${err.message}`);
            }
        } else {
            
            const pingSpinner = createSpinner(`Executing local host ping to ${destination}...`).start();
            const hostPingOutput = await this.pingFromHost(destination);
            
            const isLost = hostPingOutput.includes('100% packet loss') || 
                           hostPingOutput.includes('Request timed out') || 
                           hostPingOutput.includes('Destination host unreachable') ||
                           hostPingOutput.includes('PING FAILED');

            if (isLost) {
                pingSpinner.fail(`Local host ping to ${destination} failed.`);
                const failReason = `Local host ping failed to destination ${destination}. Connection is unreachable. Verify router interfaces and routing configurations.`;
                this.injectToolResponse(call.id, 'ping_test', `PING TEST FAILED:\n${hostPingOutput}\n\n[Diagnostic Alert]: ${failReason}`);
            } else {
                pingSpinner.succeed(`Local host ping to ${destination} succeeded.`);
                this.injectToolResponse(call.id, 'ping_test', hostPingOutput);
            }
        }
    }

    private async pingFromHost(destination: string): Promise<string> {
        return new Promise((resolve) => {
            const isWindows = process.platform === 'win32';
            const cmd = isWindows ? `ping -n 4 ${destination}` : `ping -c 4 ${destination}`;
            
            exec(cmd, (error, stdout, stderr) => {
                if (error) {
                    resolve(`PING FAILED:\n${stdout || stderr || error.message}`);
                    return;
                }
                resolve(stdout);
            });
        });
    }

    private injectToolResponse(callId: string, name: string, content: string): void {
        this.messages.push({
            role: 'tool',
            tool_call_id: callId,
            name: name,
            content: content
        });
    }

    private truncateOutput(output: string): string {
        const MAX_LINES = 50;
        const lines = output.split(/\r?\n/);
        
        if (lines.length <= MAX_LINES) {
            return output;
        }

        const keepLines = 20;
        const firstPart = lines.slice(0, keepLines);
        const lastPart = lines.slice(lines.length - keepLines);
        const removedLinesCount = lines.length - (keepLines * 2);

        return [
            ...firstPart,
            `[... TRUNCATED ${removedLinesCount} LINES OF TERMINAL OUTPUT TO PREVENT CONTEXT WINDOW OVERFLOW ...]`,
            ...lastPart
        ].join('\n');
    }
}
