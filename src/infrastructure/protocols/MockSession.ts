import { BaseSession } from './BaseSession';
import { CiscoDeviceMode } from '../../shared/types';
import * as fs from 'fs';
import * as path from 'path';
import chalk from 'chalk';

interface InterfaceConfig {
    ip: string | null;
    subnet: string | null;
    adminShutdown: boolean;
    lineProtocolUp: boolean;
    description: string | null;
}

type CommandTokenPattern = string[];

interface RoutingEntry {
    network: string;
    mask: string;
    nextHop: string | null;
    outgoingInterface: string | null;
    connected: boolean;
}

interface MockSnapshot {
    state: ReturnType<BaseSession['getState']>;
    interfaces: Map<string, InterfaceConfig>;
    activeInterface: string | null;
    vlans: Set<number>;
    shellEnabled: boolean;
    shellVariables: Map<string, string>;
    shellFunctions: Map<string, string>;
    routes: RoutingEntry[];
    activeVlan: number | null;
    vlanNames: Map<number, string>;
}

export class MockSession extends BaseSession {
    private interfaces: Map<string, InterfaceConfig> = new Map();
    private activeInterface: string | null = null;
    private vlans: Set<number> = new Set([1]);
    private shellEnabled: boolean = false;
    private shellVariables: Map<string, string> = new Map();
    private shellFunctions: Map<string, string> = new Map();
    private routes: RoutingEntry[] = [];
    private activeVlan: number | null = null;
    private vlanNames: Map<number, string> = new Map();
    private backupSnapshot: MockSnapshot | null = null;
    private rollbackSnapshots: MockSnapshot[] = [];
    private readonly commandPatterns: Array<{ pattern: CommandTokenPattern; action: (command: string, lower: string) => string | null }>;

    private getStateFilePath(): string {
        return path.resolve(process.cwd(), `.mock-state-${this.deviceId.toLowerCase().replace(/[^a-z0-9]/g, '_')}.json`);
    }

    private saveState(): void {
        if (process.env.NODE_ENV === 'test') return;
        try {
            const data = {
                interfaces: Array.from(this.interfaces.entries()),
                vlans: Array.from(this.vlans),
                shellVariables: Array.from(this.shellVariables.entries()),
                shellFunctions: Array.from(this.shellFunctions.entries()),
                routes: this.routes,
                state: this.state,
                activeInterface: this.activeInterface,
                activeVlan: this.activeVlan,
                vlanNames: Array.from(this.vlanNames.entries())
            };
            fs.writeFileSync(this.getStateFilePath(), JSON.stringify(data, null, 2), 'utf8');
        } catch (e) {
          
        }
    }

    private loadState(): void {
        if (process.env.NODE_ENV === 'test') return;
        try {
            const filePath = this.getStateFilePath();
            if (fs.existsSync(filePath)) {
                const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
                this.interfaces = new Map(data.interfaces);
                this.vlans = new Set(data.vlans);
                this.shellVariables = new Map(data.shellVariables);
                this.shellFunctions = new Map(data.shellFunctions);
                this.routes = data.routes;
                this.state = data.state;
                this.activeInterface = data.activeInterface;
                this.activeVlan = data.activeVlan || null;
                this.vlanNames = new Map(data.vlanNames || []);
            }
        } catch (e) {
           
        }
    }

