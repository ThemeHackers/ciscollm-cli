import { PROMPT_REGEX } from '../shared/constants';
import { EventEmitter } from 'events';

export const simulatorEvents = new EventEmitter();

export type CliMode = 'USER_EXEC' | 'PRIVILEGED_EXEC' | 'GLOBAL_CONFIG' | 'INTERFACE_CONFIG' | 'OSPF_CONFIG' | 'RIP_CONFIG' | 'BGP_CONFIG' | 'EIGRP_CONFIG' | 'DHCP_CONFIG' | 'ACL_CONFIG' | 'VLAN_CONFIG' | 'VPC_CONFIG' | 'VRF_CONFIG' | 'VRF_AF_CONFIG';

export interface InterfaceState {
    name: string;
    ip: string | null;
    subnet: string | null;
    adminShutdown: boolean;
    lineProtocolUp: boolean;
    description: string | null;
    isSwitchport?: boolean;
    switchportMode?: 'access' | 'trunk';
    vlan?: number;
    natType?: 'inside' | 'outside';
    vpcMemberId?: number;
    sourceInterface?: string;
    memberVnis?: Map<number, { mcastGroup?: string; associateVrf?: boolean }>;
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
    public mode: CliMode = 'USER_EXEC';
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
    public ripEnabled: boolean = false;
    public ripVersion: number = 2;
    public ripAutoSummary: boolean = false;
    public bgpEnabled: boolean = false;
    public bgpAsn: string | null = null;
    public eigrpEnabled: boolean = false;
    public eigrpAsn: string | null = null;
    public vtpMode: string = 'server';
    public vtpDomain: string | null = null;
    public vtpPassword: string | null = null;
    public hsrpGroups: Map<string, { virtualIp: string; priority: number; preempt: boolean }> = new Map();
    public vrrpGroups: Map<string, { virtualIp: string; priority: number }> = new Map();
    public ntpServers: string[] = [];
    public snmpCommunities: string[] = [];
    public natInsideInterfaces: Set<string> = new Set();
    public natOutsideInterfaces: Set<string> = new Set();
    public natRules: string[] = [];
    public acls: Map<string, string[]> = new Map();
    public ipRoutingEnabled: boolean = true;


    public featuresEnabled: Set<string> = new Set();
    public vpcDomainId: number | null = null;
    public vpcPeerKeepalive: string | null = null;
    public vnSegments: Map<number, number> = new Map();
    public vrfs: Map<string, { vni?: number; rd?: string; routeTargets: string[] }> = new Map();
    public activeVrf: string | null = null;
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
            case 'RIP_CONFIG':
            case 'BGP_CONFIG':
            case 'EIGRP_CONFIG':
                return `${this.hostname}(config-router)# `;
            case 'DHCP_CONFIG':
                return `${this.hostname}(config-dhcp)# `;
            case 'ACL_CONFIG':
                return `${this.hostname}(config-ext-nacl)# `;
            case 'VLAN_CONFIG':
                return `${this.hostname}(config-vlan)# `;
            case 'VPC_CONFIG':
                return `${this.hostname}(config-vpc-domain)# `;
            case 'VRF_CONFIG':
                return `${this.hostname}(config-vrf)# `;
            case 'VRF_AF_CONFIG':
                return `${this.hostname}(config-vrf-af-ipv4)# `;
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

        const isShow = cmd === 'show' || cmd === 'sh' || (cmd === 'do' && (args[1]?.toLowerCase() === 'show' || args[1]?.toLowerCase() === 'sh'));

