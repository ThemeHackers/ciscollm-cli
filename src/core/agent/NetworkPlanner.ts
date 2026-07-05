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
        let fullReasoning = '';
        try {
            const response = await this.llmClient.generateCompletion(messages, [], (chunk) => {
                if (chunk.content) {
                    
                    const clean = NetworkPlanner.stripMarkdown(chunk.content);
                    process.stdout.write(chalk.cyan(clean));
                    fullContent += chunk.content;
                } else if (chunk.reasoning) {
                   
                    fullReasoning += chunk.reasoning;
                }
            });
            console.log();

           
            let planText = fullContent.trim() || (response.content || '').trim();

            if (!planText && fullReasoning) {
               
                planText = NetworkPlanner.extractPlanFromReasoning(fullReasoning);
                if (planText) {
                    
                    const cleanPrint = NetworkPlanner.stripMarkdown(planText);
                    console.log(chalk.cyan(cleanPrint));
                }
            }


            planText = NetworkPlanner.stripMarkdown(planText).trim();

            if (!planText) {
                throw new Error(
                    'The LLM returned an empty Orchestration Plan. ' +
                    'This can happen with small thinking models (e.g. qwen3.5-4b). ' +
                    'Try a larger model or use a non-thinking model.'
                );
            }

            return planText;
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


        const cleanBlueprint = NetworkPlanner.stripMarkdown(blueprint).slice(0, 2000);
        
        const systemPrompt = `You are a Network Risk Assessment AI.
Your job is to simulate the 'What-If' impact of the following execution blueprint on the current network state.
Output ONLY a short Risk Assessment Report of max 5 lines. No preamble, no thinking process, no markdown.
Format:
1. [Potential disruption description]
2. [Another disruption if any]
Overall Risk Level: LOW | MEDIUM | HIGH | CRITICAL`;

        const messages: ChatMessage[] = [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: `Current State:\n${stateStr}\n\nPlanned Blueprint:\n${cleanBlueprint}` }
        ];

        console.log(chalk.cyan('\n🔍 WHAT-IF ANALYSIS (SIMULATING IMPACT)'));
        let impact = '';
        let impactReasoning = '';
        try {
            const response = await this.llmClient.generateCompletion(messages, [], (chunk) => {
                if (chunk.content) {
                    const clean = NetworkPlanner.stripMarkdown(chunk.content);
                    process.stdout.write(chalk.cyan(clean));
                    impact += chunk.content;
                } else if (chunk.reasoning) {
                 
                    impactReasoning += chunk.reasoning;
                }
            });
            console.log('\n');

            let result = impact.trim() || (response.content || '').trim();
            if (!result && impactReasoning) {
                result = NetworkPlanner.extractImpactFromReasoning(impactReasoning);
            }

            return NetworkPlanner.stripMarkdown(result).trim() ||
                   'Impact simulation completed with no specific warnings.';
        } catch (e: any) {
            console.log(chalk.red(`\n[Simulation Failed: ${e.message}]\n`));
            return 'Could not simulate impact due to an error.';
        }
    }

    /**
     * Strip markdown bold/italic markers from text: **text** → text, *text* → text
     */
    private static stripMarkdown(text: string): string {
        return text
            .replace(/\*\*([^*]+)\*\*/g, '$1')   
            .replace(/\*([^*\n]+)\*/g, '$1')      
            .replace(/`([^`]+)`/g, '$1')           
            .replace(/_{2}([^_]+)_{2}/g, '$1')     
            .replace(/_([^_\n]+)_/g, '$1');       
    }

    private static extractPlanFromReasoning(reasoning: string): string {
       
        const marker = 'Orchestration Plan';
        const lastIdx = reasoning.toLowerCase().lastIndexOf(marker.toLowerCase());
        if (lastIdx !== -1) {
            const fromPlan = reasoning.slice(lastIdx);
         
            const stopPattern = /\n\s*(?:\*(?:Refining|Self-Correction|Wait|Actually|Now,|Let me|Hmm|Note:)|Wait,|Actually,|Hmm,|Now,\s)/;
            const stopMatch = stopPattern.exec(fromPlan);
            const extracted = stopMatch
                ? fromPlan.slice(0, stopMatch.index)
                : fromPlan;
            const cleaned = extracted.trim();

            if (/Step\s*\d+/i.test(cleaned)) {
                return cleaned;
            }
        }


        const stepLines: string[] = [];
        let inPlan = false;
        for (const line of reasoning.split('\n')) {
            if (/Orchestration Plan/i.test(line)) { inPlan = true; stepLines.length = 0; } 
            if (!inPlan) continue;
            const trimmed = line.trim();
            if (/^\*(?:Refining|Self-Correction|Wait|Actually|Now,)/i.test(trimmed)) { inPlan = false; continue; }
            if (trimmed) stepLines.push(trimmed);
        }
        return stepLines.length >= 2 ? stepLines.join('\n') : '';
    }


    private static extractImpactFromReasoning(reasoning: string): string {

        const riskMatch = reasoning.match(/(?:^|\n)([^\n]*(?:disruption|impact|risk)[^\n]*\n)*[^\n]*Overall Risk Level[^\n]*/im);
        if (riskMatch) {
            return riskMatch[0].trim();
        }


        const paragraphs = reasoning.split(/\n\s*\n/).map(p => p.trim()).filter(Boolean);
        return paragraphs[paragraphs.length - 1] || '';
    }
}