    constructor(private deviceId: string = 'Switch') {
        super();
        this.state = {
            currentMode: 'USER_EXEC',
            hostname: this.deviceId,
            prompt: `${this.deviceId}>`
        };

   
        this.interfaces.set('GigabitEthernet0/0', {
            ip: '192.168.1.254',
            subnet: '255.255.255.0',
            adminShutdown: false,
            lineProtocolUp: true,
            description: 'Management Uplink'
        });
        this.interfaces.set('GigabitEthernet0/1', {
            ip: null,
            subnet: null,
            adminShutdown: true,
            lineProtocolUp: false,
            description: null
        });
        this.interfaces.set('GigabitEthernet0/2', {
            ip: null,
            subnet: null,
            adminShutdown: true,
            lineProtocolUp: false,
            description: null
        });
        this.refreshConnectedRoutes();
        this.loadState();

        this.commandPatterns = [
            { pattern: ['configure', 'terminal'], action: () => this.transitionToGlobalConfig('Enter configuration commands, one per line.  End with CNTL/Z.') },
            { pattern: ['conf', 't'], action: () => this.transitionToGlobalConfig('Enter configuration commands, one per line.  End with CNTL/Z.') },
            { pattern: ['enable'], action: () => this.transitionToPrivilegedExec() },
            { pattern: ['disable'], action: () => this.transitionToUserExec() },
            { pattern: ['terminal', 'shell'], action: () => this.toggleShell(true) },
            { pattern: ['shell', 'processing', 'full'], action: () => this.requireGlobalConfigAndToggleShell(true) },
            { pattern: ['no', 'shell', 'processing'], action: () => this.requireGlobalConfigAndToggleShell(false) },
            { pattern: ['copy', 'running-config'], action: (command) => this.handleCopyRunningConfig(command) },
            { pattern: ['configure', 'replace'], action: (command) => this.handleConfigureReplace(command) },
            { pattern: ['interface'], action: (command) => this.handleInterfaceCommand(command) },
            { pattern: ['vlan'], action: (command) => this.handleVlanCommand(command) },
            { pattern: ['name'], action: (command) => this.handleVlanNameCommand(command) },
            { pattern: ['switchport'], action: () => '' },
            { pattern: ['exit'], action: () => this.handleExitCommand() },
            { pattern: ['end'], action: () => this.handleEndCommand() },
            { pattern: ['ip', 'address'], action: (command) => this.handleIpAddressCommand(command) },
            { pattern: ['no', 'ip', 'address'], action: (command) => this.handleNoIpAddressCommand(command) },
            { pattern: ['ip', 'route'], action: (command) => this.handleIpRouteCommand(command) },
            { pattern: ['shutdown'], action: () => this.handleShutdownCommand() },
            { pattern: ['no', 'shutdown'], action: () => this.handleNoShutdownCommand() },
            { pattern: ['description'], action: (command) => this.handleDescriptionCommand(command) },
            { pattern: ['no', 'description'], action: () => this.handleNoDescriptionCommand() },
            { pattern: ['show', 'ip', 'interface', 'brief'], action: () => this.handleShowIpInterfaceBrief() },
            { pattern: ['show', 'running-config'], action: () => this.handleShowRunningConfig() },
            { pattern: ['show', 'run'], action: () => this.handleShowRunningConfig() },
            { pattern: ['show', 'ip', 'route'], action: () => this.handleShowIpRoute() },
            { pattern: ['show', 'vlan', 'brief'], action: () => this.handleShowVlanBrief() },
            { pattern: ['show', 'interfaces'], action: () => this.handleShowInterfaces() },
            { pattern: ['show', 'interfaces', 'status'], action: () => this.handleShowInterfacesStatus() },
            { pattern: ['show', 'interfaces', 'brief'], action: () => this.handleShowInterfacesStatus() },
            { pattern: ['dir', 'flash:'], action: () => this.handleDirFlash() },
            { pattern: ['dir'], action: () => this.handleDirFlash() },
            { pattern: ['router', 'ospf'], action: (command) => this.handleRouterOspf(command) },
            { pattern: ['network'], action: () => '' },
            { pattern: ['ip', 'ospf'], action: () => '' },
            { pattern: ['ip', 'dhcp', 'pool'], action: (command) => this.handleIpDhcpPool(command) },
            { pattern: ['ip', 'pool'], action: (command) => this.handleIpDhcpPool(command) },
            { pattern: ['default-router'], action: () => '' },
            { pattern: ['dns-server'], action: () => '' },
            { pattern: ['ip', 'dhcp', 'excluded-address'], action: () => '' },
            { pattern: ['access-list'], action: () => '' },
            { pattern: ['ip', 'access-list'], action: (command) => this.handleIpAccessList(command) },
            { pattern: ['ip', 'access-group'], action: () => '' },
            { pattern: ['permit'], action: () => '' },
            { pattern: ['deny'], action: () => '' },
            { pattern: ['ip', 'nat', 'inside', 'source'], action: () => '' },
            { pattern: ['ip', 'nat', 'inside'], action: () => '' },
            { pattern: ['ip', 'nat', 'outside'], action: () => '' }
        ];
    }

    public override isShellEnabled(): boolean {
        return this.shellEnabled;
    }

    public async connect(): Promise<void> {
        console.log(chalk.green(`✔ Simulated device session for "${this.deviceId}" established.`));
        return Promise.resolve();
    }

    public async execute(command: string, timeoutMs?: number): Promise<string> {
        const result = await this.executeInternal(command, timeoutMs);
        this.saveState();
        return result;
    }

