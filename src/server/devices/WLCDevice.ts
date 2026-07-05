import { BaseDevice } from './BaseDevice';

export interface WLAN {
    id: number;
    name: string;
    ssid: string;
    status: boolean;
    security: string;
}

export class WLCDevice extends BaseDevice {
    private wlans: Map<number, WLAN> = new Map([
        [1, { id: 1, name: 'Guest-WiFi', ssid: 'Guest-WiFi', status: true, security: 'WPA2-PSK' }],
        [2, { id: 2, name: 'Corp-WiFi', ssid: 'Corp-WiFi', status: true, security: 'WPA2-Enterprise' }]
    ]);

    private clients: number = 42;

    constructor(initialHostname?: string) {
        super(initialHostname || 'Cisco Controller', 'wlc');
        this.mode = 'USER_EXEC';
    }

    public getPrompt(): string {
        return `(${this.hostname}) > `;
    }

    public processCommand(cmd: string): string {
        const normalized = cmd.trim();
        if (!normalized) return '';

        const args = normalized.split(/\s+/);
        const command = args[0].toLowerCase();

        if (command === 'exit' || command === 'logout') {
            return 'Connection closed.';
        }

        if (command === 'show') {
            const subcommand = args[1]?.toLowerCase();
            
            if (subcommand === 'wlan' && args[2]?.toLowerCase() === 'summary') {
                let out = `Number of WLANs.................................. ${this.wlans.size}\n\n`;
                out += `WLAN ID  WLAN Profile Name / SSID               Status    MAC Filtering\n`;
                out += `-------  -------------------------------------  --------  -------------\n`;
                for (const [id, wlan] of this.wlans) {
                    const nameSsid = `${wlan.name} / ${wlan.ssid}`;
                    out += `${id.toString().padEnd(8)} ${nameSsid.padEnd(38)} ${wlan.status ? 'Enabled ' : 'Disabled'}  Disabled\n`;
                }
                return out;
            }

            if (subcommand === 'client' && args[2]?.toLowerCase() === 'summary') {
                return `Number of Clients................................ ${this.clients}\n\nMAC Address       AP Name           Status        WLAN  Auth Protocol         Port\n----------------- ----------------- ------------- ----- --------------------  ----\n00:11:22:33:44:55 AP-1              Associated    1     Yes  802.11n(5 GHz)   1\n66:77:88:99:aa:bb AP-2              Associated    2     Yes  802.11ac         1\n... (and ${this.clients - 2} more clients)`;
            }

            if (subcommand === 'sysinfo') {
                return `Manufacturer's Name.............................. Cisco Systems Inc.\nProduct Name..................................... Cisco Controller\nProduct Version.................................. 8.5.182.0\nSystem Name...................................... ${this.hostname}`;
            }
        }

        if (command === 'config') {
            const subcommand = args[1]?.toLowerCase();
            
            if (subcommand === 'wlan') {
                if (args[2]?.toLowerCase() === 'create' && args[3] && args[4] && args[5]) {
                    const id = parseInt(args[3], 10);
                    if (isNaN(id)) return 'Invalid WLAN ID';
                    
                    const name = args[4];
                    const ssid = args[5];
                    this.wlans.set(id, { id, name, ssid, status: false, security: 'Open' });
                    return `WLAN ${id} created successfully.`;
                }

                if (args[2]?.toLowerCase() === 'enable' && args[3]) {
                    const id = parseInt(args[3], 10);
                    const wlan = this.wlans.get(id);
                    if (wlan) {
                        wlan.status = true;
                        return '';
                    }
                    return 'WLAN ID not found.';
                }

                if (args[2]?.toLowerCase() === 'disable' && args[3]) {
                    const id = parseInt(args[3], 10);
                    const wlan = this.wlans.get(id);
                    if (wlan) {
                        wlan.status = false;
                        return '';
                    }
                    return 'WLAN ID not found.';
                }
            }
        }

        if (command === 'save' && args[1] === 'config') {
            return 'Configuration Saved!';
        }

        if (command === '?') {
            return `WLC Commands:\n  show wlan summary\n  show client summary\n  show sysinfo\n  config wlan create <id> <name> <ssid>\n  config wlan enable <id>\n  config wlan disable <id>\n  save config\n  exit`;
        }

        return `Incorrect input! Use '?' for help.`;
    }
}
