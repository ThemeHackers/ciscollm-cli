import { TopologyLink } from '../../shared/types';

export class TopologyDiscovery {
    public static parseCdpNeighbors(localDeviceId: string, output: string): TopologyLink[] {
        const links: TopologyLink[] = [];
        const lines = output.split(/\r?\n/);

        for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed || /^Device\s+ID/i.test(trimmed) || /^-+/.test(trimmed)) {
                continue;
            }

            const match = trimmed.match(/^(\S+)\s+(\S+\s+\S+)\s+\d+\s+\S+\s+\S+\s+(\S+\s+\S+)$/);
            if (!match) {
                continue;
            }

            const remoteDeviceId = match[1];
            const localInterface = match[2].replace(/\s+/g, ' ').trim();
            const remoteInterface = match[3].replace(/\s+/g, ' ').trim();

            links.push({
                localDeviceId,
                localInterface,
                remoteDeviceId,
                remoteInterface,
                protocol: 'cdp'
            });
        }

        return links;
    }

    public static parseLldpNeighbors(localDeviceId: string, output: string): TopologyLink[] {
        const links: TopologyLink[] = [];
        const lines = output.split(/\r?\n/);

        for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed || /^Device ID/i.test(trimmed) || /^Total entries displayed/i.test(trimmed)) {
                continue;
            }

            const match = trimmed.match(/^(\S+)\s+(\S+)\s+\d+\s+\S+\s+(\S+)$/);
            if (!match) {
                continue;
            }

            links.push({
                localDeviceId,
                remoteDeviceId: match[1],
                localInterface: match[2],
                remoteInterface: match[3],
                protocol: 'lldp'
            });
        }

        return links;
    }
}