    public async executeInternal(command: string, timeoutMs?: number): Promise<string> {
        let clean = command.trim();
        let lower = clean.toLowerCase();

        if (this.shellEnabled) {
            const assignMatch = clean.match(/^([a-zA-Z_]\w*)=(.*)$/);
            if (assignMatch) {
                const varName = assignMatch[1];
                const varValue = assignMatch[2].trim();
                this.shellVariables.set(varName, varValue);
                return '';
            }
        }

        if (this.shellEnabled) {
            const funcMatch = clean.match(/^(\w+)\(\)\s*\{\s*(.+);\s*\}$/);
            if (funcMatch) {
                const funcName = funcMatch[1];
                const funcBody = funcMatch[2].trim();
                this.shellFunctions.set(funcName, funcBody);
                return '';
            }
        }

        if (this.shellEnabled) {
            const forMatch = clean.match(/^for\s+(\w+)\s+in\s+([^;]+);\s*do\s+([^;]+);\s*done$/i);
            if (forMatch) {
                const varName = forMatch[1];
                const itemsStr = forMatch[2];
                const loopBody = forMatch[3].trim();
                const items = itemsStr.trim().split(/\s+/);
                
                let outputs = [];
                for (const item of items) {
                    this.shellVariables.set(varName, item);
                    const out = await this.execute(loopBody, timeoutMs);
                    if (out) {
                        outputs.push(out);
                    }
                }
                return outputs.join('\n');
            }
        }

        if (this.shellEnabled) {
            clean = this.substituteShellVariables(clean);
            lower = clean.toLowerCase();
        }

        let baseCommand = clean;
        let pipeParts: string[] = [];
        if (clean.includes('|')) {
            pipeParts = clean.split('|').map(p => p.trim());
            baseCommand = pipeParts[0];
        }

        let baseOutput = await this.executeBase(baseCommand, timeoutMs);

        if (pipeParts.length > 1) {
            let finalOutput = baseOutput;
            for (let i = 1; i < pipeParts.length; i++) {
                const filterExpr = pipeParts[i];
                const filterLower = filterExpr.toLowerCase();
                const lines = finalOutput.split(/\r?\n/);
                
                if (filterLower.startsWith('include ') || filterLower.startsWith('grep ')) {
                    const pattern = filterExpr.substring(filterExpr.indexOf(' ') + 1).trim().toLowerCase();
                    finalOutput = lines.filter(line => line.toLowerCase().includes(pattern)).join('\n');
                } else if (filterLower.startsWith('exclude ')) {
                    const pattern = filterExpr.substring(filterExpr.indexOf(' ') + 1).trim().toLowerCase();
                    finalOutput = lines.filter(line => !line.toLowerCase().includes(pattern)).join('\n');
                } else if (filterLower.startsWith('begin ')) {
                    const pattern = filterExpr.substring(filterExpr.indexOf(' ') + 1).trim().toLowerCase();
                    const idx = lines.findIndex(line => line.toLowerCase().includes(pattern));
                    if (idx !== -1) {
                        finalOutput = lines.slice(idx).join('\n');
                    } else {
                        finalOutput = '';
                    }
                }
            }
            return finalOutput;
        }

        return baseOutput;
    }

    public async executeBase(command: string, timeoutMs?: number): Promise<string> {
        const clean = command.trim();
        const lower = clean.toLowerCase();

        if (lower === 'terminal shell') {
            if (this.state.currentMode === 'PRIVILEGED_EXEC') {
                this.shellEnabled = true;
                return '';
            }
            return '% Command rejected: Place in Privileged EXEC mode first.';
        }

        if (lower === 'shell processing full') {
            if (this.state.currentMode === 'GLOBAL_CONFIG') {
                this.shellEnabled = true;
                return '';
            }
            return '% Command rejected: Place in Global Config mode first.';
        }

        if (lower === 'no shell processing') {
            if (this.state.currentMode === 'GLOBAL_CONFIG') {
                this.shellEnabled = false;
                return '';
            }
            return '% Command rejected: Place in Global Config mode first.';
        }

        if (lower.startsWith('echo ')) {
            return clean.substring(5).trim();
        }

        if (lower === 'show shell environment' || lower === 'sh shell env') {
            let output = 'Shell Variables:\n';
            for (const [key, val] of this.shellVariables.entries()) {
                output += `${key}=${val}\n`;
            }
            return output.trim();
        }

        if (lower === 'show shell functions' || lower === 'sh shell func') {
            let output = 'Shell Functions:\n';
            for (const [key, val] of this.shellFunctions.entries()) {
                output += `${key}() { ${val}; }\n`;
            }
            return output.trim();
        }

        if (this.shellEnabled && this.shellFunctions.has(lower)) {
            const body = this.shellFunctions.get(lower)!;
            return this.execute(body, timeoutMs);
        }

        await this.simulateLatency(clean, timeoutMs);

        const parsed = this.matchCommand(clean);
        if (parsed) {
            const handled = parsed.action(clean, lower);
            if (handled !== null) {
                return handled;
            }
        }

        if (lower.startsWith('show ')) {
            return this.formatInvalidInput(clean, this.findInvalidTokenIndex(clean));
        }

        if (lower.startsWith('ip ')) {
            return this.formatInvalidInput(clean, this.findInvalidTokenIndex(clean));
        }

        if (lower.startsWith('no ')) {
            return this.formatInvalidInput(clean, this.findInvalidTokenIndex(clean));
        }

        if (lower.startsWith('ping ')) {
            const dest = clean.split(/\s+/)[1];
            if (!dest) return this.formatIncompleteCommand(clean);

            const pingSuccess = this.isDestinationReachable(dest);

            let output = `Type escape sequence to abort.\nSending 5, 100-byte ICMP Echos to ${dest}, timeout is 2 seconds:\n`;
            if (pingSuccess) {
                output += `!!!!!\nSuccess rate is 100 percent (5/5), round-trip min/avg/max = 1/3/12 ms`;
            } else {
                output += `.....\nSuccess rate is 0 percent (0/5)`;
            }
            return output;
        }

        return `% Unrecognized command: "${clean}"`;
    }

