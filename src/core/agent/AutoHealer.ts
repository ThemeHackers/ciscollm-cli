import { LLMClient } from '../../infrastructure/llm/LLMClient';
import { MultiAgentCoordinator } from './MultiAgentCoordinator';
import { TransactionManager } from '../rollback/TransactionManager';
import { logger, createSpinner } from '../../cli/ui/ui';
import { ChatMessage } from '../../shared/types';
import { CommandFirewall } from '../guardrails/CommandFirewall';
import { AuditLogger } from '../guardrails/AuditLogger';
import * as fs from 'fs';
import * as path from 'path';
import chalk from 'chalk';

export interface AutoHealerOptions {
    nonInteractive?: boolean;
    minConfidence?: number;
    logFile?: string;
}

export class AutoHealer {
    private isRunning: boolean = false;
    private healingDevices = new Set<string>();
    private logFilePath: string;
    private minConfidence: number;
    private nonInteractive: boolean;
    private firewall = new CommandFirewall();

    constructor(
        private llmClient: LLMClient,
        private coordinator: MultiAgentCoordinator,
        options: AutoHealerOptions = {}
    ) {
        this.logFilePath = path.resolve(process.cwd(), options.logFile || 'healing-audit.log');
        this.minConfidence = options.minConfidence ?? 0.80;
        this.nonInteractive = options.nonInteractive ?? false;
        if (this.nonInteractive) {
            process.env.CISCOLLM_NON_INTERACTIVE = 'true';
        }
    }

    public start(): void {
        if (this.isRunning) return;
        this.isRunning = true;
        logger.info(`AutoHealer started. Listening for syslog triggers: %LINK-3-UPDOWN, %LINEPROTO-5-UPDOWN, %OSPF-5-ADJCHG...`);
        this.coordinator.on('notification', (msg: string, deviceId: string) => {
            this.handleNotification(msg, deviceId).catch(err => {
                logger.error(`Error handling notification for device ${deviceId}: ${err.message}`);
            });
        });
    }

    public stop(): void {
        this.isRunning = false;
        logger.info(`AutoHealer stopped.`);
    }