        if (cmd === '?' || cmd === 'help') {
            if (cmd === 'help') {
                return `Help may be requested at any point in a command by entering
a question mark '?'. If nothing matches, the help list will
show the available options.`;
            }
            if (this.mode === 'USER_EXEC') {
                return `Exec commands:
  disable            Turn off privileged commands
  enable             Turn on privileged commands
  exit               Exit from the EXEC
  ping               Send echo messages
  show               Show running system information`;
            } else if (this.mode === 'PRIVILEGED_EXEC') {
                return `Exec commands:
  clear              Reset functions
  configure          Enter configuration mode
  copy               Copy from one file to another
  dir                List files on a filesystem
  disable            Turn off privileged commands
  enable             Turn on privileged commands
  exit               Exit from the EXEC
  ping               Send echo messages
  show               Show running system information
  write              Write running configuration to memory or terminal`;
            } else if (this.mode === 'GLOBAL_CONFIG') {
                return `Configure commands:
  do                 To run EXEC commands in config mode
  end                Exit from configure mode
  exit               Exit from configure mode
  hostname           Set system's network name
  interface          Select an interface to configure
  ip                 Global IP configuration subcommands
  no                 Negate a command or set defaults
  router             Enable a routing process
  vlan               Vlan configuration commands`;
            } else if (this.mode === 'INTERFACE_CONFIG') {
                return `Interface configuration commands:
  description        Detailed description of this interface
  exit               Exit from interface configuration mode
  ip                 IP interface configuration subcommands
  no                 Negate a command or set defaults
  shutdown           Shutdown this interface`;
            } else {
                return `Commands:
  exit               Exit current mode
  end                Exit to privileged EXEC mode`;
            }
        }

        if (cmd === 'clear') {
            if (this.mode === 'USER_EXEC') {
                return `% Command rejected: Place in Privileged EXEC mode first.`;
            }
            return `% Incomplete command.`;
        }