    public async disconnect(): Promise<void> {
        console.log(chalk.gray(`❯ Simulated session for "${this.deviceId}" disconnected.`));
        return Promise.resolve();
    }

    private updateMode(mode: CiscoDeviceMode): void {
        this.state.currentMode = mode;
        let suffix = '>';
        if (mode === 'PRIVILEGED_EXEC') suffix = '#';
        else if (mode === 'GLOBAL_CONFIG') suffix = '(config)#';
        else if (mode === 'INTERFACE_CONFIG') suffix = `(config-if)#`;
        else if (mode === 'VLAN_CONFIG') suffix = `(config-vlan)#`;
        
        this.state.prompt = `${this.state.hostname}${suffix}`;
    }

    private matchCommand(command: string): { action: (command: string, lower: string) => string | null } | null {
        const tokens = command.trim().split(/\s+/).filter(Boolean);
        for (const entry of this.commandPatterns) {
            if (this.matchesPattern(tokens, entry.pattern)) {
                return { action: entry.action };
            }
        }
        return null;
    }

    private matchesPattern(inputTokens: string[], pattern: CommandTokenPattern): boolean {
        if (inputTokens.length < pattern.length) {
            return false;
        }

        for (let i = 0; i < pattern.length; i++) {
            const inputToken = inputTokens[i].toLowerCase();
            const expected = pattern[i].toLowerCase();
            if (!expected.startsWith(inputToken)) {
                return false;
            }
        }

        return true;
    }

    private isConfigMode(): boolean {
        return this.state.currentMode !== 'USER_EXEC' && this.state.currentMode !== 'PRIVILEGED_EXEC';
    }

    private formatInvalidInput(command: string, caretIndex: number): string {
        const safeIndex = Math.max(0, Math.min(caretIndex, command.length));
        const caretLine = `${' '.repeat(safeIndex)}^`;
        return `${command}\n${caretLine}\n% Invalid input detected at '^' marker.`;
    }

    private formatIncompleteCommand(command: string): string {
        return `${command}\n% Incomplete command.`;
    }

    private findInvalidTokenIndex(command: string): number {
        const tokens = command.trim().split(/\s+/).filter(Boolean);
        if (tokens.length === 0) {
            return 0;
        }

        const lower = tokens.map(t => t.toLowerCase());
        const knownStartTokens = new Set(['enable', 'disable', 'configure', 'conf', 'terminal', 'shell', 'interface', 'int', 'vlan', 'exit', 'end', 'ip', 'no', 'shutdown', 'description', 'show', 'ping']);

        for (let i = 0; i < lower.length; i++) {
            if (!knownStartTokens.has(lower[i])) {
                return command.toLowerCase().indexOf(tokens[i].toLowerCase());
            }
        }

        return command.length;
    }

    private transitionToGlobalConfig(message: string): string {
        if (this.state.currentMode === 'PRIVILEGED_EXEC') {
            this.updateMode('GLOBAL_CONFIG');
            return message;
        }
        return '% Command rejected: Place in Privileged EXEC mode first.';
    }

    private transitionToPrivilegedExec(): string {
        if (this.state.currentMode === 'USER_EXEC') {
            this.updateMode('PRIVILEGED_EXEC');
            return '';
        }
        return '';
    }

    private transitionToUserExec(): string {
        if (this.state.currentMode === 'PRIVILEGED_EXEC') {
            this.updateMode('USER_EXEC');
            return '';
        }
        return '';
    }

    private toggleShell(enabled: boolean): string {
        if (enabled) {
            if (this.state.currentMode === 'PRIVILEGED_EXEC') {
                this.shellEnabled = true;
                return '';
            }
            return '% Command rejected: Place in Privileged EXEC mode first.';
        }

        if (this.state.currentMode === 'GLOBAL_CONFIG') {
            this.shellEnabled = false;
            return '';
        }
        return '% Command rejected: Place in Global Config mode first.';
    }

    private requireGlobalConfigAndToggleShell(enabled: boolean): string {
        if (this.state.currentMode === 'GLOBAL_CONFIG') {
            this.shellEnabled = enabled;
            return '';
        }
        return '% Command rejected: Place in Global Config mode first.';
    }

