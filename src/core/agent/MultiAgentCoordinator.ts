import { BaseSession } from '../../infrastructure/protocols/BaseSession';
import { NetworkTopology, SessionState, TopologyLink } from '../../shared/types';
import { TopologyDiscovery } from '../topology/TopologyDiscovery';
import chalk from 'chalk';

export class MultiAgentCoordinator {
    private sessions: Map<string, BaseSession> = new Map();
    private topology: NetworkTopology = {
        discoveredAt: new Date(0).toISOString(),
        nodes: [],
        links: []
    };

    public registerSession(deviceId: string, session: BaseSession): void {
        this.sessions.set(deviceId, session);
    }

    public async connectAll(): Promise<void> {
        console.log(chalk.cyan(`❯ Establishing parallel connections to ${this.sessions.size} target device(s)...`));
        const promises = Array.from(this.sessions.entries()).map(async ([id, session]) => {
            try {
                await session.connect();
                console.log(chalk.green(`[+] Device "${id}" connected successfully.`));
            } catch (err: any) {
                throw new Error(`Device "${id}" failed to connect: ${err.message}`);
            }
        });
        await Promise.all(promises);
    }

    public async executeCommand(deviceId: string, command: string): Promise<string> {
        const session = this.sessions.get(deviceId);
        if (!session) {
            throw new Error(`Device "${deviceId}" is not registered in this coordinator session.`);
        }
        return await session.execute(command);
    }

    public getSessions(): Map<string, BaseSession> {
        return this.sessions;
    }

    public getSession(deviceId: string): BaseSession | undefined {
        return this.sessions.get(deviceId);
    }

    public getAllStates(): Record<string, SessionState> {
        const states: Record<string, SessionState> = {};
        for (const [id, session] of this.sessions.entries()) {
            states[id] = session.getState();
        }
        return states;
    }

    public async discoverTopology(): Promise<NetworkTopology> {
        const links: TopologyLink[] = [];
        const nodeSet = new Set(Array.from(this.sessions.keys()));

        for (const [deviceId, session] of this.sessions.entries()) {
            try {
                const cdpOutput = await session.execute('show cdp neighbors');
                const parsed = TopologyDiscovery.parseCdpNeighbors(deviceId, cdpOutput);
                parsed.forEach(link => nodeSet.add(link.remoteDeviceId));
                links.push(...parsed);
            } catch {
                // CDP may be disabled; try LLDP in the same iteration.
            }

            try {
                const lldpOutput = await session.execute('show lldp neighbors');
                const parsed = TopologyDiscovery.parseLldpNeighbors(deviceId, lldpOutput);
                parsed.forEach(link => nodeSet.add(link.remoteDeviceId));
                links.push(...parsed);
            } catch {
                // LLDP may be unavailable on some platforms.
            }
        }

        const dedupedLinks = this.deduplicateLinks(links);

        this.topology = {
            discoveredAt: new Date().toISOString(),
            nodes: Array.from(nodeSet),
            links: dedupedLinks
        };

        return this.topology;
    }

    public getTopology(): NetworkTopology {
        return this.topology;
    }

    private deduplicateLinks(links: TopologyLink[]): TopologyLink[] {
        const seen = new Set<string>();
        const deduped: TopologyLink[] = [];

        for (const link of links) {
            const endpointA = `${link.localDeviceId}|${link.localInterface}`;
            const endpointB = `${link.remoteDeviceId}|${link.remoteInterface}`;
            const normalized = [endpointA, endpointB].sort().join('<->');
            if (seen.has(normalized)) {
                continue;
            }
            seen.add(normalized);
            deduped.push(link);
        }

        return deduped;
    }

    public async disconnectAll(): Promise<void> {
        console.log(chalk.cyan('❯ Terminating all connection channels...'));
        for (const [id, session] of this.sessions.entries()) {
            try {
                await session.disconnect();
                console.log(chalk.green(`[+] Device "${id}" disconnected cleanly.`));
            } catch (err: any) {
                console.warn(chalk.yellow(`[!] Device "${id}" failed to close cleanly: ${err.message}`));
            }
        }
        this.sessions.clear();
    }
}
