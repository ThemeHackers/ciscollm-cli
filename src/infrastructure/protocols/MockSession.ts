import { BaseSession } from './BaseSession';
import { CiscoDeviceMode } from '../../shared/types';

interface InterfaceConfig {
    ip: string | null;
    subnet: string | null;
    shutdown: boolean;
    description: string | null;
}

export class MockSession extends BaseSession {
    private interfaces: Map<string, InterfaceConfig> = new Map();
    private activeInterface: string | null = null;
    private vlans: Set<number> = new Set([1]);
    private shellEnabled: boolean = false;
    private shellVariables: Map<string, string> = new Map();
    private shellFunctions: Map<string, string> = new Map();

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


        if (lower === 'enable') {
            if (this.state.currentMode === 'USER_EXEC') {
                this.updateMode('PRIVILEGED_EXEC');
                return '';
            }
        }

        if (lower === 'disable') {
            if (this.state.currentMode === 'PRIVILEGED_EXEC') {
                this.updateMode('USER_EXEC');
                return '';
            }
        }

        if (lower === 'configure terminal' || lower === 'conf t') {
            if (this.state.currentMode === 'PRIVILEGED_EXEC') {
                this.updateMode('GLOBAL_CONFIG');
                return 'Enter configuration commands, one per line.  End with CNTL/Z.';
            }
            return '% Command rejected: Place in Privileged EXEC mode first.';
        }

        if (lower.startsWith('interface ') || lower.startsWith('int ')) {
            if (this.state.currentMode === 'GLOBAL_CONFIG' || this.state.currentMode === 'INTERFACE_CONFIG') {
                const parts = clean.split(/\s+/);
                const intName = parts[1];
                
                let resolvedName = intName;
                const lowerName = intName.toLowerCase();
                if (lowerName.startsWith('gi') && !lowerName.startsWith('gigabitethernet')) {
                    resolvedName = 'GigabitEthernet' + intName.substring(2);
                } else if (lowerName.startsWith('fa') && !lowerName.startsWith('fastethernet')) {
                    resolvedName = 'FastEthernet' + intName.substring(2);
                } else if (lowerName.startsWith('lo') && !lowerName.startsWith('loopback')) {
                    resolvedName = 'Loopback' + intName.substring(2);
                } else if (lowerName.startsWith('vl') && !lowerName.startsWith('vlan')) {
                    resolvedName = 'Vlan' + intName.substring(2);
                }

                if (!this.interfaces.has(resolvedName)) {
          
                    if (resolvedName.toLowerCase().startsWith('loopback') || resolvedName.toLowerCase().startsWith('vlan')) {
                        this.interfaces.set(resolvedName, { ip: null, subnet: null, shutdown: false, description: null });
                    } else {
                        return `% Bad interface parameter: ${intName}`;
                    }
                }

                this.activeInterface = resolvedName;
                this.updateMode('INTERFACE_CONFIG');
                return '';
            }
            return '% Invalid input detected at \'^\' marker.';
        }

        if (lower.startsWith('vlan ')) {
            if (this.state.currentMode === 'GLOBAL_CONFIG') {
                const vlanId = parseInt(clean.split(/\s+/)[1], 10);
                if (isNaN(vlanId)) {
                    return '% Invalid VLAN ID format.';
                }
                this.vlans.add(vlanId);
                return '';
            }
            return '% Invalid input detected at \'^\' marker.';
        }

        if (lower === 'exit') {
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

        if (lower === 'end') {
            if (this.state.currentMode === 'GLOBAL_CONFIG' || this.state.currentMode === 'INTERFACE_CONFIG') {
                this.activeInterface = null;
                this.updateMode('PRIVILEGED_EXEC');
                return '';
            }
            return '% Invalid input detected.';
        }

      
        if (lower.startsWith('ip address ') || lower.startsWith('ip add ')) {
            if (this.state.currentMode === 'INTERFACE_CONFIG' && this.activeInterface) {
                const parts = clean.split(/\s+/);
                const ip = parts[2];
                const subnet = parts[3];
                if (!ip || !subnet) {
                    return '% Incomplete command.';
                }
                const intf = this.interfaces.get(this.activeInterface)!;
                intf.ip = ip;
                intf.subnet = subnet;
                return '';
            }
            return '% Invalid input detected at \'^\' marker.';
        }

        if (lower === 'no ip address' || lower === 'no ip add') {
            if (this.state.currentMode === 'INTERFACE_CONFIG' && this.activeInterface) {
                const intf = this.interfaces.get(this.activeInterface)!;
                intf.ip = null;
                intf.subnet = null;
                return '';
            }
            return '% Invalid input detected at \'^\' marker.';
        }

        if (lower === 'shutdown') {
            if (this.state.currentMode === 'INTERFACE_CONFIG' && this.activeInterface) {
                const intf = this.interfaces.get(this.activeInterface)!;
                intf.shutdown = true;
                return '';
            }
            return '% Invalid input detected.';
        }

        if (lower === 'no shutdown') {
            if (this.state.currentMode === 'INTERFACE_CONFIG' && this.activeInterface) {
                const intf = this.interfaces.get(this.activeInterface)!;
                intf.shutdown = false;
                return '';
            }
            return '% Invalid input detected.';
        }

        if (lower.startsWith('description ')) {
            if (this.state.currentMode === 'INTERFACE_CONFIG' && this.activeInterface) {
                const desc = clean.substring(12);
                const intf = this.interfaces.get(this.activeInterface)!;
                intf.description = desc;
                return '';
            }
            return '% Invalid input detected.';
        }

        if (lower === 'no description') {
            if (this.state.currentMode === 'INTERFACE_CONFIG' && this.activeInterface) {
                const intf = this.interfaces.get(this.activeInterface)!;
                intf.description = null;
                return '';
            }
            return '% Invalid input detected.';
        }

       
        if (lower === 'show ip interface brief' || lower === 'sh ip int br') {
            let output = 'Interface                  IP-Address      OK? Method Status                Protocol\n';
            for (const [name, config] of this.interfaces.entries()) {
                const ip = config.ip || 'unassigned';
                const status = config.shutdown ? 'administratively down' : 'up';
                const proto = config.shutdown ? 'down' : 'up';
                output += `${name.padEnd(26)} ${ip.padEnd(15)} YES manual ${status.padEnd(21)} ${proto}\n`;
            }
            return output;
        }

        if (lower === 'show running-config' || lower === 'show run' || lower === 'sh run') {
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

        if (lower.startsWith('ping ')) {
            const dest = clean.split(/\s+/)[1];
            if (!dest) return '% Incomplete command.';

        
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
}
