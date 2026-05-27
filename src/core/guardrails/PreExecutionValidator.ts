import { NetworkTopology } from '../../shared/types';

export interface ValidationResult {
    safe: boolean;
    warnLevel: 'INFO' | 'WARNING' | 'CRITICAL';
    reason?: string;
}

export class PreExecutionValidator {

    public static validateCommand(
        command: string,
        deviceId: string,
        topology: NetworkTopology,
        currentInterfaceContext: string | null
    ): ValidationResult {
        const normalized = command.toLowerCase().trim();
        
     
        if (normalized.startsWith('no ip route 0.0.0.0') || normalized.startsWith('no ip route 0.0.0.0 0.0.0.0')) {
            return {
                safe: false,
                warnLevel: 'CRITICAL',
                reason: `Command attempts to remove the default gateway route. This will disconnect remote SSH/Telnet sessions.`
            };
        }

    
        if (normalized.startsWith('router ospf') || normalized.startsWith('router bgp') || normalized.startsWith('router rip')) {
            return {
                safe: true,
                warnLevel: 'WARNING',
                reason: `Entering dynamic routing configuration mode. Incorrect network declarations can disrupt routing convergence across the backbone.`
            };
        }

        const interfaceMatch = /^interface\s+([A-Za-z0-9\/\.\-]+)/i.exec(command.trim());
        let targetedInterface = interfaceMatch ? interfaceMatch[1].toLowerCase().trim() : null;
        
        if (currentInterfaceContext && !targetedInterface) {
            targetedInterface = currentInterfaceContext.toLowerCase().trim();
        }

        if (targetedInterface && normalized.includes('shutdown')) {
          
            const connectedLink = topology.links.find(link => 
                (link.localDeviceId.toLowerCase() === deviceId.toLowerCase() && link.localInterface.toLowerCase() === targetedInterface) ||
                (link.remoteDeviceId.toLowerCase() === deviceId.toLowerCase() && link.remoteInterface.toLowerCase() === targetedInterface)
            );

            if (connectedLink) {
                const neighborId = connectedLink.localDeviceId.toLowerCase() === deviceId.toLowerCase() 
                    ? connectedLink.remoteDeviceId 
                    : connectedLink.localDeviceId;
                
                return {
                    safe: false,
                    warnLevel: 'CRITICAL',
                    reason: `Interface "${targetedInterface}" is actively connected to neighbor device "${neighborId}" via ${connectedLink.protocol.toUpperCase()}. Shutting it down will break network topology adjacency.`
                };
            }
        }

       
        if (targetedInterface && (normalized.startsWith('no ip address') || normalized.startsWith('ip address'))) {
            const connectedLink = topology.links.find(link => 
                (link.localDeviceId.toLowerCase() === deviceId.toLowerCase() && link.localInterface.toLowerCase() === targetedInterface) ||
                (link.remoteDeviceId.toLowerCase() === deviceId.toLowerCase() && link.remoteInterface.toLowerCase() === targetedInterface)
            );

            if (connectedLink && normalized.startsWith('no ip address')) {
                return {
                    safe: false,
                    warnLevel: 'CRITICAL',
                    reason: `Removing IP address from "${targetedInterface}", which is an active network uplink to neighbor "${connectedLink.localDeviceId === deviceId ? connectedLink.remoteDeviceId : connectedLink.localDeviceId}".`
                };
            }
        }

        return {
            safe: true,
            warnLevel: 'INFO'
        };
    }
}
