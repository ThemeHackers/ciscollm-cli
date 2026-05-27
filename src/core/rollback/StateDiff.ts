import { SessionState } from '../../shared/types';
import chalk from 'chalk';

export interface InterfaceStateSnapshot {
    name: string;
    ip: string | null;
    subnet: string | null;
    adminShutdown: boolean;
    lineProtocolUp: boolean;
    description: string | null;
}

export interface RoutingStateSnapshot {
    network: string;
    mask: string;
    nextHop: string | null;
}

export interface DeviceStateSnapshot {
    deviceId: string;
    timestamp: string;
    sessionState: SessionState;
    interfaces: InterfaceStateSnapshot[];
    routes: RoutingStateSnapshot[];
    vlans: number[];
}

export interface StateDiffResult {
    modifiedInterfaces: Array<{
        name: string;
        changes: Array<{ field: string; before: any; after: any }>;
    }>;
    addedRoutes: RoutingStateSnapshot[];
    removedRoutes: RoutingStateSnapshot[];
    addedVlans: number[];
    removedVlans: number[];
    hostnameChanged: { before: string; after: string } | null;
}

export class StateDiff {
    
    public static diff(before: DeviceStateSnapshot, after: DeviceStateSnapshot): StateDiffResult {
        const result: StateDiffResult = {
            modifiedInterfaces: [],
            addedRoutes: [],
            removedRoutes: [],
            addedVlans: [],
            removedVlans: [],
            hostnameChanged: null
        };

   
        if (before.sessionState.hostname !== after.sessionState.hostname) {
            result.hostnameChanged = {
                before: before.sessionState.hostname,
                after: after.sessionState.hostname
            };
        }

       
        for (const afterIntf of after.interfaces) {
            const beforeIntf = before.interfaces.find(i => i.name === afterIntf.name);
            if (!beforeIntf) {
               
                result.modifiedInterfaces.push({
                    name: afterIntf.name,
                    changes: [{ field: 'created', before: null, after: true }]
                });
                continue;
            }

            const changes: Array<{ field: string; before: any; after: any }> = [];
            if (beforeIntf.ip !== afterIntf.ip) changes.push({ field: 'ip', before: beforeIntf.ip, after: afterIntf.ip });
            if (beforeIntf.subnet !== afterIntf.subnet) changes.push({ field: 'subnet', before: beforeIntf.subnet, after: afterIntf.subnet });
            if (beforeIntf.adminShutdown !== afterIntf.adminShutdown) changes.push({ field: 'adminShutdown', before: beforeIntf.adminShutdown, after: afterIntf.adminShutdown });
            if (beforeIntf.description !== afterIntf.description) changes.push({ field: 'description', before: beforeIntf.description, after: afterIntf.description });

            if (changes.length > 0) {
                result.modifiedInterfaces.push({ name: afterIntf.name, changes });
            }
        }


        for (const afterRoute of after.routes) {
            const exists = before.routes.some(r => r.network === afterRoute.network && r.mask === afterRoute.mask && r.nextHop === afterRoute.nextHop);
            if (!exists) {
                result.addedRoutes.push(afterRoute);
            }
        }
        for (const beforeRoute of before.routes) {
            const exists = after.routes.some(r => r.network === beforeRoute.network && r.mask === beforeRoute.mask && r.nextHop === beforeRoute.nextHop);
            if (!exists) {
                result.removedRoutes.push(beforeRoute);
            }
        }

    
        for (const vlan of after.vlans) {
            if (!before.vlans.includes(vlan)) {
                result.addedVlans.push(vlan);
            }
        }
        for (const vlan of before.vlans) {
            if (!after.vlans.includes(vlan)) {
                result.removedVlans.push(vlan);
            }
        }

        return result;
    }

    /**
     * Helper to render the diff output as a readable table/string.
     */
    public static renderDiff(diff: StateDiffResult): string {
        const lines: string[] = [];

        if (diff.hostnameChanged) {
            lines.push(chalk.cyan(`  Device Hostname Changed: `) + chalk.red(`"${diff.hostnameChanged.before}"`) + chalk.gray(' ➔ ') + chalk.green(`"${diff.hostnameChanged.after}"`));
        }

        if (diff.modifiedInterfaces.length > 0) {
            lines.push(chalk.cyan('  Interface State Changes:'));
            for (const item of diff.modifiedInterfaces) {
                lines.push(chalk.bold.yellow(`    * ${item.name}:`));
                for (const change of item.changes) {
                    const beforeVal = change.before ?? 'unassigned';
                    const afterVal = change.after ?? 'unassigned';
                    let formattedLine = '';
                    if (change.field === 'adminShutdown') {
                        formattedLine = `      - shutdown: ` + (change.before ? chalk.red('YES') : chalk.green('NO')) + chalk.gray(' ➔ ') + (change.after ? chalk.red('YES') : chalk.green('NO'));
                    } else {
                        formattedLine = `      - ${change.field}: ` + chalk.red(`"${beforeVal}"`) + chalk.gray(' ➔ ') + chalk.green(`"${afterVal}"`);
                    }
                    lines.push(formattedLine);
                }
            }
        }

        if (diff.addedRoutes.length > 0) {
            lines.push(chalk.green('  Routes Added (+)'));
            for (const r of diff.addedRoutes) {
                lines.push(chalk.green(`    + ip route ${r.network} ${r.mask} ${r.nextHop || ''}`));
            }
        }

        if (diff.removedRoutes.length > 0) {
            lines.push(chalk.red('  Routes Removed (-)'));
            for (const r of diff.removedRoutes) {
                lines.push(chalk.red(`    - ip route ${r.network} ${r.mask} ${r.nextHop || ''}`));
            }
        }

        if (diff.addedVlans.length > 0) {
            lines.push(chalk.green(`  VLANs Added (+): ${diff.addedVlans.join(', ')}`));
        }
        if (diff.removedVlans.length > 0) {
            lines.push(chalk.red(`  VLANs Removed (-): ${diff.removedVlans.join(', ')}`));
        }

        if (lines.length === 0) {
            return '  No configuration differences detected.';
        }

        return lines.join('\n');
    }
}