    private handleInterfaceCommand(command: string): string {
        if (!this.isConfigMode()) {
            return this.formatInvalidInput(command, 0);
        }

        const parts = command.trim().split(/\s+/);
        if (parts.length < 2) {
            return this.formatIncompleteCommand(command);
        }

        const intName = parts.slice(1).join('');
        const resolvedName = this.resolveInterfaceName(intName);
        if (!resolvedName) {
            return this.formatBadInterfaceParameter(command, parts[1]);
        }

        if (!this.interfaces.has(resolvedName)) {
            if (resolvedName.toLowerCase().startsWith('loopback') || resolvedName.toLowerCase().startsWith('vlan')) {
                this.interfaces.set(resolvedName, {
                    ip: null,
                    subnet: null,
                    adminShutdown: false,
                    lineProtocolUp: true,
                    description: null
                });
            } else {
                return this.formatBadInterfaceParameter(command, parts[1]);
            }
        }

        this.activeInterface = resolvedName;
        this.activeVlan = null;
        this.updateMode('INTERFACE_CONFIG');
        return '';
    }

    private handleVlanCommand(command: string): string {
        if (!this.isConfigMode()) {
            return this.formatInvalidInput(command, 0);
        }

        const parts = command.trim().split(/\s+/);
        if (parts.length > 2) {
            return this.formatInvalidInput(command, command.indexOf(parts[2]));
        }

        const vlanId = parseInt(parts[1], 10);
        if (isNaN(vlanId)) {
            return `${command}\n${' '.repeat(command.indexOf(parts[1] || ''))}^\n% Invalid VLAN ID format.`;
        }
        this.vlans.add(vlanId);
        this.activeVlan = vlanId;
        this.activeInterface = null;
        this.updateMode('VLAN_CONFIG');
        return '';
    }

    private handleVlanNameCommand(command: string): string {
        if (this.state.currentMode !== 'VLAN_CONFIG' || this.activeVlan === null) {
            return this.formatInvalidInput(command, 0);
        }

        const parts = command.trim().split(/\s+/);
        if (parts.length < 2) {
            return this.formatIncompleteCommand(command);
        }

        this.pushRollbackSnapshot();
        const vlanName = parts.slice(1).join(' ');
        this.vlanNames.set(this.activeVlan, vlanName);
        return '';
    }

    private handleExitCommand(): string {
        if (this.state.currentMode === 'VLAN_CONFIG') {
            this.activeVlan = null;
            this.updateMode('GLOBAL_CONFIG');
            return '';
        }
        if (this.state.prompt.includes('(') && !this.state.prompt.includes('(config-if)')) {
            this.updateMode('GLOBAL_CONFIG');
            return '';
        }
        if (this.state.currentMode === 'INTERFACE_CONFIG') {
            this.activeInterface = null;
            this.updateMode('GLOBAL_CONFIG');
            return '';
        }
        if (this.state.currentMode === 'GLOBAL_CONFIG') {
            this.updateMode('PRIVILEGED_EXEC');
            return '';
        }
        if (this.state.currentMode === 'PRIVILEGED_EXEC') {
            this.updateMode('USER_EXEC');
            return '';
        }
        return '% Connection closed.';
    }

    private handleEndCommand(): string {
        if (this.state.currentMode === 'GLOBAL_CONFIG' || this.state.currentMode === 'INTERFACE_CONFIG' || this.state.currentMode === 'VLAN_CONFIG' || this.state.prompt.includes(')')) {
            this.activeInterface = null;
            this.activeVlan = null;
            this.updateMode('PRIVILEGED_EXEC');
            return '';
        }
        return '% Invalid input detected.';
    }

    private handleIpAddressCommand(command: string): string {
        if (this.state.currentMode === 'INTERFACE_CONFIG' && this.activeInterface) {
            this.pushRollbackSnapshot();
            const parts = command.trim().split(/\s+/);
            const ip = parts[2];
            const subnet = parts[3];
            if (!ip || !subnet) {
                return this.formatIncompleteCommand(command);
            }
            const intf = this.interfaces.get(this.activeInterface)!;
            intf.ip = ip;
            intf.subnet = subnet;
            intf.lineProtocolUp = !intf.adminShutdown;
            this.refreshConnectedRoutes();
            return '';
        }
        return this.formatInvalidInput(command, 0);
    }

    private handleNoIpAddressCommand(command: string): string {
        if (this.state.currentMode === 'INTERFACE_CONFIG' && this.activeInterface) {
            this.pushRollbackSnapshot();
            const intf = this.interfaces.get(this.activeInterface)!;
            intf.ip = null;
            intf.subnet = null;
            this.refreshConnectedRoutes();
            return '';
        }
        return this.formatInvalidInput(command, 0);
    }

