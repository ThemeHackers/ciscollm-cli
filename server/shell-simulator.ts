import { PROMPT_REGEX } from '../src/shared/constants';

export type CliMode = 'USER_EXEC' | 'PRIVILEGED_EXEC' | 'GLOBAL_CONFIG' | 'INTERFACE_CONFIG' | 'OSPF_CONFIG' | 'DHCP_CONFIG' | 'ACL_CONFIG';

export interface InterfaceState {
    name: string;
    ip: string | null;
    subnet: string | null;
    adminShutdown: boolean;
    lineProtocolUp: boolean;
    description: string | null;
}

export interface RouteState {
    network: string;
    mask: string;
    nextHop: string | null;
    outgoingInterface: string | null;
    connected: boolean;
}

export class ShellSimulator {
    public hostname: string = 'Switch1';
    public mode: CliMode = 'PRIVILEGED_EXEC';
    public activeInterface: string | null = null;
    
    public interfaces: Map<string, InterfaceState> = new Map([
        ['GigabitEthernet0/0', {
            name: 'GigabitEthernet0/0',
            ip: '192.168.1.254',
            subnet: '255.255.255.0',
            adminShutdown: false,
            lineProtocolUp: true,
            description: 'Management Uplink'
        }],
        ['GigabitEthernet0/1', {
            name: 'GigabitEthernet0/1',
            ip: null,
            subnet: null,
            adminShutdown: true,
            lineProtocolUp: false,
            description: null
        }],
        ['GigabitEthernet0/2', {
            name: 'GigabitEthernet0/2',
            ip: null,
            subnet: null,
            adminShutdown: true,
            lineProtocolUp: false,
            description: null
        }]
    ]);

    public vlans: Set<number> = new Set([1]);
    public vlanNames: Map<number, string> = new Map([[1, 'default']]);
    public activeVlan: number | null = null;

    public routes: RouteState[] = [
        {
            network: '192.168.1.0',
            mask: '255.255.255.0',
            nextHop: null,
            outgoingInterface: 'GigabitEthernet0/0',
            connected: true
        }
    ];


    public shellEnabled: boolean = false;
    public shellVariables: Record<string, string> = {};
    public shellFunctions: Record<string, string> = {};

    public ospfEnabled: boolean = false;
    public ospfProcessId: string | null = null;
    public ipRoutingEnabled: boolean = true;
    public flashFiles: Set<string> = new Set(['c2960-lanbasek9-mz.150-2.SE4.bin']);
    private pendingCopyDest: string | null = null;
    private backupState: {
        hostname: string;
        interfaces: Map<string, InterfaceState>;
        routes: RouteState[];
        vlans: Set<number>;
        vlanNames: Map<number, string>;
    } | null = null;

    private saveBackupState(): void {
        const interfacesCopy = new Map<string, InterfaceState>();
        for (const [name, val] of this.interfaces.entries()) {
            interfacesCopy.set(name, { ...val });
        }
        const routesCopy = this.routes.map(r => ({ ...r }));
        const vlansCopy = new Set(this.vlans);
        const vlanNamesCopy = new Map(this.vlanNames);

        this.backupState = {
            hostname: this.hostname,
            interfaces: interfacesCopy,
            routes: routesCopy,
            vlans: vlansCopy,
            vlanNames: vlanNamesCopy
        };
    }

    private restoreBackupState(): void {
        if (!this.backupState) return;
        this.hostname = this.backupState.hostname;
        this.interfaces = this.backupState.interfaces;
        this.routes = this.backupState.routes;
        this.vlans = this.backupState.vlans;
        this.vlanNames = this.backupState.vlanNames;
    }