    private async handleNotification(msg: string, deviceId: string): Promise<void> {
        const isTrigger = /%(LINK-3-UPDOWN|LINEPROTO-5-UPDOWN|OSPF-5-ADJCHG):/.test(msg);
        if (!isTrigger) return;

        if (this.healingDevices.has(deviceId)) {
            logger.info(`[Telemetry Alert] Alert received for ${deviceId} but device is already undergoing healing.`);
            return;
        }

        this.healingDevices.add(deviceId);
        logger.heading(`Closed-Loop Healing Event Triggered on ${deviceId}`);
        logger.info(`Syslog Received: ${chalk.yellow(msg)}`);
        this.logToAudit(`[TRIGGERED] Device: ${deviceId} | Syslog: ${msg}`);

        const spinner = createSpinner('OODA Loop: Initiating recovery sequence...').start();
        try {
           
            spinner.text = 'OODA Loop (Orient): Gathering diagnostic context...';
            const context = await this.gatherContext(deviceId, msg);
            spinner.info(`Diagnostic context gathered (${context.commandsRun.length} commands).`);

           
            const decideSpinner = createSpinner('OODA Loop (Decide): Querying AI for Root Cause & Remediation...').start();
            const diagnosis = await this.diagnose(deviceId, msg, context.outputs);
            decideSpinner.succeed('Root Cause Analysis completed.');

            logger.diamond(`AI Detected Issue: ${chalk.white.bold(diagnosis.detected_issue)}`);
            logger.diamond(`AI Root Cause: ${chalk.gray.italic(diagnosis.root_cause)}`);
            logger.diamond(`AI Confidence: ${chalk.cyan(diagnosis.confidence)}`);
            logger.diamond(`Remediation: ${chalk.green(diagnosis.remediation_commands.join(', '))}`);
            logger.diamond(`Verification: ${chalk.blue(diagnosis.verification_commands.join(', '))}`);

            if (diagnosis.confidence < this.minConfidence) {
                logger.warn(`AI confidence (${diagnosis.confidence}) is below threshold (${this.minConfidence}). Skipping automatic healing.`);
                this.logToAudit(`[SKIPPED] Device: ${deviceId} | Confidence too low: ${diagnosis.confidence}`);
                this.healingDevices.delete(deviceId);
                return;
            }

         
            if (!this.nonInteractive) {
                logger.warn('Interactive Mode: Human verification required to apply remediation.');
                const rl = require('readline').createInterface({
                    input: process.stdin,
                    output: process.stdout
                });
                const approved = await new Promise<boolean>((resolve) => {
                    rl.question(chalk.yellow(`Apply remediation? (y/N): `), (answer: string) => {
                        rl.close();
                        resolve(answer.trim().toLowerCase() === 'y');
                    });
                });
                if (!approved) {
                    logger.error('Remediation denied by human administrator.');
                    this.logToAudit(`[DENIED] Device: ${deviceId} | Blocked by administrator.`);
                    this.healingDevices.delete(deviceId);
                    return;
                }
            }

        
            const actSpinner = createSpinner('OODA Loop (Act): Applying remediation commands...').start();
            const session = this.coordinator.getSession(deviceId);
            if (!session) {
                throw new Error(`Device connection lost for ${deviceId}`);
            }

            const tx = new TransactionManager();
            await tx.initializeBackup(session);

            let remediationSuccess = true;
            let appliedCommands: string[] = [];
            for (const cmd of diagnosis.remediation_commands) {
                try {
                    const firewallResult = this.firewall.checkCommand(cmd, null);
                    if (firewallResult.dangerous) {
                        const approved = await this.firewall.verifyWithHuman(cmd, firewallResult.reason || 'High-risk token');
                        if (!approved) {
                            AuditLogger.log({
                                timestamp: new Date().toISOString(),
                                deviceId: deviceId,
                                role: 'auto-healer',
                                command: cmd,
                                status: 'BLOCKED',
                                reason: firewallResult.reason || 'Command denied by administrator.'
                            });
                            throw new Error(`Command "${cmd}" was blocked by CommandFirewall safety policy.`);
                        }
                    }

                    actSpinner.text = `OODA Loop (Act): Executing command: "${cmd}"...`;
                    tx.trackMutation(cmd);
                    const out = await session.execute(cmd);
                    const check = require('../guardrails/ErrorAnalyzer').ErrorAnalyzer.checkOutput(out);
                    if (check.hasError) {
                        throw new Error(`CLI Command error: ${check.errorType} - ${out}`);
                    }
                    appliedCommands.push(cmd);
                    AuditLogger.log({
                        timestamp: new Date().toISOString(),
                        deviceId: deviceId,
                        role: 'auto-healer',
                        command: cmd,
                        status: 'SUCCESS',
                        outputSnippet: out
                    });
                } catch (e: any) {
                    remediationSuccess = false;
                    actSpinner.fail(`Failed to execute command: "${cmd}". Error: ${e.message}`);
                    AuditLogger.log({
                        timestamp: new Date().toISOString(),
                        deviceId: deviceId,
                        role: 'auto-healer',
                        command: cmd,
                        status: 'FAILED',
                        reason: e.message
                    });
                    break;
                }
            }

            if (!remediationSuccess) {
                actSpinner.text = 'Automated Rollback: Reverting partial config mutations...';
                const rbLogs = await tx.executeRollback(session);
                actSpinner.fail('Remediation failed. Automated rollback executed.');
                this.logToAudit(`[FAILED-ACT] Device: ${deviceId} | Applied: ${appliedCommands.join(', ')} | Error during act. Rollback executed.`);
                AuditLogger.log({
                    timestamp: new Date().toISOString(),
                    deviceId: deviceId,
                    role: 'auto-healer',
                    command: 'automated_rollback',
                    status: 'ROLLBACK',
                    reason: 'Config recovery due to healing failure'
                });
                this.healingDevices.delete(deviceId);
                return;
            }
            actSpinner.succeed('Remediation commands successfully applied.');

            const verifySpinner = createSpinner('OODA Loop (Verify): Executing verification checks...').start();
            let verifyOutputs = '';
            for (const cmd of diagnosis.verification_commands) {
                try {
                    verifySpinner.text = `OODA Loop (Verify): Executing verification: "${cmd}"...`;
                    const out = await session.execute(cmd);
                    verifyOutputs += `Command: "${cmd}"\nOutput:\n${out}\n\n`;
                    AuditLogger.log({
                        timestamp: new Date().toISOString(),
                        deviceId: deviceId,
                        role: 'auto-healer',
                        command: cmd,
                        status: 'SUCCESS',
                        outputSnippet: out
                    });
                } catch (e: any) {
                    verifyOutputs += `Command: "${cmd}" failed: ${e.message}\n\n`;
                    AuditLogger.log({
                        timestamp: new Date().toISOString(),
                        deviceId: deviceId,
                        role: 'auto-healer',
                        command: cmd,
                        status: 'FAILED',
                        reason: e.message
                    });
                }
            }

            const isHealed = await this.verifyFixWithLLM(deviceId, msg, diagnosis.detected_issue, verifyOutputs);

            if (isHealed) {
                verifySpinner.succeed('Verification PASSED: Device recovered successfully.');
                this.logToAudit(`[SUCCESS] Device: ${deviceId} | Issue: ${diagnosis.detected_issue} | Remediation: ${appliedCommands.join(', ')}`);
            } else {
                verifySpinner.fail('Verification FAILED: The issue is not fully resolved. Triggering rollback...');
                const rbLogs = await tx.executeRollback(session);
                verifySpinner.fail(`Rollback completed successfully.`);
                this.logToAudit(`[FAILED-VERIFY] Device: ${deviceId} | Issue: ${diagnosis.detected_issue} | Verification failed. Rollback executed.`);
                AuditLogger.log({
                    timestamp: new Date().toISOString(),
                    deviceId: deviceId,
                    role: 'auto-healer',
                    command: 'automated_rollback',
                    status: 'ROLLBACK',
                    reason: 'Config recovery due to verification failure'
                });
            }

        } catch (e: any) {
            spinner.fail(`Healing sequence failed: ${e.message}`);
            this.logToAudit(`[ERROR] Device: ${deviceId} | Sequence failed: ${e.message}`);
        } finally {
            this.healingDevices.delete(deviceId);
        }
    }