    private handleShutdownCommand(): string {
        if (this.state.currentMode === 'INTERFACE_CONFIG' && this.activeInterface) {
            this.pushRollbackSnapshot();
            const intf = this.interfaces.get(this.activeInterface)!;
            intf.adminShutdown = true;
            intf.lineProtocolUp = false;
            this.refreshConnectedRoutes();
            return '';
        }
        return this.formatInvalidInput('shutdown', 0);
    }

    private handleNoShutdownCommand(): string {
        if (this.state.currentMode === 'INTERFACE_CONFIG' && this.activeInterface) {
            this.pushRollbackSnapshot();
            const intf = this.interfaces.get(this.activeInterface)!;
            intf.adminShutdown = false;
            intf.lineProtocolUp = true;
            this.refreshConnectedRoutes();
            return '';
        }
        return this.formatInvalidInput('no shutdown', 0);
    }

    private handleDescriptionCommand(command: string): string {
        if (this.state.currentMode === 'INTERFACE_CONFIG' && this.activeInterface) {
            this.pushRollbackSnapshot();
            const desc = command.trim().substring(command.trim().indexOf(' ') + 1).trim();
            const intf = this.interfaces.get(this.activeInterface)!;
            intf.description = desc;
            return '';
        }
        return this.formatInvalidInput(command, 0);
    }

    private handleNoDescriptionCommand(): string {
        if (this.state.currentMode === 'INTERFACE_CONFIG' && this.activeInterface) {
            this.pushRollbackSnapshot();
            const intf = this.interfaces.get(this.activeInterface)!;
            intf.description = null;
            return '';
        }
        return this.formatInvalidInput('no description', 0);
    }

    private handleShowIpInterfaceBrief(): string {
        let output = 'Interface                  IP-Address      OK? Method Status                Protocol\n';
        for (const [name, config] of this.interfaces.entries()) {
            const ip = config.ip || 'unassigned';
            const status = config.adminShutdown ? 'administratively down' : 'up';
            const proto = config.lineProtocolUp ? 'up' : 'down';
            output += `${name.padEnd(26)} ${ip.padEnd(15)} YES manual ${status.padEnd(21)} ${proto}\n`;
        }
        return output;
    }

    private handleShowRunningConfig(): string {
        let output = `Building configuration...\n\nCurrent configuration : 1584 bytes\n!\nversion 15.2\nhostname ${this.state.hostname}\n!`;
        for (const [name, config] of this.interfaces.entries()) {
            output += `\ninterface ${name}`;
            if (config.description) output += `\n description ${config.description}`;
            if (config.ip) output += `\n ip address ${config.ip} ${config.subnet}`;
            if (config.adminShutdown) output += '\n shutdown';
            output += '\n!';
        }

        for (const route of this.routes) {
            output += `\nip route ${route.network} ${route.mask} ${route.nextHop || route.outgoingInterface || 'null'}`;
        }
        return output;
    }

    private handleShowVlanBrief(): string {
        let output = 'VLAN Name                             Status    Ports\n';
        for (const vlanId of this.vlans.values()) {
            const name = this.vlanNames.get(vlanId) || (vlanId === 1 ? 'default' : `VLAN${String(vlanId).padStart(4, '0')}`);
            output += `${String(vlanId).padEnd(5)} ${name.padEnd(32)} active    \n`;
        }
        return output;
    }

    private handleShowInterfaces(): string {
        let output = '';
        for (const [name, config] of this.interfaces.entries()) {
            const status = config.adminShutdown ? 'administratively down' : 'up';
            const proto = config.lineProtocolUp ? 'up' : 'down';
            output += `${name} is ${status}, line protocol is ${proto}\n`;
        }
        return output.trim();
    }

    private handleShowInterfacesStatus(): string {
        let output = 'Port      Name               Status       Vlan       Duplex  Speed Type\n';
        for (const [name, config] of this.interfaces.entries()) {
            const status = config.adminShutdown ? 'disabled' : (config.lineProtocolUp ? 'connected' : 'notconnect');
            output += `${name.padEnd(9)} ${ (config.description || '').padEnd(18)} ${status.padEnd(12)} 1          auto    auto  10/100/1000BaseTX\n`;
        }
        return output.trim();
    }

    private handleShowIpRoute(): string {
        let output = 'Codes: C - connected, S - static\n\n';
        for (const route of this.routes) {
            const code = route.connected ? 'C' : 'S';
            const target = route.connected ? route.network : `${route.network} [1/0] via ${route.nextHop || route.outgoingInterface || ''}`;
            output += `${code} ${target}\n`;
        }
        return output.trim();
    }