    constructor(initialHostname?: string) {
        if (initialHostname) {
            this.hostname = initialHostname;
        }
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
            case 'OSPF_CONFIG':
                return `${this.hostname}(config-router)# `;
            case 'DHCP_CONFIG':
                return `${this.hostname}(config-dhcp)# `;
            case 'ACL_CONFIG':
                return `${this.hostname}(config-ext-nacl)# `;
            default:
                return `${this.hostname}# `;
        }
    }

    public execute(line: string): string {
        const trimmed = line.trim();

        if (this.pendingCopyDest) {
            const dest = trimmed || this.pendingCopyDest;
            this.flashFiles.add(dest);
            this.saveBackupState();
            this.pendingCopyDest = null;
            return `1542 bytes copied in 0.456 secs (3381 bytes/sec)\n[OK]`;
        }

        if (!trimmed) return '';


        if (this.shellEnabled) {

            const varMatch = trimmed.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
            if (varMatch) {
                const [, name, val] = varMatch;
                this.shellVariables[name] = val;
                return '';
            }


            const funcMatch = trimmed.match(/^([A-Za-z_][A-Za-z0-9_]*)\(\)\s*{(.*)}$/);
            if (funcMatch) {
                const [, name, body] = funcMatch;
                this.shellFunctions[name] = body.trim();
                return '';
            }
        }

        let commandToExecute = trimmed;
        const tempArgs = commandToExecute.split(/\s+/);
        const tempCmd = tempArgs[0].toLowerCase();

        const isConfigMode = this.mode !== 'USER_EXEC' && this.mode !== 'PRIVILEGED_EXEC';
        if (tempCmd === 'do' && isConfigMode) {
            const doMatch = commandToExecute.match(/^do\s+(.+)$/i);
            if (doMatch) {
                commandToExecute = doMatch[1];
            }
        }

        const args = commandToExecute.split(/\s+/);
        const cmd = args[0].toLowerCase();


        if (cmd === 'exit') {
            if (this.mode === 'INTERFACE_CONFIG' || this.mode === 'OSPF_CONFIG' || this.mode === 'DHCP_CONFIG' || this.mode === 'ACL_CONFIG') {
                this.mode = 'GLOBAL_CONFIG';
                this.activeInterface = null;
                this.activeVlan = null;
                return '';
            } else if (this.mode === 'GLOBAL_CONFIG') {
                this.mode = 'PRIVILEGED_EXEC';
                return '';
            } else if (this.mode === 'PRIVILEGED_EXEC') {
                this.mode = 'USER_EXEC';
                return '';
            } else {
                return 'exit';
            }
        }

        if (cmd === 'end') {
            if (this.mode !== 'USER_EXEC' && this.mode !== 'PRIVILEGED_EXEC') {
                this.mode = 'PRIVILEGED_EXEC';
                this.activeInterface = null;
                this.activeVlan = null;
                return '';
            }
        }


        if (cmd === 'enable') {
            if (this.mode === 'USER_EXEC') {
                this.mode = 'PRIVILEGED_EXEC';
                return '';
            }
            return '';
        }

        if (cmd === 'disable') {
            if (this.mode !== 'USER_EXEC') {
                this.mode = 'USER_EXEC';
                return '';
            }
            return '';
        }

        if (trimmed.toLowerCase() === 'configure terminal' || trimmed.toLowerCase() === 'conf t') {
            if (this.mode === 'PRIVILEGED_EXEC') {
                this.mode = 'GLOBAL_CONFIG';
                return 'Enter configuration commands, one per line.  End with CNTL/Z.\n';
            } else {
                return `% Command rejected: Place in Privileged EXEC mode first.`;
            }
        }


        if (cmd === 'terminal' && args[1] === 'length' && args[2] === '0') {
            return '';
        }
        if (cmd === 'screen-length' && args[1] === '0' && args[2] === 'temporary') {
            return '';
        }
        if (cmd === 'set' && args[1] === 'cli' && args[2] === 'screen-length' && args[3] === '0') {
            return '';
        }
        if (cmd === 'terminal' && args[1] === 'shell') {
            this.shellEnabled = true;
            return '';
        }
        if (cmd === 'shell' && args[1] === 'processing' && args[2] === 'full') {
            this.shellEnabled = true;
            return '';
        }


        if (this.mode === 'GLOBAL_CONFIG') {
            if (cmd === 'hostname' && args[1]) {
                this.hostname = args[1];
                return '';
            }

            if (cmd === 'interface' && args[1]) {
                const ifaceName = this.normalizeInterfaceName(args[1]);
                this.mode = 'INTERFACE_CONFIG';
                this.activeInterface = ifaceName;
                if (!this.interfaces.has(ifaceName)) {

                    this.interfaces.set(ifaceName, {
                        name: ifaceName,
                        ip: null,
                        subnet: null,
                        adminShutdown: false,
                        lineProtocolUp: true,
                        description: null
                    });
                }
                return '';
            }

            if (cmd === 'vlan' && args[1]) {
                const vlanId = parseInt(args[1], 10);
                if (!isNaN(vlanId)) {
                    this.vlans.add(vlanId);
                    this.activeVlan = vlanId;
                    this.mode = 'GLOBAL_CONFIG';
                    return '';
                }
            }

            if (cmd === 'no' && args[1] === 'vlan' && args[2]) {
                const vlanId = parseInt(args[2], 10);
                if (!isNaN(vlanId)) {
                    this.vlans.delete(vlanId);
                    this.vlanNames.delete(vlanId);
                    return '';
                }
            }

            if (cmd === 'ip' && args[1] === 'route' && args[2] && args[3]) {
                const network = args[2];
                const mask = args[3];
                const next = args[4] || null;

                this.routes.push({
                    network,
                    mask,
                    nextHop: next && !next.startsWith('Gig') && !next.startsWith('Loop') ? next : null,
                    outgoingInterface: next && (next.startsWith('Gig') || next.startsWith('Loop')) ? next : null,
                    connected: false
                });
                return '';
            }

            if (cmd === 'no' && args[1] === 'ip' && args[2] === 'route' && args[3] && args[4]) {
                const network = args[3];
                const mask = args[4];
                this.routes = this.routes.filter(r => !(r.network === network && r.mask === mask));
                return '';
            }


            if (cmd === 'ip' && args[1] === 'routing') {
                this.ipRoutingEnabled = true;
                return '';
            }

            if (cmd === 'no' && args[1] === 'ip' && args[2] === 'routing') {
                this.ipRoutingEnabled = false;
                return '';
            }

            if (cmd === 'router' && args[1] === 'ospf') {
                this.mode = 'OSPF_CONFIG';
                this.ospfProcessId = args[2] || null;
                this.ospfEnabled = true;
                return '';
            }

            if (cmd === 'no' && args[1] === 'router' && args[2] === 'ospf') {
                this.ospfEnabled = false;
                this.ospfProcessId = null;
                return '';
            }


            if (cmd === 'ip' && args[1] === 'dhcp' && args[2] === 'pool' && args[3]) {
                this.mode = 'DHCP_CONFIG';
                return '';
            }
            if (cmd === 'ip' && args[1] === 'dhcp' && args[2] === 'excluded-address') {
                return '';
            }


            if (cmd === 'ip' && args[1] === 'access-list') {
                this.mode = 'ACL_CONFIG';
                return '';
            }
            if (cmd === 'access-list') {
                return '';
            }


            return `% Invalid input detected at '^' marker.`;
        }


        if (this.mode === 'INTERFACE_CONFIG' && this.activeInterface) {
            const iface = this.interfaces.get(this.activeInterface)!;

            if (cmd === 'shutdown') {
                iface.adminShutdown = true;
                iface.lineProtocolUp = false;
                return '';
            }

            if (cmd === 'no' && args[1] === 'shutdown') {
                iface.adminShutdown = false;
                iface.lineProtocolUp = true;
                return '';
            }

            if (cmd === 'ip' && args[1] === 'address' && args[2] && args[3]) {
                iface.ip = args[2];
                iface.subnet = args[3];

                const network = this.calculateNetwork(args[2], args[3]);
                this.routes = this.routes.filter(r => !(r.outgoingInterface === this.activeInterface && r.connected));
                this.routes.push({
                    network,
                    mask: args[3],
                    nextHop: null,
                    outgoingInterface: this.activeInterface,
                    connected: true
                });
                return '';
            }

            if (cmd === 'no' && args[1] === 'ip' && args[2] === 'address') {
                iface.ip = null;
                iface.subnet = null;
                this.routes = this.routes.filter(r => !(r.outgoingInterface === this.activeInterface && r.connected));
                return '';
            }

            if (cmd === 'description') {
                iface.description = args.slice(1).join(' ');
                return '';
            }

            if (cmd === 'no' && args[1] === 'description') {
                iface.description = null;
                return '';
            }

            if (cmd === 'ip' && args[1] === 'access-group') {
                return '';
            }

            if (cmd === 'ip' && args[1] === 'ospf') {
                return '';
            }


            return `% Invalid input detected at '^' marker.`;
        }

        if (this.mode === 'OSPF_CONFIG') {
            if (cmd === 'network' || cmd === 'router-id') {
                return '';
            }
            if (cmd === 'passive-interface' || (cmd === 'no' && args[1] === 'passive-interface')) {
                return '';
            }
            return `% Invalid input detected at '^' marker.`;
        }

        if (this.mode === 'DHCP_CONFIG') {
            if (cmd === 'network' || cmd === 'default-router' || cmd === 'dns-server') {
                return '';
            }
            return `% Invalid input detected at '^' marker.`;
        }

        if (this.mode === 'ACL_CONFIG') {
            if (cmd === 'permit' || cmd === 'deny') {
                return '';
            }
            return `% Invalid input detected at '^' marker.`;
        }




        const isShow = cmd === 'show' || cmd === 'sh' || (cmd === 'do' && (args[1]?.toLowerCase() === 'show' || args[1]?.toLowerCase() === 'sh'));
        if (isShow) {
            const showArgs = cmd === 'do' ? args.slice(2) : args.slice(1);
            const showCmd = showArgs[0]?.toLowerCase();

            if (showCmd === 'version' || showCmd === 'ver') {
                return `Cisco IOS Software, C2960 Software (C2960-LANBASEK9-M), Version 15.0(2)SE4, RELEASE SOFTWARE (fc1)
Technical Support: http://www.cisco.com/techsupport
Copyright (c) 1986-2013 by Cisco Systems, Inc.
Compiled Wed 26-Jun-13 02:49 by prod_rel_team

ROM: Bootstrap program is 12.2(44)SE Version
BOOTLDR: C2960 Boot Loader (C2960-HBOOT-M) Version 12.2(44)SE, RELEASE SOFTWARE (fc1)

Switch1 uptime is 2 hours, 15 minutes
System returned to ROM by power-on
System image file is "flash:/c2960-lanbasek9-mz.150-2.SE4.bin"

This product contains cryptographic features and is subject to Y...
`;
            }

            if (showCmd === 'ip' && showArgs[1]?.startsWith('int') && showArgs[2]?.startsWith('br')) {
                let out = 'Interface                  IP-Address      OK? Method Status                Protocol\n';
                for (const [name, status] of this.interfaces.entries()) {
                    const ip = status.ip || 'unassigned';
                    const method = status.ip ? 'manual' : 'unset';
                    const adminStatus = status.adminShutdown ? 'administratively down' : 'up';
                    const protocolStatus = status.lineProtocolUp ? 'up' : 'down';
                    out += `${name.padEnd(26)} ${ip.padEnd(15)} YES ${method.padEnd(6)} ${adminStatus.padEnd(21)} ${protocolStatus}\n`;
                }
                return out;
            }

            if (showCmd?.startsWith('run')) {
                let out = `Building configuration...\n\nCurrent configuration : 1542 bytes\n!\nversion 15.0\n!\nhostname ${this.hostname}\n!\n`;
                for (const [name, status] of this.interfaces.entries()) {
                    out += `interface ${name}\n`;
                    if (status.description) {
                        out += ` description ${status.description}\n`;
                    }
                    if (status.ip) {
                        out += ` ip address ${status.ip} ${status.subnet}\n`;
                    }
                    if (status.adminShutdown) {
                        out += ` shutdown\n`;
                    }
                    out += `!\n`;
                }
                for (const r of this.routes) {
                    if (!r.connected) {
                        out += `ip route ${r.network} ${r.mask} ${r.nextHop || r.outgoingInterface}\n`;
                    }
                }
                out += `!\nend\n`;
                return out;
            }

            if (showCmd === 'ip' && showArgs[1]?.startsWith('ro')) {
                if (!this.ipRoutingEnabled) {
                    return '% IP routing table is not enabled';
                }
                let out = `Codes: L - local, C - connected, S - static, R - RIP, M - mobile, B - BGP\n\n`;
                out += `Gateway of last resort is not set\n\n`;
                for (const r of this.routes) {
                    const code = r.connected ? 'C' : 'S';
                    const target = r.nextHop ? `via ${r.nextHop}` : `directly connected, ${r.outgoingInterface || 'Null0'}`;
                    out += `${code}        ${r.network}/${this.getPrefixLength(r.mask)} is ${target}\n`;
                }
                return out;
            }

            if (showCmd === 'ip' && showArgs[1] === 'ospf' && showArgs[2]?.startsWith('ne')) {
                if (!this.ospfEnabled) {
                    return '% OSPF is not enabled';
                }
                return `Neighbor ID     Pri   State           Dead Time   Address         Interface\n` +
                       `2.2.2.2           1   FULL/DR         00:00:35    192.168.1.2     GigabitEthernet0/0\n`;
            }

            if (showCmd === 'ip' && showArgs[1] === 'ospf' && showArgs[2]?.startsWith('in')) {
                if (!this.ospfEnabled) {
                    return '% OSPF is not enabled';
                }
                return `GigabitEthernet0/0 is up, line protocol is up \n` +
                       `  Internet Address 192.168.1.254/24, Area 0 \n` +
                       `  Process ID ${this.ospfProcessId || '10'}, Router ID 192.168.1.254, Network Type BROADCAST, Cost: 1\n`;
            }

            if (showCmd === 'ip' && showArgs[1] === 'ospf' && !showArgs[2]) {
                if (!this.ospfEnabled) {
                    return '% OSPF is not enabled';
                }
                return ` Routing Process "ospf ${this.ospfProcessId || '10'}" with ID 192.168.1.254\n` +
                       ` Supports only single TOS(TOS0) routes\n` +
                       ` Supports opaque LSA\n`;
            }

            if (showCmd?.startsWith('vl') && (showArgs[1]?.startsWith('br') || !showArgs[1])) {
                let out = 'VLAN Name                             Status    Ports\n';
                out += '---- -------------------------------- --------- -------------------------------\n';
                for (const vid of this.vlans) {
                    const name = this.vlanNames.get(vid) || `VLAN${vid.toString().padStart(4, '0')}`;
                    out += `${vid.toString().padEnd(4)} ${name.padEnd(32)} active    \n`;
                }
                return out;
            }

            if (showCmd === 'cdp' && showArgs[1]?.startsWith('ne')) {


                return `Capability Codes: R - Router, T - Trans Bridge, B - Source Route Bridge
                  S - Switch, H - Host, I - IGMP, r - Repeater, P - Phone

Device ID        Local Intrfce     Holdtme    Capability  Platform  Port ID
Switch2          Gig 0/1           125              S I   WS-C2960- Gig 0/1
`;
            }

            if (showCmd === 'lldp' && showArgs[1]?.startsWith('ne')) {



                return `Device ID           Local Intf         Hold-time  Capability      Port ID
Switch2             Gi0/1              120        S               Gi0/1
Total entries displayed: 1
`;
            }

            return `% Unrecognized show command: show ${showArgs.join(' ')}`;
        }


        if (cmd === 'write' || cmd === 'wr') {
            return `Building configuration...\n[OK]`;
        }

        if (cmd === 'copy' && args[1]?.startsWith('run') && args[2]?.startsWith('sta')) {
            return `Destination filename [startup-config]? \nBuilding configuration...\n[OK]`;
        }

        if (cmd === 'copy' && args[1]?.startsWith('run') && args[2]?.startsWith('flash:')) {
            const destFile = args[2].replace(/^flash:/i, '');
            this.pendingCopyDest = destFile || 'backup-agent.cfg';
            return `Destination filename [${this.pendingCopyDest}]? `;
        }

        if (cmd === 'dir' && args[1] === 'flash:') {
            let out = `Directory of flash:/\n\n`;
            let index = 1;
            let totalBytesUsed = 0;
            
            out += `    ${index++}  -rw-     4414921  Mar 01 1993 00:02:18 +00:00  c2960-lanbasek9-mz.150-2.SE4.bin\n`;
            totalBytesUsed += 4414921;

            if (this.flashFiles.has('backup-agent.cfg')) {
                out += `    ${index++}  -rw-        1542  May 31 2026 12:24:17 +00:00  backup-agent.cfg\n`;
                totalBytesUsed += 1542;
            }

            const totalBytes = 32514048;
            const freeBytes = totalBytes - totalBytesUsed;
            out += `\n${totalBytes} bytes total (${freeBytes} bytes free)\n`;
            return out;
        }

        if (cmd === 'configure' && args[1] === 'replace' && args[2]?.startsWith('flash:')) {
            const file = args[2].replace(/^flash:/i, '');
            if (!this.flashFiles.has(file)) {
                return `% Error opening flash:${file} (No such file or directory)`;
            }
            this.restoreBackupState();
            return `Total number of passes: 1\nRollback Done\n`;
        }


        if (cmd === 'ping' && args[1]) {
            const ip = args[1];
            return `Sending 5, 100-byte ICMP Echos to ${ip}, timeout is 2 seconds:
!!!!!
Success rate is 100 percent (5/5), round-trip min/avg/max = 1/1/4 ms
`;
        }


        return `% Unrecognized command: ${trimmed}`;
    }

    private normalizeInterfaceName(name: string): string {

        const lower = name.toLowerCase();
        if (lower.startsWith('gi')) {
            return 'GigabitEthernet' + name.substring(2);
        }
        if (lower.startsWith('lo')) {
            return 'Loopback' + name.substring(2);
        }
        if (lower.startsWith('fa')) {
            return 'FastEthernet' + name.substring(2);
        }
        return name;
    }

    private getPrefixLength(mask: string): number {
        const parts = mask.split('.').map(Number);
        let len = 0;
        for (const p of parts) {
            let b = p;
            while (b > 0) {
                if (b & 1) len++;
                b = b >> 1;
            }
        }
        return len;
    }

    private calculateNetwork(ip: string, mask: string): string {
        const ipParts = ip.split('.').map(Number);
        const maskParts = mask.split('.').map(Number);
        const netParts = ipParts.map((p, i) => p & maskParts[i]);
        return netParts.join('.');
    }
}
