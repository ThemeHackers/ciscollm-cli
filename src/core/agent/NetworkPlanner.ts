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

=== ENVIRONMENT ===
Available Devices: ${devicesStr}
Available Plugins/Scripts:
${plugins || 'None'}

=== INSTRUCTIONS ===
1. Analyze the user's goal.
2. Break it down into step-by-step device operations.
3. For each step, specify:
   - Target Device
   - Action (What will be done, not necessarily the exact syntax, but the logical operation)
   - Risk Level (LOW, MEDIUM, HIGH)
4. Format your output as a clean, readable Markdown document with a clear structure. Do not output raw JSON, make it human readable.
5. Use bullet points and bold text for clarity.

Example:
### Orchestration Plan
**Step 1:** [Device: Core-1]
- **Action**: Configure OSPF process 1 and add network 10.0.0.0/24
- **Risk**: MEDIUM

**Step 2:** [Device: Dist-1]
- **Action**: Ping Core-1 to verify OSPF adjacency
- **Risk**: LOW
`;
        
        const messages: ChatMessage[] = [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: `Goal: ${goal}` }
        ];

        console.log(chalk.magenta('\n=== ORCHESTRATION PLANNER ==='));
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
}
