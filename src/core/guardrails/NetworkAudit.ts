import { MultiAgentCoordinator } from '../agent/MultiAgentCoordinator';
import chalk from 'chalk';

export interface AuditSnapshot {
    timestamp: string;
    downInterfacesCount: number;
    dynamicRoutesCount: number;
    routingAdjacenciesCount: number;
    pingReachability: boolean;
}

export class NetworkAudit {
    private coordinator: MultiAgentCoordinator;

    constructor(coordinator: MultiAgentCoordinator) {
        this.coordinator = coordinator;
    }

    public async takeSnapshot(targetDeviceId: string): Promise<AuditSnapshot> {
        const session = this.coordinator.getSession(targetDeviceId);
        if (!session) {
            throw new Error(`Device "${targetDeviceId}" not found for network audit.`);
        }

        let downInterfacesCount = 0;
        let dynamicRoutesCount = 0;
        let routingAdjacenciesCount = 0;
        let pingReachability = false;

        try {
            const ipBrief = await session.execute('show ip interface brief');
            const lines = ipBrief.split(/\r?\n/);
            for (const line of lines) {
                if (/^Interface\s+/i.test(line) || !line.trim()) continue;
                if (line.includes('down') || line.includes('administratively down')) {
                    downInterfacesCount++;
                }
            }
        } catch {}

        try {
            const ipRoute = await session.execute('show ip route');
            const lines = ipRoute.split(/\r?\n/);
            for (const line of lines) {
                const trimmed = line.trim();
                if (/^[O|B|D|R]\s+/i.test(trimmed)) {
                    dynamicRoutesCount++;
                }
            }
        } catch {}

        try {
            const ospfNeighbors = await session.execute('show ip ospf neighbor');
            const lines = ospfNeighbors.split(/\r?\n/);
            for (const line of lines) {
                if (/^Neighbor ID/i.test(line) || !line.trim()) continue;
                if (line.includes('FULL') || line.includes('2WAY')) {
                    routingAdjacenciesCount++;
                }
            }
        } catch {}

        try {
            const pingOut = await session.execute('ping 192.168.1.254');
            if (pingOut.includes('!!!!!') || pingOut.includes('Success rate is 100 percent') || pingOut.includes('Success rate is 80 percent')) {
                pingReachability = true;
            }
        } catch {}

        return {
            timestamp: new Date().toISOString(),
            downInterfacesCount,
            dynamicRoutesCount,
            routingAdjacenciesCount,
            pingReachability
        };
    }

    public static renderAuditReport(before: AuditSnapshot, after: AuditSnapshot): string {
        let out = '';
        out += chalk.bold.cyan('\n\n\n┌────────────────────────────────────────────────────────┐\n');
        out += chalk.bold.cyan('│') + chalk.bold.white('          NETWORK CHANGE WINDOW AUDIT REPORT            ') + chalk.bold.cyan('│\n');
        out += chalk.bold.cyan('├──────────────────────────┬──────────────┬──────────────┤\n');
        out += chalk.bold.cyan('│') + chalk.bold.white(' METRIC                   ') + chalk.bold.cyan('│') + chalk.bold.white(' PRE-FLIGHT   ') + chalk.bold.cyan('│') + chalk.bold.white(' POST-FLIGHT  ') + chalk.bold.cyan('│\n');
        out += chalk.bold.cyan('├──────────────────────────┼──────────────┼──────────────┤\n');

        const pingPre = before.pingReachability ? chalk.green('REACHABLE   ') : chalk.red('UNREACHABLE ');
        const pingPost = after.pingReachability ? chalk.green('REACHABLE   ') : chalk.red('UNREACHABLE ');
        out += chalk.bold.cyan('│') + ` Gateway Reachability     ` + chalk.bold.cyan('│') + ` ${pingPre} ` + chalk.bold.cyan('│') + ` ${pingPost} ` + chalk.bold.cyan('│\n');

        const downPre = `${before.downInterfacesCount} down       `.padEnd(12);
        const downPost = `${after.downInterfacesCount} down       `.padEnd(12);
        out += chalk.bold.cyan('│') + ` Down Interfaces Count    ` + chalk.bold.cyan('│') + ` ${downPre} ` + chalk.bold.cyan('│') + ` ${downPost} ` + chalk.bold.cyan('│\n');

        const routesPre = `${before.dynamicRoutesCount} routes     `.padEnd(12);
        const routesPost = `${after.dynamicRoutesCount} routes     `.padEnd(12);
        out += chalk.bold.cyan('│') + ` Dynamic Routes (OSPF/BGP)` + chalk.bold.cyan('│') + ` ${routesPre} ` + chalk.bold.cyan('│') + ` ${routesPost} ` + chalk.bold.cyan('│\n');

        const adjPre = `${before.routingAdjacenciesCount} peers      `.padEnd(12);
        const adjPost = `${after.routingAdjacenciesCount} peers      `.padEnd(12);
        out += chalk.bold.cyan('│') + ` Routing Adjacencies      ` + chalk.bold.cyan('│') + ` ${adjPre} ` + chalk.bold.cyan('│') + ` ${adjPost} ` + chalk.bold.cyan('│\n');

        out += chalk.bold.cyan('└──────────────────────────┴──────────────┴──────────────┘\n');

        if (before.pingReachability && !after.pingReachability) {
            out += chalk.bold.red('\n[!] WARNING: Network gateway reachability was LOST during this configuration window!\n');
        } else if (!before.pingReachability && after.pingReachability) {
            out += chalk.bold.green('\n[+] SUCCESS: Network gateway reachability was RESTORED during this configuration window!\n');
        } else {
            out += chalk.bold.green('\n[+] Audit check: Network gateway reachability is stable.\n');
        }

        return out;
    }
}
