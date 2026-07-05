import { BaseDevice } from './BaseDevice';

export interface ASAInterfaceState {
    name: string;
    ip: string | null;
    subnet: string | null;
    securityLevel: number;
    nameif: string | null;
    adminShutdown: boolean;
}

export class ASADevice extends BaseDevice {
    private interfaces: Map<string, ASAInterfaceState> = new Map([
        ['Ethernet0/0', { name: 'Ethernet0/0', ip: null, subnet: null, securityLevel: 0, nameif: null, adminShutdown: false }],
        ['Ethernet0/1', { name: 'Ethernet0/1', ip: null, subnet: null, securityLevel: 0, nameif: null, adminShutdown: false }],
        ['Vlan1', { name: 'Vlan1', ip: '192.168.1.1', subnet: '255.255.255.0', securityLevel: 100, nameif: 'inside', adminShutdown: false }],
        ['Vlan2', { name: 'Vlan2', ip: null, subnet: null, securityLevel: 0, nameif: 'outside', adminShutdown: false }]
    ]);

    private accessLists: Map<string, string[]> = new Map();
    private accessGroups: Map<string, { aclName: string; direction: 'in' | 'out'; interfaceName: string }> = new Map();

    private activeInterface: string | null = null;

    constructor(initialHostname?: string) {
        super(initialHostname || 'ciscoasa', 'asa');
        this.mode = 'USER_EXEC';
    }

    public getPrompt(): string {
        switch (this.mode) {
            case 'USER_EXEC':
                return `${this.hostname}> `;
            case 'PRIVILEGED_EXEC':
                return `${this.hostname}# `;
            case 'GLOBAL_CONFIG':
                return `${this.hostname}(config)# `;
            case 'INTERFACE_CONFIG':
                return `${this.hostname}(config-if)# `;
            default:
                return `${this.hostname}# `;
        }
    }