    private handleCopyRunningConfig(command: string): string {
        if (this.state.currentMode !== 'PRIVILEGED_EXEC') {
            return this.formatInvalidInput(command, 0);
        }

        this.backupSnapshot = this.cloneSnapshot();
        this.pushRollbackSnapshot();
        return 'Copy complete, 1584 bytes copied in 0.000 secs (0 bytes/sec)';
    }

    private handleConfigureReplace(command: string): string {
        if (this.state.currentMode !== 'PRIVILEGED_EXEC') {
            return this.formatInvalidInput(command, 0);
        }

        if (!this.backupSnapshot) {
            return '% No backup configuration available.';
        }

        this.restoreSnapshot(this.backupSnapshot);
        this.clearRollbackSnapshots();
        return 'Configure replace completed successfully.';
    }

    private handleIpRouteCommand(command: string): string {
        if (!this.isConfigMode()) {
            return this.formatInvalidInput(command, 0);
        }

        const parts = command.trim().split(/\s+/);
        if (parts.length < 5) {
            return this.formatIncompleteCommand(command);
        }

        this.pushRollbackSnapshot();
        const [, , network, mask, nextHop] = parts;
        const route: RoutingEntry = {
            network,
            mask,
            nextHop: nextHop || null,
            outgoingInterface: null,
            connected: false
        };
        this.routes.push(route);
        return '';
    }

    private formatBadInterfaceParameter(command: string, intName: string): string {
        const caretIndex = Math.max(0, command.toLowerCase().indexOf(intName.toLowerCase()));
        return `${command}\n${' '.repeat(caretIndex)}^\n% Bad interface parameter: ${intName}`;
    }

    private resolveInterfaceName(intName: string): string | null {
        const lowerName = intName.toLowerCase();

        const aliases = [
            { canonical: 'GigabitEthernet', aliases: ['gigabitethernet', 'gi'] },
            { canonical: 'FastEthernet', aliases: ['fastethernet', 'fa'] },
            { canonical: 'Loopback', aliases: ['loopback', 'lo'] },
            { canonical: 'Vlan', aliases: ['vlan', 'vl'] }
        ];

        for (const entry of aliases) {
            const matchedAlias = entry.aliases.find(alias => lowerName.startsWith(alias));
            if (matchedAlias) {
                return `${entry.canonical}${intName.substring(matchedAlias.length)}`;
            }
        }

        if (this.interfaces.has(intName)) {
            return intName;
        }

        return null;
    }

    public hasSnapshots(): boolean {
        return this.rollbackSnapshots.length > 0;
    }

    public restoreToInitialSnapshot(): boolean {
        const snapshot = this.rollbackSnapshots[0];
        if (!snapshot) {
            return false;
        }

        this.restoreSnapshot(snapshot);
        this.clearRollbackSnapshots();
        return true;
    }

    public restoreBackupSnapshot(): boolean {
        if (!this.backupSnapshot) {
            return false;
        }

        this.restoreSnapshot(this.backupSnapshot);
        this.clearRollbackSnapshots();
        return true;
    }

    private pushRollbackSnapshot(): void {
        this.rollbackSnapshots.push(this.cloneSnapshot());
    }

    private clearRollbackSnapshots(): void {
        this.rollbackSnapshots = [];
    }

    private cloneSnapshot(): MockSnapshot {
        return {
            state: this.getState(),
            interfaces: new Map(Array.from(this.interfaces.entries()).map(([name, config]) => [name, { ...config }])),
            activeInterface: this.activeInterface,
            vlans: new Set(this.vlans),
            shellEnabled: this.shellEnabled,
            shellVariables: new Map(this.shellVariables),
            shellFunctions: new Map(this.shellFunctions),
            routes: this.routes.map(route => ({ ...route })),
            activeVlan: this.activeVlan,
            vlanNames: new Map(this.vlanNames)
        };
    }

    private restoreSnapshot(snapshot: MockSnapshot): void {
        this.state = { ...snapshot.state };
        this.interfaces = new Map(Array.from(snapshot.interfaces.entries()).map(([name, config]) => [name, { ...config }]));
        this.activeInterface = snapshot.activeInterface;
        this.vlans = new Set(snapshot.vlans);
        this.shellEnabled = snapshot.shellEnabled;
        this.shellVariables = new Map(snapshot.shellVariables);
        this.shellFunctions = new Map(snapshot.shellFunctions);
        this.routes = snapshot.routes.map(route => ({ ...route }));
        this.activeVlan = snapshot.activeVlan;
        this.vlanNames = new Map(snapshot.vlanNames);
    }