    private async gatherContext(deviceId: string, msg: string): Promise<{ commandsRun: string[], outputs: string }> {
        const session = this.coordinator.getSession(deviceId);
        if (!session) {
            return { commandsRun: [], outputs: 'Connection not available.' };
        }

        const commands: string[] = [];
     
        const ifMatch = /Interface\s+(\S+?)(?:,|\s+changed|$)/i.exec(msg);
        const ifName = ifMatch ? ifMatch[1] : null;

        commands.push('show ip interface brief');
        if (ifName) {
            commands.push(`show interface ${ifName}`);
            commands.push(`show running-config interface ${ifName}`);
        }
        if (msg.includes('OSPF')) {
            commands.push('show ip ospf neighbor');
            commands.push('show ip ospf interface');
        }
        commands.push('show ip route');

        let outputs = '';
        for (const cmd of commands) {
            try {
                const res = await session.execute(cmd);
                outputs += `========================================\nCOMMAND: ${cmd}\n========================================\n${res}\n\n`;
            } catch (err: any) {
                outputs += `========================================\nCOMMAND: ${cmd}\n========================================\nFailed to run: ${err.message}\n\n`;
            }
        }

        return { commandsRun: commands, outputs };
    }

    private async diagnose(deviceId: string, syslog: string, context: string): Promise<{
        detected_issue: string;
        root_cause: string;
        confidence: number;
        remediation_commands: string[];
        verification_commands: string[];
    }> {
        const systemPrompt = `You are an expert Cisco network diagnostic AI agent operating in an AIOps closed-loop healing framework.
Your task is to analyze the triggering syslog alert and the current state output of the device to:
1. Identify the detected issue.
2. Determine the root cause.
3. Formulate the precise list of Cisco IOS configuration commands to remediate the issue (e.g. going into interface configuration mode if necessary, applying changes, ensuring no shutdown is run if the port was disabled).
4. Formulate verification commands to check if the remediation succeeded.

You MUST think step-by-step (Chain of Thought).
Your response MUST end with a single, valid JSON block matching this schema:
{
  "detected_issue": "short description of issue",
  "root_cause": "root cause description",
  "confidence": 0.0 to 1.0,
  "remediation_commands": ["list", "of", "commands"],
  "verification_commands": ["list", "of", "commands"]
}

Ensure the configuration commands are completely accurate for Cisco IOS syntax. For instance, to modify an interface, you must include the "interface GigabitEthernet0/1" command first.`;

        const userMsg = `Syslog Alert: "${syslog}"\n\nCollected Device Context:\n${context}`;

        const messages: ChatMessage[] = [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: userMsg }
        ];

        const res = await this.llmClient.generateCompletion(messages);
        const rawText = res.content || '';


        const jsonMatch = /\{[\s\S]*\}/.exec(rawText);
        if (!jsonMatch) {
            throw new Error(`Failed to parse JSON from AI response: ${rawText}`);
        }

        try {
            const parsed = JSON.parse(jsonMatch[0]);
            if (!parsed.remediation_commands || !parsed.verification_commands) {
                throw new Error(`Parsed JSON lacks required fields: ${jsonMatch[0]}`);
            }
            return {
                detected_issue: parsed.detected_issue || 'Unknown',
                root_cause: parsed.root_cause || 'Unknown',
                confidence: typeof parsed.confidence === 'number' ? parsed.confidence : 0.5,
                remediation_commands: parsed.remediation_commands || [],
                verification_commands: parsed.verification_commands || []
            };
        } catch (err: any) {
            throw new Error(`JSON parse error of AI response: ${err.message}. Original block: ${jsonMatch[0]}`);
        }
    }

    private async verifyFixWithLLM(deviceId: string, syslog: string, issue: string, outputs: string): Promise<boolean> {
        const systemPrompt = `You are a network verification validator. Analyze:
1. The original syslog alert.
2. The detected issue.
3. The post-remediation verification command outputs.

Determine if the issue has been successfully resolved (e.g. the line protocol changed to up/up, or routing neighbor state is now FULL).
Your response MUST end with either "SUCCESS" or "FAILED". Do not output any other text after.`;

        const userMsg = `Syslog Alert: "${syslog}"\nDetected Issue: "${issue}"\n\nPost-Remediation Verification Outputs:\n${outputs}`;

        const messages: ChatMessage[] = [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: userMsg }
        ];

        const res = await this.llmClient.generateCompletion(messages);
        const result = (res.content || '').trim().toUpperCase();
        return result.includes('SUCCESS');
    }

    private logToAudit(message: string): void {
        const timestamp = new Date().toISOString();
        const formatted = `[${timestamp}] ${message}\n`;
        try {
            fs.appendFileSync(this.logFilePath, formatted, 'utf8');
        } catch (e) {
            console.error(`Failed to write to healing audit log:`, e);
        }
    }
}
