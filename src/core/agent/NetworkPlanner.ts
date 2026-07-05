import { LLMClient } from '../../infrastructure/llm/LLMClient';
import { MultiAgentCoordinator } from './MultiAgentCoordinator';
import { ChatMessage } from '../../shared/types';
import chalk from 'chalk';
import { PluginManager } from '../plugins/PluginManager';

export class NetworkPlanner {
    constructor(private llmClient: LLMClient, private coordinator: MultiAgentCoordinator) {}

    public async generatePlan(goal: string): Promise<string> {
        const topology = this.coordinator.getTopology();
        let devicesStr = '';
        if (topology.nodes.length > 0) {
            devicesStr = topology.nodes.join(', ');
        } else {
            devicesStr = Array.from(this.coordinator.getSessions().keys()).join(', ');
        }

        const plugins = PluginManager.getInstance().getDynamicTools().map(t => `- ${t.function.name}: ${t.function.description}`).join('\n');

        const systemPrompt = `You are a Principal Network Architect orchestrating operations across multiple Cisco Enterprise devices.
Your task is to translate the user's high-level intent into a detailed Execution Blueprint (Orchestration Plan) before any commands are run on actual hardware.

ENVIRONMENT
Available Devices: ${devicesStr}
Available Plugins/Scripts:
${plugins || 'None'}

INSTRUCTIONS
1. Evaluate Intent: If the user's goal is completely unrelated to Network Engineering, Cisco operations, or CLI commands (e.g. "book a flight", "write python"), output EXACTLY: "REJECTED_INTENT: The requested task is outside the scope of network operations." and stop.
2. Analyze the user's goal and break it down into step-by-step device operations.
3. For each step, specify:
   - Target Device
   - Action (What will be done, not necessarily the exact syntax, but the logical operation)
   - Risk Level (LOW, MEDIUM, HIGH)
4. Format your output as a clean, readable text document. Do NOT use markdown asterisks (**) or bold text. Do not output raw JSON, make it human readable.

Example:
Orchestration Plan

Step 1: [Device: Core-1]
- Action: Configure OSPF process 1 and add network 10.0.0.0/24
- Risk: MEDIUM

Step 2: [Device: Dist-1]
- Action: Ping Core-1 to verify OSPF adjacency
- Risk: LOW
`;
        
        const messages: ChatMessage[] = [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: `Goal: ${goal}` }
        ];

        console.log(chalk.magenta('\nORCHESTRATION PLANNER'));
        console.log(chalk.gray('Analyzing topology and generating execution blueprint...'));

        let fullContent = '';
        try {
            const response = await this.llmClient.generateCompletion(messages, [], (chunk) => {
                if (chunk.content) {
                    process.stdout.write(chalk.cyan(chunk.content));
                    fullContent += chunk.content;
                }
            });
            console.log(); 
            return response.content || fullContent;
        } catch (e: any) {
            console.log(chalk.red(`\nFailed to generate orchestration plan: ${e.message}`));
            throw e;
        }
    }

    public async simulateImpact(blueprint: string): Promise<string> {
        const stateStrs: string[] = [];
        for (const [id, session] of this.coordinator.getSessions().entries()) {
            stateStrs.push(`Device: ${id}\nPrompt: ${session.getState().prompt}`);
        }
        const stateStr = stateStrs.join('\n');
        
        const systemPrompt = `You are a Network Risk Assessment AI.
Your job is to simulate the 'What-If' impact of the following execution blueprint on the current network state.
You must output a short Risk Assessment Report (max 5 lines) detailing:
1. Potential disruptions (e.g., "This will drop SSH connections to the management IP").
2. Overall Risk Level (LOW, MEDIUM, HIGH, CRITICAL).
Do NOT write code or commands, just the impact analysis.`;

        const messages: ChatMessage[] = [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: `Current State:\n${stateStr}\n\nPlanned Blueprint:\n${blueprint}` }
        ];

        console.log(chalk.cyan('\n🔍 WHAT-IF ANALYSIS (SIMULATING IMPACT)'));
        let impact = '';
        try {
            const response = await this.llmClient.generateCompletion(messages, [], (chunk) => {
                if (chunk.content) {
                    process.stdout.write(chalk.cyan(chunk.content));
                    impact += chunk.content;
                }
            });
            console.log('\n');
            return impact.trim() || response.content || 'Impact simulation completed with no specific warnings.';
        } catch (e: any) {
            console.log(chalk.red(`\n[Simulation Failed: ${e.message}]\n`));
            return 'Could not simulate impact due to an error.';
        }
    }
}