    public processCommand(cmd: string): string {
        const normalized = cmd.trim();
        if (!normalized) return '';

        const args = normalized.split(/\s+/);
        const command = args[0].toLowerCase();

        if (command === 'exit') {
            if (this.mode === 'INTERFACE_CONFIG') {
                this.mode = 'GLOBAL_CONFIG';
                this.activeInterface = null;
                return '';
            } else if (this.mode === 'GLOBAL_CONFIG') {
                this.mode = 'PRIVILEGED_EXEC';
                return '';
            } else if (this.mode === 'PRIVILEGED_EXEC') {
                this.mode = 'USER_EXEC';
                return '';
            } else {
                return '';
            }
        }

        if (command === 'enable') {
            this.mode = 'PRIVILEGED_EXEC';
            return 'Password: \n';
        }

        if (command === 'disable') {
            this.mode = 'USER_EXEC';
            return '';
        }

        if (command === 'configure' && args[1]?.toLowerCase() === 'terminal') {
            if (this.mode === 'PRIVILEGED_EXEC') {
                this.mode = 'GLOBAL_CONFIG';
                return '';
            }
            return 'Command authorization failed.';
        }

        if (command === 'write' && args[1]?.toLowerCase() === 'memory') {
            if (this.mode !== 'USER_EXEC') {
                return 'Building configuration...\nCryptochecksum: 1a2b3c4d 5e6f7a8b\n\n2531 bytes copied in 1.123 secs\n[OK]';
            }
            return 'Command authorization failed.';
        }

        if (this.mode === 'GLOBAL_CONFIG' && command === 'interface' && args[1]) {
            const ifaceName = this.normalizeInterfaceName(args[1]);
            if (this.interfaces.has(ifaceName)) {
                this.activeInterface = ifaceName;
                this.mode = 'INTERFACE_CONFIG';
                return '';
            } else {
                return `ERROR: Interface ${ifaceName} does not exist.`;
            }
        }

        if (this.mode === 'INTERFACE_CONFIG' && this.activeInterface) {
            const iface = this.interfaces.get(this.activeInterface)!;
            
            if (command === 'nameif' && args[1]) {
                iface.nameif = args[1];
                if (iface.nameif.toLowerCase() === 'inside') {
                    iface.securityLevel = 100;
                    return `INFO: Security level for "inside" set to 100 by default.`;
                } else {
                    iface.securityLevel = 0;
                    return `INFO: Security level for "${iface.nameif}" set to 0 by default.`;
                }
            }
            
            if (command === 'security-level' && args[1]) {
                const level = parseInt(args[1], 10);
                if (!isNaN(level) && level >= 0 && level <= 100) {
                    iface.securityLevel = level;
                    return '';
                }
                return `ERROR: Invalid security level. Must be 0-100.`;
            }

            if (command === 'ip' && args[1] === 'address' && args[2]) {
                iface.ip = args[2];
                iface.subnet = args[3] || '255.255.255.0';
                return '';
            }

            if (command === 'no' && args[1] === 'shutdown') {
                iface.adminShutdown = false;
                return '';
            }
            if (command === 'shutdown') {
                iface.adminShutdown = true;
                return '';
            }

            if (command === 'access-group' && args[1] && (args[2] === 'in' || args[2] === 'out') && args[3] === 'interface' && args[4]) {
                this.accessGroups.set(this.activeInterface, {
                    aclName: args[1],
                    direction: args[2] as 'in' | 'out',
                    interfaceName: this.normalizeInterfaceName(args[4])
                });
                return '';
            }
        }

        if (this.mode === 'GLOBAL_CONFIG') {
            if (command === 'access-list' && args[1] && args[2]) {
                const aclName = args[1];
                const rule = args.slice(2).join(' ');
                if (!this.accessLists.has(aclName)) {
                    this.accessLists.set(aclName, []);
                }
                this.accessLists.get(aclName)!.push(rule);
                return '';
            }

            if (command === 'access-group' && args[1] && (args[2] === 'in' || args[2] === 'out') && args[3] === 'interface' && args[4]) {
                this.accessGroups.set(args[4], {
                    aclName: args[1],
                    direction: args[2] as 'in' | 'out',
                    interfaceName: this.normalizeInterfaceName(args[4])
                });
                return '';
            }
        }

        if (command === 'show' || (command === 'do' && args[1] === 'show')) {
            const showArgs = command === 'do' ? args.slice(2) : args.slice(1);
            if (showArgs[0] === 'interface' && showArgs[1] === 'ip' && showArgs[2] === 'brief') {
                let out = `Interface                  IP-Address      OK? Method Status                Protocol\n`;
                for (const [name, iface] of this.interfaces) {
                    out += `${name.padEnd(26)} ${iface.ip ? iface.ip.padEnd(15) : 'unassigned     '} YES unset  ${iface.adminShutdown ? 'administratively down' : 'up                  '} ${iface.adminShutdown ? 'down' : 'up'}\n`;
                }
                return out;
            }
            
            if (showArgs[0] === 'nameif') {
                let out = `Interface                Name                     Security\n`;
                for (const [name, iface] of this.interfaces) {
                    if (iface.nameif) {
                        out += `${name.padEnd(24)} ${iface.nameif.padEnd(24)} ${iface.securityLevel}\n`;
                    }
                }
                return out;
            }

            if (showArgs[0] === 'access-list' || showArgs[0] === 'access-lists') {
                if (this.accessLists.size === 0) {
                    return 'No access lists configured.\n';
                }

                let out = '';
                for (const [aclName, rules] of this.accessLists.entries()) {
                    out += `access-list ${aclName}\n`;
                    rules.forEach((rule, index) => {
                        out += ` ${index + 1} ${rule}\n`;
                    });
                }

                if (this.accessGroups.size > 0) {
                    out += '\nApplied access-groups:\n';
                    for (const [interfaceName, mapping] of this.accessGroups.entries()) {
                        out += ` ${interfaceName} -> access-group ${mapping.aclName} ${mapping.direction} interface ${mapping.interfaceName}\n`;
                    }
                }

                return out;
            }
        }

        if (command === 'ping' && args[1]) {
            const target = args[1];
            return `Type escape sequence to abort.\nSending 5, 100-byte ICMP Echos to ${target}, timeout is 2 seconds:\n!!!!!\nSuccess rate is 100 percent (5/5), round-trip min/avg/max = 1/2/4 ms`;
        }

        if (command === '?') {
            return `ASA Commands:\n  enable\n  disable\n  configure terminal\n  show interface ip brief\n  show nameif\n  write memory\n  ping <ip>\n  exit`;
        }

        return `ERROR: % Invalid input detected at '^' marker.`;
    }

    private normalizeInterfaceName(name: string): string {
        const lower = name.toLowerCase();
        if (lower.startsWith('e')) return 'Ethernet' + lower.substring(1).replace(/thernet/, '');
        if (lower.startsWith('v')) return 'Vlan' + lower.substring(1).replace(/lan/, '');
        return name;
    }
}
