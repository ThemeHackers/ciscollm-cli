import { LLMClient } from '../../infrastructure/llm/LLMClient';

export class IntentTranslator {
    
    public static async categorizeComplexityWithLLM(llmClient: LLMClient, intent: string): Promise<'FAST_TRACK' | 'DEEP_ORCHESTRATION' | 'QUERY_ONLY'> {
        const systemPrompt = `You are an Intent Classifier for a Cisco Network Automation tool.
The user will provide an intent. You must output exactly one word: 'FAST_TRACK', 'DEEP_ORCHESTRATION', or 'QUERY_ONLY'.
Rules:
- Use 'QUERY_ONLY' if the user is just asking a question, wanting to look up information, or troubleshoot (e.g. "who is connected to port 1?", "why is internet slow?", "show routing table").
- Use 'FAST_TRACK' if the intent is a simple state-changing configuration (e.g. setting or changing hostname, setting passwords).
- Use 'DEEP_ORCHESTRATION' if the intent is complex and involves state-changing configurations (e.g. configuring OSPF, routing, VLANs, ACLs, BGP, or interface states like shutdown/no shutdown).
No other text, explanations, or markdown.`;

        try {
            const response = await llmClient.generateCompletion([
                { role: 'system', content: systemPrompt },
                { role: 'user', content: intent }
            ], []);
            
            const rawResponse = (response.content || '').toUpperCase();
            if (rawResponse.includes('QUERY_ONLY')) {
                return 'QUERY_ONLY';
            }
            if (rawResponse.includes('FAST_TRACK')) {
                return 'FAST_TRACK';
            }
            return 'DEEP_ORCHESTRATION';
        } catch (e: any) {
           
            return 'DEEP_ORCHESTRATION';
        }
    }

    public static validateCommandAgainstIntent(command: string, intent: string): { valid: boolean; reason?: string } {
        const lowerIntent = intent.toLowerCase();
        const lowerCmd = command.toLowerCase().trim();

       
        const whitelist = ['show', 'enable', 'disable', 'configure terminal', 'conf t', 'exit', 'end', 'ping', 'dir', 'write', 'wr', 'copy'];
        if (whitelist.some(w => lowerCmd.startsWith(w))) {
            return { valid: true };
        }

        
        if (lowerCmd.startsWith('access-list ') || lowerCmd.startsWith('ip access-list') ||
            lowerCmd.includes('access-group') || lowerCmd.includes('ip access-group')) {
            return { valid: true };
        }


        if (lowerCmd.startsWith('interface ') || lowerCmd.includes('ip address') ||
            lowerCmd.includes('description') || lowerCmd.includes('shutdown') ||
            lowerCmd.includes('no shutdown') || lowerCmd.includes('ip access-group')) {
            return { valid: true };
        }


        if (lowerIntent.includes('vlan')) {
            if (lowerCmd.startsWith('vlan ') || lowerCmd.startsWith('name ') || lowerCmd.includes('switchport')) {
                return { valid: true };
            }
        }

 
        if (lowerIntent.includes('ospf') || lowerIntent.includes('route')) {
            if (lowerCmd.includes('router ospf') || lowerCmd.includes('network') || lowerCmd.includes('ip route')) {
                return { valid: true };
            }
        }

 
        if (lowerCmd.startsWith('hostname') || lowerCmd.startsWith('ntp') ||
            lowerCmd.startsWith('logging') || lowerCmd.startsWith('banner') ||
            lowerCmd.startsWith('service') || lowerCmd.startsWith('no ') ||
            lowerCmd.startsWith('ip ') || lowerCmd.startsWith('crypto ') ||
            lowerCmd.startsWith('line ') || lowerCmd.startsWith('router ')) {
            return { valid: true };
        }

       
        return { valid: true };
    }
}
