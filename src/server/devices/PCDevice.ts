import { BaseDevice } from './BaseDevice';

export interface PCDeviceConfig {
    ipAddress?: string;
    subnetMask?: string;
    defaultGateway?: string;
    macAddress?: string;
}

export class PCDevice extends BaseDevice {
    private ipAddress: string;
    private subnetMask: string;
    private defaultGateway: string;
    private macAddress: string;
    private arpTable: Map<string, string> = new Map();

    constructor(initialHostname?: string, config?: PCDeviceConfig) {
        super(initialHostname || 'PC1', 'pc');
        this.ipAddress = config?.ipAddress || '192.168.1.100';
        this.subnetMask = config?.subnetMask || '255.255.255.0';
        this.defaultGateway = config?.defaultGateway || '192.168.1.254';
        this.macAddress = config?.macAddress || '00:1A:2B:3C:4D:5E';
        
       
        this.arpTable.set(this.defaultGateway, '00:00:0C:07:AC:01');
    }

    public getPrompt(): string {
        return `C:\\> `;
    }

    public processCommand(cmd: string): string {
        const normalized = cmd.trim();
        
        if (!normalized) return '';
        if (normalized.toLowerCase() === 'ipconfig') {
            return this.executeIpconfig(false);
        }
        if (normalized.toLowerCase() === 'ipconfig /all') {
            return this.executeIpconfig(true);
        }
        if (normalized.toLowerCase() === 'arp -a') {
            return this.executeArp();
        }
        if (normalized.toLowerCase().startsWith('ping ')) {
            const target = normalized.substring(5).trim();
            return this.executePing(target);
        }
        if (normalized.toLowerCase() === 'exit') {
            return '';
        }
        if (normalized.toLowerCase() === '?') {
            return `Commands:\n  ipconfig\n  ipconfig /all\n  ping <target>\n  arp -a\n  exit`;
        }

        return `'${normalized}' is not recognized as an internal or external command,\noperable program or batch file.`;
    }

    private executeIpconfig(all: boolean): string {
        let out = `\nWindows IP Configuration\n\n`;
        out += `Ethernet adapter Ethernet0:\n\n`;
        if (all) {
            out += `   Connection-specific DNS Suffix  . : localdomain\n`;
            out += `   Description . . . . . . . . . . . : Intel(R) PRO/1000 MT Desktop Adapter\n`;
            out += `   Physical Address. . . . . . . . . : ${this.macAddress.replace(/:/g, '-')}\n`;
            out += `   DHCP Enabled. . . . . . . . . . . : No\n`;
            out += `   Autoconfiguration Enabled . . . . : Yes\n`;
        }
        out += `   IPv4 Address. . . . . . . . . . . : ${this.ipAddress}\n`;
        out += `   Subnet Mask . . . . . . . . . . . : ${this.subnetMask}\n`;
        out += `   Default Gateway . . . . . . . . . : ${this.defaultGateway}\n`;
        return out;
    }

    private executeArp(): string {
        if (this.arpTable.size === 0) {
            return 'No ARP Entries Found.';
        }
        let out = `\nInterface: ${this.ipAddress} --- 0x2\n`;
        out += `  Internet Address      Physical Address      Type\n`;
        for (const [ip, mac] of this.arpTable.entries()) {
            out += `  ${ip.padEnd(21)} ${mac.replace(/:/g, '-').toLowerCase().padEnd(21)} dynamic\n`;
        }
        return out;
    }

    private executePing(target: string): string {

        let out = `\nPinging ${target} with 32 bytes of data:\n`;
        for (let i = 0; i < 4; i++) {
            out += `Reply from ${target}: bytes=32 time<10ms TTL=128\n`;
        }
        out += `\nPing statistics for ${target}:\n`;
        out += `    Packets: Sent = 4, Received = 4, Lost = 0 (0% loss),\n`;
        out += `Approximate round trip times in milli-seconds:\n`;
        out += `    Minimum = 1ms, Maximum = 9ms, Average = 4ms\n`;
        return out;
    }
}
