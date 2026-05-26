import { BaseSession } from './BaseSession';
import { CiscoDeviceMode } from '../../shared/types';

interface InterfaceConfig {
    ip: string | null;
    subnet: string | null;
    shutdown: boolean;
    description: string | null;
}

type CommandTokenPattern = string[];

export class MockSession extends BaseSession {
    private interfaces: Map<string, InterfaceConfig> = new Map();
    private activeInterface: string | null = null;
    private vlans: Set<number> = new Set([1]);
    private shellEnabled: boolean = false;
    private shellVariables: Map<string, string> = new Map();
    private shellFunctions: Map<string, string> = new Map();
    private readonly commandPatterns: Array<{ pattern: CommandTokenPattern; action: (command: string, lower: string) => string | null }>;

    constructor(private deviceId: string = 'Switch') {
        super();
        this.state = {
            currentMode: 'USER_EXEC',
            hostname: this.deviceId,
            prompt: `${this.deviceId}>`
        };

   
        this.interfaces.set('GigabitEthernet0/0', { ip: '192.168.1.254', subnet: '255.255.255.0', shutdown: false, description: 'Management Uplink' });
        this.interfaces.set('GigabitEthernet0/1', { ip: null, subnet: null, shutdown: true, description: null });
        this.interfaces.set('GigabitEthernet0/2', { ip: null, subnet: null, shutdown: true, description: null });

        this.commandPatterns = [
            { pattern: ['configure', 'terminal'], action: () => this.transitionToGlobalConfig('Enter configuration commands, one per line.  End with CNTL/Z.') },
            { pattern: ['conf', 't'], action: () => this.transitionToGlobalConfig('Enter configuration commands, one per line.  End with CNTL/Z.') },
            { pattern: ['enable'], action: () => this.transitionToPrivilegedExec() },
            { pattern: ['disable'], action: () => this.transitionToUserExec() },
            { pattern: ['terminal', 'shell'], action: () => this.toggleShell(true) },
            { pattern: ['shell', 'processing', 'full'], action: () => this.requireGlobalConfigAndToggleShell(true) },
            { pattern: ['no', 'shell', 'processing'], action: () => this.requireGlobalConfigAndToggleShell(false) },
            { pattern: ['interface'], action: (command) => this.handleInterfaceCommand(command) },
            { pattern: ['vlan'], action: (command) => this.handleVlanCommand(command) },
            { pattern: ['exit'], action: () => this.handleExitCommand() },
            { pattern: ['end'], action: () => this.handleEndCommand() },
            { pattern: ['ip', 'address'], action: (command) => this.handleIpAddressCommand(command) },
            { pattern: ['no', 'ip', 'address'], action: (command) => this.handleNoIpAddressCommand(command) },
            { pattern: ['shutdown'], action: () => this.handleShutdownCommand() },
            { pattern: ['no', 'shutdown'], action: () => this.handleNoShutdownCommand() },
            { pattern: ['description'], action: (command) => this.handleDescriptionCommand(command) },
            { pattern: ['no', 'description'], action: () => this.handleNoDescriptionCommand() },
            { pattern: ['show', 'ip', 'interface', 'brief'], action: () => this.handleShowIpInterfaceBrief() },
            { pattern: ['show', 'running-config'], action: () => this.handleShowRunningConfig() },
            { pattern: ['show', 'run'], action: () => this.handleShowRunningConfig() },
            { pattern: ['show', 'ip', 'route'], action: () => this.formatInvalidInput('show ip route', 0) },
            { pattern: ['show', 'vlan', 'brief'], action: () => this.handleShowVlanBrief() },
            { pattern: ['show', 'interfaces'], action: () => this.formatInvalidInput('show interfaces', 0) },
            { pattern: ['show', 'interfaces', 'status'], action: () => this.formatInvalidInput('show interfaces status', 0) },
            { pattern: ['show', 'interfaces', 'brief'], action: () => this.formatInvalidInput('show interfaces brief', 0) }
        ];
    }

    public override isShellEnabled(): boolean {
        return this.shellEnabled;
    }

    public async connect(): Promise<void> {
        console.log(`[MockSession - ${this.deviceId}]: Simulated session established.`);
        return Promise.resolve();
    }

    public async execute(command: string, timeoutMs?: number): Promise<string> {
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
            clean = clean.replace(/\$(\w+|\{\w+\})/g, (match, name) => {
                const cleanName = name.startsWith('{') ? name.slice(1, -1) : name;
                return this.shellVariables.get(cleanName) || '';
            });
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

            let pingSuccess = false;
            if (dest === '127.0.0.1' || dest === '8.8.8.8' || dest === '192.168.1.254') {
                pingSuccess = true;
            } else {
                for (const config of this.interfaces.values()) {
                    if (config.ip === dest && !config.shutdown) {
                        pingSuccess = true;
                        break;
                    }
                }
            }

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
        console.log(`[MockSession - ${this.deviceId}]: Session disconnected.`);
        return Promise.resolve();
    }

