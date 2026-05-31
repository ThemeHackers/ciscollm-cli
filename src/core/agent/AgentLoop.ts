import { LLMClient } from '../../infrastructure/llm/LLMClient';
import { MultiAgentCoordinator } from './MultiAgentCoordinator';
import { CommandFirewall } from '../guardrails/CommandFirewall';
import { ErrorAnalyzer } from '../guardrails/ErrorAnalyzer';
import { TransactionManager } from '../rollback/TransactionManager';
import { PromptEngine } from './PromptEngine';
import { CommandReferenceEngine } from './CommandReferenceEngine';
import { ChatMessage, ToolCall } from '../../shared/types';
import { CiscoAgentTools } from '../../infrastructure/llm/ToolDefinitions';
import { execFile, exec } from 'child_process';
import { logger, createSpinner, getTerminalWidth, StreamWordWrapper } from '../../cli/ui/ui';
import chalk from 'chalk';
import { PreExecutionValidator } from '../guardrails/PreExecutionValidator';
import { AuditLogger } from '../guardrails/AuditLogger';
import { HierarchicalAgentManager } from './HierarchicalAgentManager';
import { StateDiff } from '../rollback/StateDiff';

type AgentLoopOptions = {
    strictReferenceMode?: boolean;
    referenceTelemetry?: boolean;
    rbacRole?: string;
};

type CommandCategory = 'inspection' | 'configuration' | 'other';

type DeviceCommandHistory = {
    command: string;
    count: number;
    category: CommandCategory;
};

export class CiscoAgentLoop {
    private messages: ChatMessage[] = [];
    private transactions: Map<string, TransactionManager> = new Map();
    private firewall = new CommandFirewall();
    private lastCommandPerDevice: Record<string, DeviceCommandHistory> = {};
    private commandHints = 'Reference status: not loaded.';
    private commandReferenceEngine = CommandReferenceEngine.getInstance();
    private strictReferenceMode = false;
    private referenceTelemetry = true;
    private rbacRole = 'admin';
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