    private refreshConnectedRoutes(): void {
        const connectedRoutes = new Map<string, RoutingEntry>();

        for (const [name, config] of this.interfaces.entries()) {
            if (config.ip && config.subnet) {
                const network = this.computeNetworkAddress(config.ip, config.subnet);
                const key = `${network}/${config.subnet}`;
                connectedRoutes.set(key, {
                    network,
                    mask: config.subnet,
                    nextHop: null,
                    outgoingInterface: name,
                    connected: true
                });
            }
        }

        const staticRoutes = this.routes.filter(route => !route.connected);
        this.routes = [...connectedRoutes.values(), ...staticRoutes];
    }

    private isDestinationReachable(dest: string): boolean {
        if (dest === '127.0.0.1' || dest === '8.8.8.8') {
            return true;
        }

        for (const [name, config] of this.interfaces.entries()) {
            if (!config.ip || !config.subnet || config.adminShutdown || !config.lineProtocolUp) {
                continue;
            }

            if (config.ip === dest) {
                return true;
            }

            if (this.isInSameSubnet(dest, config.ip, config.subnet)) {
                return true;
            }
        }

        for (const route of this.routes) {
            if (route.connected) {
                continue;
            }
            if (this.ipMatchesRoute(dest, route.network, route.mask)) {
                return true;
            }
        }

        return false;
    }

    private computeNetworkAddress(ip: string, mask: string): string {
        const ipParts = this.ipToIntParts(ip);
        const maskParts = this.ipToIntParts(mask);
        return this.intPartsToIp(ipParts.map((octet, idx) => octet & maskParts[idx]));
    }

    private isInSameSubnet(ip: string, interfaceIp: string, mask: string): boolean {
        return this.computeNetworkAddress(ip, mask) === this.computeNetworkAddress(interfaceIp, mask);
    }

    private ipMatchesRoute(ip: string, network: string, mask: string): boolean {
        return this.computeNetworkAddress(ip, mask) === network;
    }

    private ipToIntParts(ip: string): number[] {
        return ip.split('.').map(part => parseInt(part, 10));
    }

    private intPartsToIp(parts: number[]): string {
        return parts.map(part => Math.max(0, Math.min(255, part))).join('.');
    }

    private async simulateLatency(command: string, timeoutMs?: number): Promise<void> {
        const normalized = command.toLowerCase();
        let delayMs = 0;

        if (normalized.startsWith('copy ')) {
            delayMs = 120;
        } else if (normalized.startsWith('ping ')) {
            delayMs = 45;
        } else if (normalized.startsWith('show ')) {
            delayMs = 20;
        }

        if (timeoutMs && delayMs > timeoutMs) {
            await new Promise(resolve => setTimeout(resolve, timeoutMs));
            return;
        }

        if (delayMs > 0) {
            await new Promise(resolve => setTimeout(resolve, delayMs));
        }
    }

    private substituteShellVariables(command: string): string {
        let output = '';

        for (let index = 0; index < command.length; index++) {
            const char = command[index];
            if (char !== '$') {
                output += char;
                continue;
            }

            const next = command[index + 1];
            if (next === '{') {
                const endBrace = command.indexOf('}', index + 2);
                if (endBrace !== -1) {
                    const name = command.slice(index + 2, endBrace);
                    output += this.shellVariables.get(name) || '';
                    index = endBrace;
                    continue;
                }
            }

            let nameEnd = index + 1;
            while (nameEnd < command.length && /[A-Za-z0-9_]/.test(command[nameEnd])) {
                nameEnd++;
            }

            if (nameEnd > index + 1) {
                const name = command.slice(index + 1, nameEnd);
                output += this.shellVariables.get(name) || '';
                index = nameEnd - 1;
                continue;
            }

            output += '$';
        }

        return output;
    }

    private handleDirFlash(): string {
        return `Directory of flash:/

    1  -rw-     1584  May 27 2026 10:30:00 +00:00  backup-agent.cfg

15728640 bytes total (15727056 bytes free)`;
    }

    private handleRouterOspf(command: string): string {
        if (!this.isConfigMode()) {
            return '% Command rejected: Place in configuration mode first.';
        }
        this.activeInterface = null;
        this.activeVlan = null;
        this.updateMode('GLOBAL_CONFIG');
        this.state.prompt = `${this.state.hostname}(config-router)#`;
        return '';
    }

    private handleIpDhcpPool(command: string): string {
        if (!this.isConfigMode()) {
            return '% Command rejected: Place in configuration mode first.';
        }
        this.activeInterface = null;
        this.activeVlan = null;
        this.updateMode('GLOBAL_CONFIG');
        this.state.prompt = `${this.state.hostname}(dhcp-config)#`;
        return '';
    }

    private handleIpAccessList(command: string): string {
        if (!this.isConfigMode()) {
            return '% Command rejected: Place in configuration mode first.';
        }
        this.activeInterface = null;
        this.activeVlan = null;
        this.updateMode('GLOBAL_CONFIG');
        this.state.prompt = `${this.state.hostname}(config-ext-nacl)#`;
        return '';
    }
}
