export class IntentTranslator {
    
    public static validateCommandAgainstIntent(command: string, intent: string): { valid: boolean; reason?: string } {
        const lowerIntent = intent.toLowerCase();
        const lowerCmd = command.toLowerCase().trim();

        
        const whitelist = ['show', 'enable', 'disable', 'configure terminal', 'exit', 'end', 'ping', 'dir'];
        if (whitelist.some(w => lowerCmd.startsWith(w))) {
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

        if (lowerIntent.includes('interface') || lowerIntent.includes('port')) {
            if (lowerCmd.startsWith('interface ') || lowerCmd.includes('ip address') || lowerCmd.includes('description') || lowerCmd.includes('shutdown')) {
                return { valid: true };
            }
        }

       
        if (!lowerIntent.includes('vlan') && !lowerIntent.includes('ospf') && !lowerIntent.includes('route') && !lowerIntent.includes('interface') && !lowerIntent.includes('port')) {
            return { valid: true }; 
        }

        return { 
            valid: false, 
            reason: `The command "${command}" does not seem to deterministically match the intent domain "${intent}".` 
        };
    }
}