    private updateMode(mode: CiscoDeviceMode): void {
        this.state.currentMode = mode;
        let suffix = '>';
        if (mode === 'PRIVILEGED_EXEC') suffix = '#';
        else if (mode === 'GLOBAL_CONFIG') suffix = '(config)#';
        else if (mode === 'INTERFACE_CONFIG') suffix = `(config-if)#`;
        
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
        if (this.state.currentMode !== 'GLOBAL_CONFIG' && this.state.currentMode !== 'INTERFACE_CONFIG') {
            return this.formatInvalidInput(command, 0);
        }

        const parts = command.trim().split(/\s+/);
        if (parts.length < 2) {
            return this.formatIncompleteCommand(command);
        }

        const intName = parts[1];
        const resolvedName = this.resolveInterfaceName(intName);
        if (!resolvedName) {
            return this.formatBadInterfaceParameter(command, intName);
        }

        if (!this.interfaces.has(resolvedName)) {
            if (resolvedName.toLowerCase().startsWith('loopback') || resolvedName.toLowerCase().startsWith('vlan')) {
                this.interfaces.set(resolvedName, { ip: null, subnet: null, shutdown: false, description: null });
            } else {
                return this.formatBadInterfaceParameter(command, intName);
            }
        }

        this.activeInterface = resolvedName;
        this.updateMode('INTERFACE_CONFIG');
        return '';
    }

    private handleVlanCommand(command: string): string {
        if (this.state.currentMode !== 'GLOBAL_CONFIG') {
            return this.formatInvalidInput(command, 0);
        }

        const parts = command.trim().split(/\s+/);
        const vlanId = parseInt(parts[1], 10);
        if (isNaN(vlanId)) {
            return `${command}\n${' '.repeat(command.indexOf(parts[1] || ''))}^\n% Invalid VLAN ID format.`;
        }
        this.vlans.add(vlanId);
        return '';
    }

    private handleExitCommand(): string {
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
        if (this.state.currentMode === 'GLOBAL_CONFIG' || this.state.currentMode === 'INTERFACE_CONFIG') {
            this.activeInterface = null;
            this.updateMode('PRIVILEGED_EXEC');
            return '';
        }
        return '% Invalid input detected.';
    }

    private handleIpAddressCommand(command: string): string {
        if (this.state.currentMode === 'INTERFACE_CONFIG' && this.activeInterface) {
            const parts = command.trim().split(/\s+/);
            const ip = parts[2];
            const subnet = parts[3];
            if (!ip || !subnet) {
                return this.formatIncompleteCommand(command);
            }
            const intf = this.interfaces.get(this.activeInterface)!;
            intf.ip = ip;
            intf.subnet = subnet;
            return '';
        }
        return this.formatInvalidInput(command, 0);
    }

    private handleNoIpAddressCommand(command: string): string {
        if (this.state.currentMode === 'INTERFACE_CONFIG' && this.activeInterface) {
            const intf = this.interfaces.get(this.activeInterface)!;
            intf.ip = null;
            intf.subnet = null;
            return '';
        }
        return this.formatInvalidInput(command, 0);
    }

    private handleShutdownCommand(): string {
        if (this.state.currentMode === 'INTERFACE_CONFIG' && this.activeInterface) {
            const intf = this.interfaces.get(this.activeInterface)!;
            intf.shutdown = true;
            return '';
        }
        return this.formatInvalidInput('shutdown', 0);
    }

    private handleNoShutdownCommand(): string {
        if (this.state.currentMode === 'INTERFACE_CONFIG' && this.activeInterface) {
            const intf = this.interfaces.get(this.activeInterface)!;
            intf.shutdown = false;
            return '';
        }
        return this.formatInvalidInput('no shutdown', 0);
    }

    private handleDescriptionCommand(command: string): string {
        if (this.state.currentMode === 'INTERFACE_CONFIG' && this.activeInterface) {
            const desc = command.trim().substring(command.trim().indexOf(' ') + 1).trim();
            const intf = this.interfaces.get(this.activeInterface)!;
            intf.description = desc;
            return '';
        }
        return this.formatInvalidInput(command, 0);
    }

    private handleNoDescriptionCommand(): string {
        if (this.state.currentMode === 'INTERFACE_CONFIG' && this.activeInterface) {
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
            const status = config.shutdown ? 'administratively down' : 'up';
            const proto = config.shutdown ? 'down' : 'up';
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
            if (config.shutdown) output += '\n shutdown';
            output += '\n!';
        }
        return output;
    }

    private handleShowVlanBrief(): string {
        let output = 'VLAN Name                             Status    Ports\n';
        for (const vlanId of this.vlans.values()) {
            output += `${String(vlanId).padEnd(5)} default                          active    \n`;
        }
        return output;
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
}