        if (options.rbacRole) {
            this.rbacRole = options.rbacRole.toLowerCase();
        }
    }

    public async run(userGoal: string): Promise<void> {
        const totalStartTime = Date.now();
        let totalPromptTokens = 0;
        let totalCompletionTokens = 0;
        let totalTokens = 0;
        let totalLlmDurationMs = 0;

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
            this.commandHints = await this.commandReferenceEngine.getPromptHints(userGoal, 6);
            const telemetry = this.commandReferenceEngine.getWarmupTelemetry();
            refSpinner.succeed(
                `Cisco command reference hints loaded${this.strictReferenceMode ? ' with strict-mode validation enabled' : ''}.`
            );
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
        const MAX_STEPS = 20;

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

            logger.modelStatus(this.llmClient.getModelName());
            const modelSpinner = createSpinner(`[Step ${executionDepth}/${MAX_STEPS}] Agent is thinking...`).start();
            
            let gpuTimer: NodeJS.Timeout | null = null;
            let isThinking = true;
            
            const updateGpu = async () => {
                if (!isThinking) return;
                const gpuInfo = await this.getGpuInfoAsync();
                if (gpuInfo && isThinking) {
                    modelSpinner.text = `[Step ${executionDepth}/${MAX_STEPS}] Agent is thinking... [GPU: ${gpuInfo}]`;
                }
            };
            
            updateGpu();
            gpuTimer = setInterval(updateGpu, 1500);

            let response: ChatMessage;
            let hasStartedStreaming = false;
            const border = chalk.blue('│');
            let wrapper: any = undefined;

            let pendingAsterisk = false;
            const onChunk = (chunk: { content?: string; reasoning?: string }) => {
                if (!hasStartedStreaming) {
                    hasStartedStreaming = true;
                    isThinking = false;
                    if (gpuTimer) clearInterval(gpuTimer);
                    modelSpinner.stop();
                    logger.diamond(`Step ${executionDepth}/${MAX_STEPS} — Agent thought process:`);
                    const totalWidth = getTerminalWidth();
                    const title = '┌─── Agent Reasoning (Streaming) ';
                    const topBorder = chalk.blue(title + '─'.repeat(Math.max(0, totalWidth - title.length)));
                    console.log(topBorder);
                    process.stdout.write(`${border}  `);
                    wrapper = new StreamWordWrapper(totalWidth - 4);
                }

                let text = (chunk.reasoning || chunk.content || '').replace(/\r/g, '');
                if (pendingAsterisk) {
                    text = '*' + text;
                    pendingAsterisk = false;
                }
                if (text.endsWith('*')) {
                    let count = 0;
                    for (let idx = text.length - 1; idx >= 0; idx--) {
                        if (text[idx] === '*') {
                            count++;
                        } else {
                            break;
                        }
                    }
                    if (count % 2 !== 0) {
                        text = text.substring(0, text.length - 1);
                        pendingAsterisk = true;
                    }
                }
                text = text.replace(/\*\*/g, '');

                if (text && wrapper) {
                    wrapper.write(text);
                }
            };

            try {
                response = await this.llmClient.generateCompletion(this.getMessagesForLlm(), activeTools, onChunk);
                
   isThinking = false;
                if (gpuTimer) clearInterval(gpuTimer);
                
                if (hasStartedStreaming) {
                    if (wrapper) {
                        wrapper.flush();
                    }
                    const totalWidth = getTerminalWidth();
                    const bottomBorder = chalk.blue('└' + '─'.repeat(Math.max(0, totalWidth - 1)));
                    console.log('\n' + bottomBorder + '\n');
                } else {
                    const finalGpu = await this.getGpuInfoAsync();
                    const gpuSuffix = finalGpu ? ` [GPU: ${finalGpu}]` : '';
                    modelSpinner.succeed(`[Step ${executionDepth}/${MAX_STEPS}] Thinking complete.${gpuSuffix}`);
                }

                if (response.usage) {
                    totalPromptTokens += response.usage.prompt_tokens;
                    totalCompletionTokens += response.usage.completion_tokens;
                    totalTokens += response.usage.total_tokens;
                    totalLlmDurationMs += response.usage.duration_ms;

                    const tokSecStr = chalk.cyan(`${response.usage.tok_sec.toFixed(1)} tok/sec`);
                    const promptStr = chalk.gray(`Prompt:`) + ` ${response.usage.prompt_tokens} t`;
                    const compStr = chalk.gray(`Completion:`) + ` ${response.usage.completion_tokens} t`;
                    const totalStr = chalk.gray(`Total:`) + ` ${response.usage.total_tokens} t`;
                    const timeStr = chalk.gray(`Time:`) + ` ${(response.usage.duration_ms / 1000).toFixed(2)}s`;
                    
                    logger.info(`${chalk.bold.yellow('⚡')} LLM Stats: ${tokSecStr} | ${promptStr} | ${compStr} | ${totalStr} | ${timeStr}`);
                }
                
                this.messages.push(response);
            } catch (err: any) {
                isThinking = false;
                if (gpuTimer) clearInterval(gpuTimer);
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

                  
                    const validationDest = await this.resolveValidationDestination(lastMutatedDevice);

                    if (this.validationNudgeCount >= 2) {
                        logger.warn('Model skipped ping_test repeatedly. Triggering automatic ping fallback.');
                        if (validationDest === '127.0.0.1') {
                            logger.warn('No reachable destination found — skipping auto-ping fallback.');
                        } else {
                            await this.triggerAutomaticValidationPing(lastMutatedDevice);
                        }
                        logger.heading('FINAL AGENT REASONING SUMMARY');
                        console.log(chalk.yellow('Validation ping was auto-triggered by fallback policy after repeated non-tool responses.'));
                        dynamicLoopActive = false;
                    } else {
                        this.messages.push({
                            role: 'user',
                            content: `System Validation Request: Your configurations are applied. You MUST perform exactly one ping_test tool call in your next response. Use device "${lastMutatedDevice}" and destination "${validationDest}" (resolved from the current routing table). Do not declare success until ping_test has executed.`
                        });
                    }
                } else {
                    logger.heading('FINAL AGENT REASONING SUMMARY');
                    const rawSummary = response.reasoning_content || response.content || '(No final response content provided)';
                    console.log(chalk.green(rawSummary.replace(/\*\*/g, '')));
                    dynamicLoopActive = false;
                }
            }
        }

        if (executionDepth >= MAX_STEPS && dynamicLoopActive) {
            logger.warn('Maximum loop steps limit reached.');
        }

        const totalDurationMs = Date.now() - totalStartTime;
        const avgLlmSpeed = totalLlmDurationMs > 0 ? (totalCompletionTokens / (totalLlmDurationMs / 1000)) : 0;

        const line = '━'.repeat(50);
        console.log('\n' + chalk.magenta.bold(`  ┏${line}┓`));
        console.log(chalk.magenta.bold(`  ┃  ${chalk.white.bold('GRAND AGENT RUN EXECUTION SUMMARY')}               ┃`));
        console.log(chalk.magenta.bold(`  ┗${line}┛`));
        console.log(`  ${chalk.yellow('•')} ${chalk.gray('Total Run Duration:')}       ${chalk.bold.white((totalDurationMs / 1000).toFixed(2))}s`);
        console.log(`  ${chalk.yellow('•')} ${chalk.gray('Total LLM Think Time:')}     ${chalk.bold.white((totalLlmDurationMs / 1000).toFixed(2))}s`);
        console.log(`  ${chalk.yellow('•')} ${chalk.gray('Total Prompt Tokens:')}      ${chalk.bold.white(totalPromptTokens)} tokens`);
        console.log(`  ${chalk.yellow('•')} ${chalk.gray('Total Completion Tokens:')}  ${chalk.bold.white(totalCompletionTokens)} tokens`);
        console.log(`  ${chalk.yellow('•')} ${chalk.gray('Total Tokens Consumed:')}    ${chalk.bold.white(totalTokens)} tokens`);
        console.log(`  ${chalk.yellow('•')} ${chalk.gray('Average LLM Generation:')}   ${chalk.bold.cyan(avgLlmSpeed.toFixed(1))} tok/sec\n`);
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

            
            const routeOutput = await session.execute('show ip route');
            for (const line of routeOutput.split(/\r?\n/).map(l => l.trim()).filter(Boolean)) {
                
                const staticMatch = line.match(/^S\s+(\d{1,3}(?:\.\d{1,3}){3})\/?(\d+)?/);
                if (staticMatch) {
                    const base = staticMatch[1];

                    const host = base.replace(/(\d+)$/, '1');
                    return host;
                }
            }

          
            const briefOutput = await session.execute('show ip interface brief');
            for (const line of briefOutput.split(/\r?\n/).map(l => l.trim()).filter(Boolean)) {
                if (/^Interface\s+/i.test(line)) continue;
                const ipMatch = line.match(/\b(\d{1,3}(?:\.\d{1,3}){3})\b/);
                if (!ipMatch) continue;
                const ip = ipMatch[1];
                if (ip.toLowerCase() !== 'unassigned') {
                    return ip;
                }
            }
        } catch {
           
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

    private classifyCommand(command: string): CommandCategory {
        const normalized = command.trim().toLowerCase();

        const inspectionPatterns = [
            /^show\s+/i,
            /^ping\s+/i,
            /^traceroute\s+/i,
            /^dir\s+/i,
            /^display\s+/i,
            /^more\s+/i,
            /^terminal\s+length\s+\d+/i,
            /^show\s+(running-config|startup-config|version|clock|logging|inventory|environment|users?|process(?:es)?|interfaces?(?:\s+status)?|ip\s+interface\s+brief|ip\s+route|arp|mac\s+address-table|vlan(?:\s+brief)?|cdp\s+neighbors(?:\s+detail)?|lldp\s+neighbors(?:\s+detail)?|spanning-tree|access-lists?|ip\s+ospf\s+neighbor|ip\s+bgp\s+summary|platform|module|power|etherchannel\s+summary|controllers?)/i,
            /^copy\s+(running-config\s+flash:|startup-config\s+running-config)/i
        ];

        if (inspectionPatterns.some(pattern => pattern.test(normalized))) {
            return 'inspection';
        }

        const configurationPatterns = [
            /^(configure terminal|conf t|end|exit)$/i,
            /^(interface\s+\S+|router\s+(ospf|bgp|rip|eigrp)\b|vlan\s+\d+|ip\s+address\b|no\s+shutdown\b|shutdown\b|description\b|switchport\b|spanning-tree\b|ip\s+route\b|access-list\b|ip\s+access-list\b|username\b|aaa\b|crypto\b|ntp\b|snmp-server\b|hostname\b|default\s+interface\b|vrf\s+definition\b|route-map\b|policy-map\b|class-map\b|channel-group\b|standby\b|tunnel\s+\S+|ip\s+helper-address\b|ip\s+domain-name\b|line\s+\S+\s+\d*\b|service\s+\S+|shell\s+processing\s+full|terminal\s+shell)/i
        ];

        if (configurationPatterns.some(pattern => pattern.test(normalized))) {
            return 'configuration';
        }

        return 'other';
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

     
        const assignedRole = HierarchicalAgentManager.routeCommand(cleanCommand);

   
        if (this.rbacRole === 'read_only') {
            const lower = cleanCommand.toLowerCase();
            const allowedReadOnlyPatterns = [/^show\s+/i, /^ping\s+/i, /^dir\s+/i, /^terminal\s+/i, /^exit$/i, /^end$/i];
            const isAllowedReadOnly = allowedReadOnlyPatterns.some(p => p.test(lower));
            if (!isAllowedReadOnly) {
                logger.warn(`[RBAC BLOCK] Read-Only role blocked command: "${cleanCommand}"`);
                this.injectToolResponse(call.id, 'execute_ios_command', `CRITICAL ERROR: RBAC policy violation. Your current role is READ_ONLY and you are blocked from executing modifying command "${cleanCommand}".`);
                AuditLogger.log({
                    timestamp: new Date().toISOString(),
                    deviceId: requestedDevice || 'unknown',
                    role: this.rbacRole,
                    thought: this.messages[this.messages.length - 1]?.content || '',
                    command: cleanCommand,
                    status: 'BLOCKED',
                    reason: 'RBAC role is READ_ONLY'
                });
                return;
            }
        }

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

     
        const tx = this.transactions.get(targetDeviceId);
        const currentInterface = tx ? (tx as any).targetInterface : null;
        const dryRunCheck = PreExecutionValidator.validateCommand(
            cleanCommand,
            targetDeviceId,
            this.coordinator.getTopology(),
            currentInterface
        );

        if (dryRunCheck.warnLevel === 'CRITICAL' || !dryRunCheck.safe) {
            logger.warn(`[PRE-EXECUTION WARNING] Critical risk detected: ${dryRunCheck.reason}`);
            const allowed = await this.firewall.verifyWithHuman(cleanCommand, dryRunCheck.reason || 'High risk context');
            if (!allowed) {
                this.injectToolResponse(call.id, 'execute_ios_command', `CRITICAL ERROR: Pre-execution validation blocked this command. Reason: ${dryRunCheck.reason}`);
                AuditLogger.log({
                    timestamp: new Date().toISOString(),
                    deviceId: targetDeviceId,
                    role: this.rbacRole,
                    thought: this.messages[this.messages.length - 1]?.content || '',
                    command: cleanCommand,
                    status: 'BLOCKED',
                    reason: dryRunCheck.reason
                });
                return;
            }
        }

        const commandCategory = this.classifyCommand(cleanCommand);
        const lastCmdInfo = this.lastCommandPerDevice[targetDeviceId];

        if (commandCategory === 'inspection') {
            this.lastCommandPerDevice[targetDeviceId] = {
                command: cleanCommand,
                count: 0,
                category: commandCategory
            };
        } else if (lastCmdInfo && lastCmdInfo.command === cleanCommand && lastCmdInfo.category === commandCategory) {
            lastCmdInfo.count++;
        } else {
            this.lastCommandPerDevice[targetDeviceId] = {
                command: cleanCommand,
                count: 1,
                category: commandCategory
            };
        }

        if (commandCategory !== 'inspection' && this.lastCommandPerDevice[targetDeviceId].count > 3) {
            logger.error(`Loop detected on command "${cleanCommand}" on device ${targetDeviceId}.`);
            this.injectToolResponse(call.id, 'execute_ios_command', `CRITICAL ERROR: Loop check block. You have run "${cleanCommand}" multiple times with errors. Re-verify your settings before retrying.`);
            return;
        }

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

       
        const snapshotA = await this.captureDeviceSnapshot(targetDeviceId);

        const cmdSpinner = createSpinner(`[${targetDeviceId}] [Agent: ${assignedRole}] Executing command: "${cleanCommand}"...`).start();
        try {
            const session = this.coordinator.getSession(targetDeviceId)!;
            const state = session.getState();
            if (/^show\s+/i.test(cleanCommand) && (state.currentMode === 'GLOBAL_CONFIG' || state.currentMode === 'INTERFACE_CONFIG')) {
                await session.execute('end');
            }

            const rawOutput = await session.execute(cleanCommand);
            const processedOutput = this.truncateOutput(rawOutput);

            const verification = ErrorAnalyzer.checkOutput(processedOutput);
            if (verification.hasError) {
                cmdSpinner.stop();
                logger.toolBox(`execute_ios_command running "${cleanCommand}" on ${targetDeviceId}`, `IOS Error [${verification.errorType}]:\n${processedOutput}`, false);
                
                const rbSpinner = createSpinner(`[${targetDeviceId}] Reverting configuration changes...`).start();
                let rollbackLogs = '';
                if (tx) {
                    rollbackLogs = await tx.executeRollback(session, cleanCommand);
                }
                rbSpinner.stop();
                logger.toolBox(`automated_rollback on ${targetDeviceId}`, rollbackLogs || 'Rollback completed.', false);

              
                AuditLogger.log({
                    timestamp: new Date().toISOString(),
                    deviceId: targetDeviceId,
                    role: this.rbacRole,
                    thought: this.messages[this.messages.length - 2]?.content || '',
                    command: cleanCommand,
                    status: 'ROLLBACK',
                    reason: `Rollback triggered by error ${verification.errorType}. Reverted state successfully.`
                });
                
                this.injectToolResponse(
                    call.id,
                    'execute_ios_command',
                    `IOS Error [${verification.errorType}]:\n${processedOutput}\n\nAutomated configuration rollback executed:\n${rollbackLogs}`
                );
            } else {
                cmdSpinner.stop();
                logger.toolBox(`execute_ios_command running "${cleanCommand}" on ${targetDeviceId}`, processedOutput, true);

                const snapshotB = await this.captureDeviceSnapshot(targetDeviceId);
                let diffSummary = '';
                if (snapshotA && snapshotB) {
                    const diffResult = StateDiff.diff(snapshotA, snapshotB);
                    diffSummary = StateDiff.renderDiff(diffResult);
                    if (diffSummary && diffSummary !== 'No configuration differences detected.') {
                        logger.info(`[State Diff for ${targetDeviceId}]:\n${diffSummary}`);
                    }
                }

                AuditLogger.log({
                    timestamp: new Date().toISOString(),
                    deviceId: targetDeviceId,
                    role: this.rbacRole,
                    thought: this.messages[this.messages.length - 2]?.content || '',
                    command: cleanCommand,
                    status: 'SUCCESS',
                    outputSnippet: `${processedOutput}${diffSummary ? `\nState Changes:\n${diffSummary}` : ''}`
                });

                this.injectToolResponse(
                    call.id,
                    'execute_ios_command',
                    processedOutput + (diffSummary ? `\n\n[State Diff Configured]:\n${diffSummary}` : '')
                );
            }
        } catch (error: any) {
            cmdSpinner.fail(`[${targetDeviceId}] Command failed: "${cleanCommand}" (${error.message})`);
            this.injectToolResponse(call.id, 'execute_ios_command', `Hardware Session Fault: ${error.message}`);
        }
    }

    private async captureDeviceSnapshot(deviceId: string): Promise<any> {
        const session = this.coordinator.getSession(deviceId);
        if (!session) return null;

        if (typeof (session as any).interfaces !== 'undefined') {
            const mock = session as any;
            const interfaceList: any[] = [];
            for (const [name, conf] of mock.interfaces.entries()) {
                interfaceList.push({
                    name,
                    ip: conf.ip,
                    subnet: conf.subnet,
                    adminShutdown: conf.adminShutdown,
                    lineProtocolUp: conf.lineProtocolUp,
                    description: conf.description
                });
            }
            return {
                deviceId,
                timestamp: new Date().toISOString(),
                sessionState: session.getState(),
                interfaces: interfaceList,
                routes: [...mock.routes],
                vlans: Array.from(mock.vlans as Set<number>)
            };
        }

        return {
            deviceId,
            timestamp: new Date().toISOString(),
            sessionState: session.getState(),
            interfaces: [],
            routes: [],
            vlans: []
        };
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
                    pingSpinner.stop();
                    const failReason = `Remote ping failed from device "${targetDeviceId}" to ${destination}. Success rate is 0%. Analyze routing table, interfaces, and trunk links to troubleshoot.`;
                    logger.toolBox(`ping_test from ${targetDeviceId} to ${destination}`, `PING TEST FAILED:\n${pingOutput}\n\n[Diagnostic Alert]: ${failReason}`, false);
                    this.injectToolResponse(call.id, 'ping_test', `PING TEST FAILED:\n${pingOutput}\n\n[Diagnostic Alert]: ${failReason}`);
                } else {
                    pingSpinner.stop();
                    logger.toolBox(`ping_test from ${targetDeviceId} to ${destination}`, pingOutput, true);
                    this.injectToolResponse(call.id, 'ping_test', pingOutput);
                }
            } catch (err: any) {
                pingSpinner.stop();
                logger.toolBox(`ping_test from ${targetDeviceId} to ${destination}`, `Cisco Remote Ping Error: ${err.message}`, false);
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
                pingSpinner.stop();
                const failReason = `Local host ping failed to destination ${destination}. Connection is unreachable. Verify router interfaces and routing configurations.`;
                logger.toolBox(`ping_test from Local Host to ${destination}`, `PING TEST FAILED:\n${hostPingOutput}\n\n[Diagnostic Alert]: ${failReason}`, false);
                this.injectToolResponse(call.id, 'ping_test', `PING TEST FAILED:\n${hostPingOutput}\n\n[Diagnostic Alert]: ${failReason}`);
            } else {
                pingSpinner.stop();
                logger.toolBox(`ping_test from Local Host to ${destination}`, hostPingOutput, true);
                this.injectToolResponse(call.id, 'ping_test', hostPingOutput);
            }
        }
    }

    private async pingFromHost(destination: string): Promise<string> {
        return new Promise((resolve) => {
            const isWindows = process.platform === 'win32';
            const pingArgs = isWindows ? ['-n', '4', destination] : ['-c', '4', destination];
            
            execFile('ping', pingArgs, (error, stdout, stderr) => {
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

    private getGpuInfoAsync(): Promise<string | null> {
        return new Promise((resolve) => {
            exec(
                'nvidia-smi --query-gpu=utilization.gpu,memory.used,memory.total,temperature.gpu,power.draw --format=csv,noheader,nounits',
                { timeout: 800 },
                (error, stdout) => {
                    if (error) {
                        resolve(null);
                        return;
                    }
                    const parts = stdout.trim().split(',').map(p => p.trim());
                    if (parts.length >= 5) {
                        const [gpuUtil, memUsed, memTotal, temp, power] = parts;
                        resolve(`${gpuUtil}% Util | VRAM: ${memUsed}/${memTotal}MB | ${temp}°C | ${power}W`);
                    } else {
                        resolve(null);
                    }
                }
            );
        });
    }

    private getMessagesForLlm(): ChatMessage[] {
        if (this.messages.length <= 8) {
            return this.messages;
        }

        const result: ChatMessage[] = [
            this.messages[0], // System prompt
            this.messages[1]  // User original goal
        ];

        result.push({
            role: 'system',
            content: `[System Notice: To prevent token overflow, older turn history has been truncated. The last 6 messages are shown below.]`
        });

        result.push(...this.messages.slice(-6));
        return result;
    }
}