        if (cmd === 'exit') {
            if (this.mode === 'INTERFACE_CONFIG' || this.mode === 'OSPF_CONFIG' || this.mode === 'RIP_CONFIG' || this.mode === 'BGP_CONFIG' || this.mode === 'EIGRP_CONFIG' || this.mode === 'DHCP_CONFIG' || this.mode === 'ACL_CONFIG' || this.mode === 'VLAN_CONFIG' || this.mode === 'VPC_CONFIG' || this.mode === 'VRF_CONFIG') {
                this.mode = 'GLOBAL_CONFIG';
                this.activeInterface = null;
                this.activeVlan = null;
                this.activeVrf = null;
                return '';
            } else if (this.mode === 'VRF_AF_CONFIG') {
                this.mode = 'VRF_CONFIG';
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
                this.activeVrf = null;
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


        const isGeneralCommand = isShow || cmd === 'ping' || cmd === 'write' || cmd === 'wr' || cmd === 'copy' || cmd === 'dir' || cmd === 'test';

        if (this.mode === 'GLOBAL_CONFIG' && !isGeneralCommand) {
            if (cmd === 'feature' && args[1]) {
                const featureName = args.slice(1).join(' ').toLowerCase();
                this.featuresEnabled.add(featureName);
                return '';
            }

            if (cmd === 'no' && args[1] === 'feature' && args[2]) {
                const featureName = args.slice(2).join(' ').toLowerCase();
                this.featuresEnabled.delete(featureName);
                return '';
            }

            if (cmd === 'vpc' && args[1] === 'domain' && args[2]) {
                const domainId = parseInt(args[2], 10);
                if (!isNaN(domainId)) {
                    this.vpcDomainId = domainId;
                    this.mode = 'VPC_CONFIG';
                    return '';
                }
            }

            if (cmd === 'vrf' && args[1] === 'context' && args[2]) {
                const vrfName = args[2];
                this.activeVrf = vrfName;
                if (!this.vrfs.has(vrfName)) {
                    this.vrfs.set(vrfName, { routeTargets: [] });
                }
                this.mode = 'VRF_CONFIG';
                return '';
            }

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
                    this.mode = 'VLAN_CONFIG';
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

            if (cmd === 'router' && args[1] === 'rip') {
                this.mode = 'RIP_CONFIG';
                this.ripEnabled = true;
                return '';
            }

            if (cmd === 'no' && args[1] === 'router' && args[2] === 'rip') {
                this.ripEnabled = false;
                return '';
            }

            if (cmd === 'router' && args[1] === 'bgp') {
                this.mode = 'BGP_CONFIG';
                this.bgpAsn = args[2] || null;
                this.bgpEnabled = true;
                return '';
            }

            if (cmd === 'no' && args[1] === 'router' && args[2] === 'bgp') {
                this.bgpEnabled = false;
                this.bgpAsn = null;
                return '';
            }

            if (cmd === 'spanning-tree' && args[1]) {
                return '';
            }

            if (cmd === 'router' && args[1] === 'eigrp') {
                this.mode = 'EIGRP_CONFIG';
                this.eigrpAsn = args[2] || null;
                this.eigrpEnabled = true;
                return '';
            }

            if (cmd === 'no' && args[1] === 'router' && args[2] === 'eigrp') {
                this.eigrpEnabled = false;
                this.eigrpAsn = null;
                return '';
            }

            if (cmd === 'vtp' && args[1]) {
                if (args[1] === 'mode' && args[2]) {
                    this.vtpMode = args[2].toLowerCase();
                } else if (args[1] === 'domain' && args[2]) {
                    this.vtpDomain = args[2];
                } else if (args[1] === 'password' && args[2]) {
                    this.vtpPassword = args[2];
                }
                return '';
            }

            if (cmd === 'ntp' && args[1] === 'server' && args[2]) {
                if (!this.ntpServers.includes(args[2])) {
                    this.ntpServers.push(args[2]);
                }
                return '';
            }

            if (cmd === 'snmp-server' && args[1] === 'community' && args[2]) {
                if (!this.snmpCommunities.includes(args[2])) {
                    this.snmpCommunities.push(args[2]);
                }
                return '';
            }

            if (cmd === 'ip' && args[1] === 'nat' && args[2] === 'inside' && args[3] === 'source') {
                this.natRules.push(args.slice(2).join(' '));
                return '';
            }

            if (cmd === 'access-list' && args[1] && args[2]) {
                const aclId = args[1];
                const rule = args.slice(2).join(' ');
                if (!this.acls.has(aclId)) {
                    this.acls.set(aclId, []);
                }
                this.acls.get(aclId)!.push(rule);
                return '';
            }

            if (cmd === 'ip' && args[1] === 'access-list' && (args[2] === 'standard' || args[2] === 'extended') && args[3]) {
                this.mode = 'ACL_CONFIG';
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


        if (this.mode === 'VLAN_CONFIG' && this.activeVlan !== null && !isGeneralCommand) {
            if (cmd === 'name' && args[1]) {
                this.vlanNames.set(this.activeVlan, args.slice(1).join(' '));
                return '';
            }
            if (cmd === 'no' && args[1] === 'name') {
                this.vlanNames.set(this.activeVlan, `VLAN${this.activeVlan.toString().padStart(4, '0')}`);
                return '';
            }
            if (cmd === 'vn-segment' && args[1]) {
                const vni = parseInt(args[1], 10);
                if (!isNaN(vni)) {
                    this.vnSegments.set(this.activeVlan, vni);
                    return '';
                }
            }
            return `% Invalid input detected at '^' marker.`;
        }

        if (this.mode === 'INTERFACE_CONFIG' && this.activeInterface && !isGeneralCommand) {
            const iface = this.interfaces.get(this.activeInterface)!;

            if (cmd === 'vpc' && args[1]) {
                const vpcId = parseInt(args[1], 10);
                if (!isNaN(vpcId)) {
                    iface.vpcMemberId = vpcId;
                    return '';
                }
            }

            if (cmd === 'source-interface' && args[1]) {
                iface.sourceInterface = args[1];
                return '';
            }

            if (cmd === 'member' && args[1] === 'vni' && args[2]) {
                const vni = parseInt(args[2], 10);
                if (!isNaN(vni)) {
                    if (!iface.memberVnis) {
                        iface.memberVnis = new Map();
                    }
                    const mcastGroup = args[3] === 'mcast-group' ? args[4] : undefined;
                    const associateVrf = args.includes('associate-vrf');
                    iface.memberVnis.set(vni, { mcastGroup, associateVrf });
                    return '';
                }
            }

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

            if (cmd === 'switchport') {
                if (args[1] === 'mode' && args[2] === 'access') {
                    iface.switchportMode = 'access';
                    iface.isSwitchport = true;
                    return '';
                }
                if (args[1] === 'access' && args[2] === 'vlan' && args[3]) {
                    const vlanId = parseInt(args[3], 10);
                    if (!isNaN(vlanId)) {
                        iface.vlan = vlanId;
                        iface.isSwitchport = true;
                        let output = '';
                        if (!this.vlans.has(vlanId)) {
                            this.vlans.add(vlanId);
                            this.vlanNames.set(vlanId, `VLAN${vlanId.toString().padStart(4, '0')}`);
                            output = `%% Access VLAN ${vlanId} does not exist. Creating vlan ${vlanId}\n`;
                        }
                        return output;
                    }
                }
                if (!args[1]) {
                    iface.isSwitchport = true;
                    return '';
                }
            }

            if (cmd === 'no' && args[1] === 'switchport') {
                iface.isSwitchport = false;
                iface.vlan = undefined;
                iface.switchportMode = undefined;
                return '';
            }

            if (cmd === 'ip' && args[1] === 'access-group') {
                return '';
            }

            if (cmd === 'ip' && args[1] === 'ospf') {
                return '';
            }

            if (cmd === 'switchport' && args[1] === 'mode' && args[2] === 'trunk') {
                iface.switchportMode = 'trunk';
                iface.isSwitchport = true;
                return '';
            }

            if (cmd === 'switchport' && args[1] === 'trunk' && args[2] === 'allowed' && args[3] === 'vlan') {
                return '';
            }

            if (cmd === 'channel-group' && args[1] && args[2] === 'mode' && args[3]) {
                return '';
            }

            if (cmd === 'standby' && args[1]) {
                const group = args[1];
                if (!this.hsrpGroups.has(group)) {
                    this.hsrpGroups.set(group, { virtualIp: '', priority: 100, preempt: false });
                }
                const hsrp = this.hsrpGroups.get(group)!;
                if (args[2] === 'ip' && args[3]) {
                    hsrp.virtualIp = args[3];
                } else if (args[2] === 'priority' && args[3]) {
                    hsrp.priority = parseInt(args[3], 10);
                } else if (args[2] === 'preempt') {
                    hsrp.preempt = true;
                }
                return '';
            }

            if (cmd === 'vrrp' && args[1]) {
                const group = args[1];
                if (!this.vrrpGroups.has(group)) {
                    this.vrrpGroups.set(group, { virtualIp: '', priority: 100 });
                }
                const vrrp = this.vrrpGroups.get(group)!;
                if (args[2] === 'ip' && args[3]) {
                    vrrp.virtualIp = args[3];
                } else if (args[2] === 'priority' && args[3]) {
                    vrrp.priority = parseInt(args[3], 10);
                }
                return '';
            }

            if (cmd === 'ip' && args[1] === 'nat' && (args[2] === 'inside' || args[2] === 'outside')) {
                iface.natType = args[2] as 'inside' | 'outside';
                if (args[2] === 'inside') {
                    this.natInsideInterfaces.add(this.activeInterface!);
                } else {
                    this.natOutsideInterfaces.add(this.activeInterface!);
                }
                return '';
            }


            return `% Invalid input detected at '^' marker.`;
        }

        if (this.mode === 'OSPF_CONFIG' && !isGeneralCommand) {
            if (cmd === 'network' || cmd === 'router-id') {
                return '';
            }
            if (cmd === 'passive-interface' || (cmd === 'no' && args[1] === 'passive-interface')) {
                return '';
            }
            return `% Invalid input detected at '^' marker.`;
        }

        if (this.mode === 'RIP_CONFIG' && !isGeneralCommand) {
            if (cmd === 'version' && (args[1] === '1' || args[1] === '2')) {
                this.ripVersion = parseInt(args[1], 10);
                return '';
            }
            if (cmd === 'no' && args[1] === 'auto-summary') {
                this.ripAutoSummary = false;
                return '';
            }
            if (cmd === 'auto-summary') {
                this.ripAutoSummary = true;
                return '';
            }
            if (cmd === 'network' && args[1]) {
                return '';
            }
            if (cmd === 'passive-interface' || (cmd === 'no' && args[1] === 'passive-interface')) {
                return '';
            }
            return `% Invalid input detected at '^' marker.`;
        }

        if (this.mode === 'BGP_CONFIG' && !isGeneralCommand) {
            if (cmd === 'neighbor' && args[1]) {
                return '';
            }
            if (cmd === 'no' && args[1] === 'neighbor' && args[2]) {
                return '';
            }
            if (cmd === 'network' && args[1]) {
                return '';
            }
            if (cmd === 'no' && args[1] === 'auto-summary') {
                return '';
            }
            if (cmd === 'auto-summary') {
                return '';
            }
            if (cmd === 'address-family' && args[1] === 'l2vpn' && args[2] === 'evpn') {
                return '';
            }
            if (cmd === 'send-community') {
                return '';
            }
            return `% Invalid input detected at '^' marker.`;
        }

        if (this.mode === 'VPC_CONFIG' && !isGeneralCommand) {
            if (cmd === 'peer-keepalive' && args[1] === 'destination') {
                this.vpcPeerKeepalive = commandToExecute;
                return '';
            }
            if (cmd === 'system-priority' || cmd === 'role' || cmd === 'peer-gateway' || cmd === 'peer-switch') {
                return '';
            }
            return `% Invalid input detected at '^' marker.`;
        }

        if (this.mode === 'VRF_CONFIG' && this.activeVrf && !isGeneralCommand) {
            const vrf = this.vrfs.get(this.activeVrf)!;
            if (cmd === 'vni' && args[1]) {
                vrf.vni = parseInt(args[1], 10);
                return '';
            }
            if (cmd === 'rd' && args[1]) {
                vrf.rd = args.slice(1).join(' ');
                return '';
            }
            if (cmd === 'address-family' && args[1] === 'ipv4' && args[2] === 'unicast') {
                this.mode = 'VRF_AF_CONFIG';
                return '';
            }
            return `% Invalid input detected at '^' marker.`;
        }

        if (this.mode === 'VRF_AF_CONFIG' && this.activeVrf && !isGeneralCommand) {
            const vrf = this.vrfs.get(this.activeVrf)!;
            if (cmd === 'route-target' && args[1] === 'both' && args[2]) {
                vrf.routeTargets.push(args.slice(1).join(' '));
                return '';
            }
            return `% Invalid input detected at '^' marker.`;
        }

        if (this.mode === 'EIGRP_CONFIG' && !isGeneralCommand) {
            if (cmd === 'network' && args[1]) {
                return '';
            }
            if (cmd === 'no' && args[1] === 'auto-summary') {
                return '';
            }
            if (cmd === 'auto-summary') {
                return '';
            }
            if (cmd === 'passive-interface' || (cmd === 'no' && args[1] === 'passive-interface')) {
                return '';
            }
            return `% Invalid input detected at '^' marker.`;
        }

        if (this.mode === 'DHCP_CONFIG' && !isGeneralCommand) {
            if (cmd === 'network' || cmd === 'default-router' || cmd === 'dns-server') {
                return '';
            }
            return `% Invalid input detected at '^' marker.`;
        }

        if (this.mode === 'ACL_CONFIG' && !isGeneralCommand) {
            if (cmd === 'permit' || cmd === 'deny') {
                return '';
            }
            return `% Invalid input detected at '^' marker.`;
        }




        if (isShow) {
            const showArgs = cmd === 'do' ? args.slice(2) : args.slice(1);
            const showCmd = showArgs[0]?.toLowerCase();

            if (showCmd === 'vpc') {
                const domainId = this.vpcDomainId || 10;
                const peerStatus = this.vpcPeerKeepalive ? 'peer adjacency formed ok' : 'peer link not configured';
                const keepaliveStatus = this.vpcPeerKeepalive ? 'peer is alive' : 'peer keep-alive not configured';
                return `Legend:
                (*) - local vPC is down, dynamic backup loop preventer

vPC domain id                     : ${domainId}
Peer status                       : ${peerStatus}
vPC keep-alive status             : ${keepaliveStatus}
Configuration-consistency status  : success 
Per-vlan consistency status       : success 
Type-2 consistency status         : success 
vPC role                          : primary                       
Number of vPCs configured         : ${Array.from(this.interfaces.values()).filter(i => i.vpcMemberId !== undefined).length}
Peer Gateway                      : Enabled
`;
            }

            if (showCmd === 'nve' && showArgs[1] === 'interface') {
                const nveIface = Array.from(this.interfaces.values()).find(i => i.name.toLowerCase().startsWith('nve'));
                if (!nveIface) {
                    return '% NVE interface is not configured';
                }
                const sourceInt = nveIface.sourceInterface || 'Loopback0';
                return `Interface: ${nveIface.name}, State: Up, Encapsulation: VXLAN
Source-Interface: ${sourceInt} (10.0.0.1)
`;
            }

            if (showCmd === 'nve' && showArgs[1] === 'vni') {
                const nveIface = Array.from(this.interfaces.values()).find(i => i.name.toLowerCase().startsWith('nve'));
                if (!nveIface || !nveIface.memberVnis) {
                    return `Interface VNI      Multicast-group   State Mode vPC Dev\n` +
                           `--------- -------- ----------------- ----- ---- -------\n`;
                }
                let out = `Interface VNI      Multicast-group   State Mode vPC Dev\n` +
                          `--------- -------- ----------------- ----- ---- -------\n`;
                for (const [vni, details] of nveIface.memberVnis.entries()) {
                    const mcast = details.mcastGroup || 'n/a';
                    out += `${nveIface.name.padEnd(9)} ${vni.toString().padEnd(8)} ${mcast.padEnd(17)} Up    CP   n/a\n`;
                }
                return out;
            }

            if (showCmd === 'bgp' && showArgs[1] === 'l2vpn' && showArgs[2] === 'evpn' && showArgs[3] === 'summary') {
                const bgpAs = this.bgpAsn || '65000';
                return `BGP summary information for VRF default, address family L2VPN EVPN
BGP router identifier 10.0.0.1, local AS number ${bgpAs}
Neighbor        V    AS MsgRcvd MsgSent   TblVer  InQ OutQ Up/Down  State/PfxRcd
10.0.0.2        4 ${bgpAs}     120     125       47    0    0 01:24:55 2
`;
            }

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

            if (showCmd === 'ip' && showArgs[1] === 'protocols') {
                let out = '';
                if (this.ospfEnabled) {
                    out += `Routing Protocol is "ospf ${this.ospfProcessId || '10'}"\n` +
                           `  Outgoing update filter list for all interfaces is not set\n` +
                           `  Incoming update filter list for all interfaces is not set\n` +
                           `  Router ID 192.168.1.254\n` +
                           `  Number of areas in this router is 1. 1 normal 0 stub 0 nssa\n` +
                           `  Routing for Networks:\n` +
                           `    192.168.1.0/24 area 0\n` +
                           `  Routing Information Sources:\n` +
                           `    Gateway         Distance      Last Update\n` +
                           `  Distance: (default is 110)\n\n`;
                }
                if (this.ripEnabled) {
                    out += `Routing Protocol is "rip"\n` +
                           `  Sending updates every 30 seconds, next due in 15 seconds\n` +
                           `  Invalid 180 seconds, hold down 180, flushed 240\n` +
                           `  Outgoing update filter list for all interfaces is not set\n` +
                           `  Incoming update filter list for all interfaces is not set\n` +
                           `  Redistributing: rip\n` +
                           `  Default version control: send version ${this.ripVersion}, receive version ${this.ripVersion}\n` +
                           `    Interface             Send  Recv  Triggered RIP  Key-chain\n`;
                    for (const name of this.interfaces.keys()) {
                        out += `    ${name.padEnd(21)} ${this.ripVersion}     ${this.ripVersion}\n`;
                    }
                    out += `  Automatic network summarization is ${this.ripAutoSummary ? 'in effect' : 'not in effect'}\n` +
                           `  Maximum path: 4\n` +
                           `  Routing for Networks:\n` +
                           `    192.168.1.0\n` +
                           `  Routing Information Sources:\n` +
                           `    Gateway         Distance      Last Update\n` +
                           `  Distance: (default is 120)\n\n`;
                }
                if (this.bgpEnabled) {
                    out += `Routing Protocol is "bgp ${this.bgpAsn || '65000'}"\n` +
                           `  Outgoing update filter list for all interfaces is not set\n` +
                           `  Incoming update filter list for all interfaces is not set\n` +
                           `  IGP synchronization is disabled\n` +
                           `  Automatic route summarization is disabled\n` +
                           `  Routing Information Sources:\n` +
                           `    Gateway         Distance      Last Update\n` +
                           `  Distance: external 20 internal 200 local 200\n\n`;
                }
                if (this.eigrpEnabled) {
                    out += `Routing Protocol is "eigrp ${this.eigrpAsn || '100'}"\n` +
                           `  Outgoing update filter list for all interfaces is not set\n` +
                           `  Incoming update filter list for all interfaces is not set\n` +
                           `  Default networks being advertised:\n` +
                           `    192.168.1.0\n` +
                           `  EIGRP-IPv4 Protocol for AS(${this.eigrpAsn || '100'})\n` +
                           `    Metric weight K1=1, K2=0, K3=1, K4=0, K5=0\n` +
                           `    NSF-aware route hold timer is 240s\n` +
                           `    Router-ID: 192.168.1.254\n` +
                           `    Topology Kisspoint limit: 100\n` +
                           `    Routing Information Sources:\n` +
                           `      Gateway         Distance      Last Update\n` +
                           `    Distance: internal 90 external 170\n\n`;
                }
                if (!out) {
                    out = '*** No routing protocols configured ***\n';
                }
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
                    const ports = Array.from(this.interfaces.values())
                        .filter(iface => iface.vlan === vid)
                        .map(iface => this.shortenInterfaceName(iface.name))
                        .join(', ');
                    out += `${vid.toString().padEnd(4)} ${name.padEnd(32)} active    ${ports}\n`;
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

            if (showCmd === 'vtp' && showArgs[1] === 'status') {
                return `VTP Version capability             : 1 to 3\n` +
                       `VTP version running                : 1\n` +
                       `VTP Operating Mode                 : ${this.vtpMode}\n` +
                       `VTP Domain Name                    : ${this.vtpDomain || ''}\n` +
                       `VTP Pruning Mode                   : Disabled\n` +
                       `VTP V2 Mode                        : Disabled\n` +
                       `VTP Traps Generation               : Disabled\n` +
                       `MD5 digest                         : 0x94 0xC2 0x6E 0x93 0xA3 0xE2 0xD4 0xFA \n` +
                       `Configuration last modified by 0.0.0.0 at 0-0-00 00:00:00\n`;
            }

            if (showCmd === 'standby' && (showArgs[1] === 'brief' || !showArgs[1])) {
                let out = '                     Preempt State   Active          Standby         Virtual IP\n';
                for (const [group, hsrp] of this.hsrpGroups.entries()) {
                    out += `Gi0/1      ${group.padEnd(6)} ${hsrp.priority.toString().padEnd(4)} ${hsrp.preempt ? 'P' : ' '}  Active  local           unknown         ${hsrp.virtualIp}\n`;
                }
                if (this.hsrpGroups.size === 0) {
                    out = '*** No HSRP standby groups configured ***\n';
                }
                return out;
            }

            if (showCmd === 'vrrp' && (showArgs[1] === 'brief' || !showArgs[1])) {
                let out = 'Interface   Grp  Fip Pri Time  Own Pre State   Master addr     Group addr\n';
                for (const [group, vrrp] of this.vrrpGroups.entries()) {
                    out += `Gi0/1       ${group.padEnd(4)} 1   ${vrrp.priority.toString().padEnd(3)} 3.609 N   Y   Master  local           ${vrrp.virtualIp}\n`;
                }
                if (this.vrrpGroups.size === 0) {
                    out = '*** No VRRP groups configured ***\n';
                }
                return out;
            }

            if (showCmd === 'ip' && showArgs[1] === 'nat' && showArgs[2] === 'translations') {
                let out = 'Pro Inside global      Inside local       Outside local      Outside global\n';
                for (const rule of this.natRules) {
                    out += `tcp 192.0.2.1:80       192.168.1.10:80    ---                ---\n`;
                }
                if (this.natRules.length === 0) {
                    out = '*** No NAT translations active ***\n';
                }
                return out;
            }

            if (showCmd === 'access-lists') {
                let out = '';
                for (const [aclId, rules] of this.acls.entries()) {
                    out += `Standard IP access list ${aclId}\n`;
                    rules.forEach((rule, idx) => {
                        out += `    ${(idx + 1) * 10} ${rule}\n`;
                    });
                }
                if (this.acls.size === 0) {
                    out = '*** No access lists configured ***\n';
                }
                return out;
            }

            if (showCmd === 'ntp' && (showArgs[1] === 'status' || showArgs[1] === 'associations')) {
                if (this.ntpServers.length === 0) {
                    return 'NTP is not enabled.\n';
                }
                let out = 'Clock is synchronized, stratum 2, reference is ' + this.ntpServers[0] + '\n';
                out += 'nominal freq is 250.0000 Hz, actual freq is 250.0000 Hz, precision is 2**24\n';
                return out;
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

        if (cmd === 'test' && args[1] === 'trigger-syslog') {
            const msgText = args.slice(2).join(' ');
            simulatorEvents.emit('syslog', msgText);
            return `[Simulator Test] Triggered syslog: ${msgText}`;
        }


        return `% Unrecognized command: ${trimmed}`;
    }

    private normalizeInterfaceName(name: string): string {
        const lower = name.toLowerCase();
        if (lower.startsWith('gigabitethernet')) {
            return 'GigabitEthernet' + name.substring(15);
        }
        if (lower.startsWith('gig')) {
            return 'GigabitEthernet' + name.substring(3);
        }
        if (lower.startsWith('gi')) {
            return 'GigabitEthernet' + name.substring(2);
        }
        if (lower.startsWith('loopback')) {
            return 'Loopback' + name.substring(8);
        }
        if (lower.startsWith('lo')) {
            return 'Loopback' + name.substring(2);
        }
        if (lower.startsWith('fastethernet')) {
            return 'FastEthernet' + name.substring(12);
        }
        if (lower.startsWith('fa')) {
            return 'FastEthernet' + name.substring(2);
        }
        if (lower.startsWith('tengigabitethernet')) {
            return 'TenGigabitEthernet' + name.substring(18);
        }
        if (lower.startsWith('ten-gigabitethernet')) {
            return 'TenGigabitEthernet' + name.substring(19);
        }
        if (lower.startsWith('te')) {
            return 'TenGigabitEthernet' + name.substring(2);
        }
        if (lower.startsWith('vlan')) {
            return 'Vlan' + name.substring(4);
        }
        if (lower.startsWith('vl')) {
            return 'Vlan' + name.substring(2);
        }
        if (lower.startsWith('ethernet')) {
            return 'Ethernet' + name.substring(8);
        }
        if (lower.startsWith('eth')) {
            return 'Ethernet' + name.substring(3);
        }
        if (lower.startsWith('port-channel')) {
            return 'Port-channel' + name.substring(12);
        }
        if (lower.startsWith('po')) {
            return 'Port-channel' + name.substring(2);
        }
        if (lower.startsWith('nve')) {
            return 'Nve' + name.substring(3);
        }
        return name;
    }

    private shortenInterfaceName(name: string): string {
        return name
            .replace('GigabitEthernet', 'Gi')
            .replace('FastEthernet', 'Fa')
            .replace('TenGigabitEthernet', 'Te')
            .replace('Loopback', 'Lo')
            .replace('Ethernet', 'Eth')
            .replace('Port-channel', 'Po')
            .replace('Nve', 'Nve');
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
