import { TopologyDiscovery } from '../src/core/topology/TopologyDiscovery';
import { MultiAgentCoordinator } from '../src/core/agent/MultiAgentCoordinator';

describe('TopologyDiscovery', () => {
    it('parses CDP neighbors output into topology links', () => {
        const output = `
Device ID        Local Intrfce     Holdtme    Capability  Platform  Port ID
R2               Gig 0/1           144        R S I       ISR4451   Gig 0/0
`;

        const links = TopologyDiscovery.parseCdpNeighbors('R1', output);
        expect(links).toEqual([
            {
                localDeviceId: 'R1',
                localInterface: 'Gig 0/1',
                remoteDeviceId: 'R2',
                remoteInterface: 'Gig 0/0',
                protocol: 'cdp'
            }
        ]);
    });

    it('parses LLDP neighbors output into topology links', () => {
        const output = `
Device ID       Local Intf     Hold-time  Capability      Port ID
SW2             Gi1/0/1        120        B,R             Gi1/0/24
Total entries displayed: 1
`;

        const links = TopologyDiscovery.parseLldpNeighbors('SW1', output);
        expect(links).toEqual([
            {
                localDeviceId: 'SW1',
                localInterface: 'Gi1/0/1',
                remoteDeviceId: 'SW2',
                remoteInterface: 'Gi1/0/24',
                protocol: 'lldp'
            }
        ]);
    });
});

describe('MultiAgentCoordinator topology normalization', () => {
    it('deduplicates reciprocal links and aggregates discovered remote nodes', async () => {
        const coordinator = new MultiAgentCoordinator();

        const r1 = {
            connect: async () => {},
            disconnect: async () => {},
            getState: () => ({ currentMode: 'PRIVILEGED_EXEC', hostname: 'R1', prompt: 'R1#' }),
            execute: async (cmd: string) => {
                if (cmd === 'show cdp neighbors') {
                    return `Device ID        Local Intrfce     Holdtme    Capability  Platform  Port ID\nR2               Gig 0/1           144        R S I       ISR4451   Gig 0/0`;
                }
                return '';
            }
        } as any;

        const r2 = {
            connect: async () => {},
            disconnect: async () => {},
            getState: () => ({ currentMode: 'PRIVILEGED_EXEC', hostname: 'R2', prompt: 'R2#' }),
            execute: async (cmd: string) => {
                if (cmd === 'show cdp neighbors') {
                    return `Device ID        Local Intrfce     Holdtme    Capability  Platform  Port ID\nR1               Gig 0/0           144        R S I       ISR4451   Gig 0/1`;
                }
                return '';
            }
        } as any;

        coordinator.registerSession('R1', r1);
        coordinator.registerSession('R2', r2);

        const topology = await coordinator.discoverTopology();
        expect(topology.nodes.sort()).toEqual(['R1', 'R2']);
        expect(topology.links.length).toBe(1);
    });
});
