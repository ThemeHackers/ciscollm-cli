export type NetworkAgentRole = 'CORE' | 'DISTRIBUTION' | 'ACCESS';

export interface SpecializedAgent {
    role: NetworkAgentRole;
    description: string;
    allowedPattern: RegExp[];
}

export class HierarchicalAgentManager {
    private static agents: SpecializedAgent[] = [
        {
            role: 'CORE',
            description: 'Handles core routing tables, dynamic routing protocols (OSPF, BGP, RIP), static routes, and IP SLAs.',
            allowedPattern: [
                /^(no\s+)?ip\s+route\s+/i,
                /^(no\s+)?router\s+(ospf|bgp|rip|eigrp)/i,
                /^(no\s+)?network\s+/i,
                /^(no\s+)?neighbor\s+/i,
                /^show\s+ip\s+route/i,
                /^show\s+ip\s+ospf/i,
                /^show\s+ip\s+bgp/i
            ]
        },
        {
            role: 'DISTRIBUTION',
            description: 'Handles VLAN databases, trunking protocols, authentication (AAA), ACL firewalls, and NAT mappings.',
            allowedPattern: [
                /^(no\s+)?vlan\s+\d+/i,
                /^(no\s+)?access-list\s+/i,
                /^(no\s+)?ip\s+access-list\s+/i,
                /^(no\s+)?ip\s+access-group\s+/i,
                /^(no\s+)?crypto\s+key\s+/i,
                /^(no\s+)?aaa\s+/i,
                /^(no\s+)?ip\s+nat\s+/i,
                /^show\s+vlan/i,
                /^show\s+access-lists/i
            ]
        },
        {
            role: 'ACCESS',
            description: 'Handles physical port assignments, loopbacks, speed/duplex, interface shut/no shut, port descriptions, and interface IPs.',
            allowedPattern: [
                /^(no\s+)?interface\s+/i,
                /^(no\s+)?ip\s+address\s+/i,
                /^(no\s+)?description\s+/i,
                /^(no\s+)?shutdown/i,
                /^(no\s+)?speed\s+/i,
                /^(no\s+)?duplex\s+/i,
                /^show\s+ip\s+interface/i,
                /^show\s+interfaces/i
            ]
        }
    ];


    public static routeCommand(command: string): NetworkAgentRole {
        const clean = command.trim();

        for (const agent of this.agents) {
            for (const pattern of agent.allowedPattern) {
                if (pattern.test(clean)) {
                    return agent.role;
                }
            }
        }

     
        return 'ACCESS';
    }


    public static getHierarchicalAgentPrompt(): string {
        return `You are operating as a Hierarchical Network Swarm. Tasks are segregated into three agent layers:
- CORE AGENT (Core Routing, OSPF, BGP, Static Routes)
- DISTRIBUTION AGENT (VLANs, ACLs, Security policies, NAT)
- ACCESS AGENT (User ports, Interfaces, Speed/Duplex, IP Assignment)

Always specify in your thoughts which agent layer is executing the command (e.g. "[AccessAgent] Modifying interface GigabitEthernet0/1").`;
    }
}
