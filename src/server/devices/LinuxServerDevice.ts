import { BaseDevice } from './BaseDevice';

export class LinuxServerDevice extends BaseDevice {
    private ipAddress: string = '192.168.1.100';
    private currentDirectory: string = '/root';
    
    constructor(initialHostname?: string) {
        super(initialHostname || 'server', 'linux');
        this.mode = 'BASH';
    }

    public getPrompt(): string {
        return `root@${this.hostname}:${this.currentDirectory}# `;
    }

    public processCommand(cmd: string): string {
        const normalized = cmd.trim();
        if (!normalized) return '';

        const args = normalized.split(/\s+/);
        const command = args[0].toLowerCase();

        if (command === 'exit') {
            return 'logout\nConnection closed.';
        }

        if (command === 'ip' && args[1] === 'addr') {
            return `1: lo: <LOOPBACK,UP,LOWER_UP> mtu 65536 qdisc noqueue state UNKNOWN group default qlen 1000\n    link/loopback 00:00:00:00:00:00 brd 00:00:00:00:00:00\n    inet 127.0.0.1/8 scope host lo\n       valid_lft forever preferred_lft forever\n2: eth0: <BROADCAST,MULTICAST,UP,LOWER_UP> mtu 1500 qdisc pfifo_fast state UP group default qlen 1000\n    link/ether 00:1a:2b:3c:4d:5e brd ff:ff:ff:ff:ff:ff\n    inet ${this.ipAddress}/24 brd 192.168.1.255 scope global eth0\n       valid_lft forever preferred_lft forever`;
        }

        if (command === 'ifconfig') {
            return `eth0: flags=4163<UP,BROADCAST,RUNNING,MULTICAST>  mtu 1500\n        inet ${this.ipAddress}  netmask 255.255.255.0  broadcast 192.168.1.255\n        inet6 fe80::21a:2bff:fe3c:4d5e  prefixlen 64  scopeid 0x20<link>\n        ether 00:1a:2b:3c:4d:5e  txqueuelen 1000  (Ethernet)\n        RX packets 15302  bytes 1234567 (1.2 MB)\n        TX packets 10243  bytes 987654 (987.6 KB)\n\nlo: flags=73<UP,LOOPBACK,RUNNING>  mtu 65536\n        inet 127.0.0.1  netmask 255.0.0.0\n        inet6 ::1  prefixlen 128  scopeid 0x10<host>\n        loop  txqueuelen 1000  (Local Loopback)\n        RX packets 120  bytes 10200 (10.2 KB)\n        TX packets 120  bytes 10200 (10.2 KB)`;
        }

        if (command === 'ping' && args[1]) {
            const target = args[1];
            return `PING ${target} (${target}) 56(84) bytes of data.\n64 bytes from ${target}: icmp_seq=1 ttl=64 time=1.23 ms\n64 bytes from ${target}: icmp_seq=2 ttl=64 time=1.05 ms\n64 bytes from ${target}: icmp_seq=3 ttl=64 time=1.12 ms\n64 bytes from ${target}: icmp_seq=4 ttl=64 time=0.98 ms\n\n--- ${target} ping statistics ---\n4 packets transmitted, 4 received, 0% packet loss, time 3004ms\nrtt min/avg/max/mdev = 0.98/1.09/1.23/0.10 ms`;
        }

        if (command === 'curl') {
            const url = args[1] || 'http://localhost';
            if (url.includes('localhost') || url.includes('127.0.0.1') || url.includes(this.ipAddress)) {
                return `<!DOCTYPE html>\n<html>\n<head><title>Welcome to Nginx!</title></head>\n<body>\n<h1>Success! The Nginx server is working!</h1>\n</body>\n</html>`;
            } else {
                return `curl: (7) Failed to connect to ${url} port 80: Connection refused`;
            }
        }

        if (command === 'ls') {
            if (this.currentDirectory === '/root') {
                return `docker-compose.yml  index.html  scripts  setup.sh`;
            }
            return '';
        }

        if (command === 'pwd') {
            return this.currentDirectory;
        }

        if (command === 'cat' && args[1]) {
            if (args[1] === 'setup.sh') {
                return `#!/bin/bash\napt-get update\napt-get install -y nginx`;
            }
            if (args[1] === 'index.html') {
                return `<h1>Hello World</h1>`;
            }
            return `cat: ${args[1]}: No such file or directory`;
        }

        if (command === 'clear') {
            return '\x1Bc'; 
        }

        if (command === '?') {
            return `Supported commands: ip addr, ifconfig, ping <ip>, curl <url>, ls, pwd, cat <file>, clear, exit`;
        }

        return `bash: ${command}: command not found`;
    }
}
