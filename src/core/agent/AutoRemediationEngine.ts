import { LLMClient } from '../../infrastructure/llm/LLMClient';
import { MultiAgentCoordinator } from './MultiAgentCoordinator';
import { CiscoAgentLoop } from './AgentLoop';
import chalk from 'chalk';
import axios from 'axios';

export class AutoRemediationEngine {
    constructor(
        private llmClient: LLMClient,
        private coordinator: MultiAgentCoordinator,
        private webhookUrl?: string
    ) {}

    public async checkHealth(): Promise<{ healthy: boolean; issue?: string }> {
        console.log(chalk.gray('Running background health checks...'));
        try {
            for (const [id, session] of this.coordinator.getSessions().entries()) {
                const output = await session.execute('show ip interface brief | exclude unassigned');
              
                const downMatch = output.match(/(\S+)\s+(?:\d+\.\d+\.\d+\.\d+)\s+YES\s+(?:NVRAM|manual)\s+down\s+down/i);
                if (downMatch) {
                    console.log(chalk.yellow(`Detected downed interface on ${id}: ${downMatch[1]}`));
                    return { healthy: false, issue: `Interface ${downMatch[1]} on device ${id} is unexpectedly down. output: ${output}` };
                }
            }
            console.log(chalk.green('Network is healthy.'));
            return { healthy: true };
        } catch (e: any) {
            console.log(chalk.red(`Health check failed: ${e.message}`));
            return { healthy: false, issue: `Could not retrieve status: ${e.message}` };
        }
    }

    public async autoRemediate(issue: string): Promise<void> {
        console.log(chalk.red('\n🚨 AUTO-REMEDIATION TRIGGERED 🚨'));
        console.log(chalk.yellow(`Issue Detected: ${issue}`));
        
        await this.sendWebhook({ status: 'TRIGGERED', issue });

        const agent = new CiscoAgentLoop(this.llmClient, this.coordinator, {
            fastTrack: true, 
            rbacRole: 'system_daemon',
            safeMode: true
        });

        const goal = `Background Task: Investigate and fix the following issue: "${issue}". Use show commands to understand why it is down, then execute configuration commands (like 'no shutdown') to fix it if it is a configuration issue. Verify it comes back up.`;
        
        try {
            await agent.run(goal);
            console.log(chalk.green('\n AUTO-REMEDIATION COMPLETE \n'));
            await this.sendWebhook({ status: 'RESOLVED', issue, details: 'The AI agent has successfully completed the remediation task.' });
        } catch (e: any) {
            console.log(chalk.red(`\n AUTO-REMEDIATION FAILED: ${e.message} \n`));
            await this.sendWebhook({ status: 'FAILED', issue, error: e.message });
        }
    }

    private async sendWebhook(payload: any): Promise<void> {
        if (!this.webhookUrl) return;
        try {
            await axios.post(this.webhookUrl, {
                timestamp: new Date().toISOString(),
                component: 'CiscoLLM-Daemon',
                ...payload
            });
            console.log(chalk.gray(`[Webhook sent to ${this.webhookUrl}]`));
        } catch (err: any) {
            console.log(chalk.red(`[Failed to send webhook: ${err.message}]`));
        }
    }
}
