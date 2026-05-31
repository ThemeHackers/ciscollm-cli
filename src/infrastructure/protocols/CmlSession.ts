import { BaseSession } from './BaseSession';
import chalk from 'chalk';
import * as https from 'https';
import * as net from 'net';

interface CmlNode {
    id: string;
    label: string;
    state: string;
    nodeDefinition: string;
    labId: string;
    labTitle: string;
    mgmtIp?: string;
    mgmtPort?: number;
}

const PREFERRED_NODE_DEFS = ['iosv', 'iol-xe', 'csr1000v', 'cat8000v', 'iosxrv9000'];
const NODE_BOOT_TIMEOUT_MS = 5 * 60 * 1000;
const NODE_BOOT_POLL_MS   = 8000;

export class CmlSession extends BaseSession {
    private token: string | null = null;
    private activeLabId: string | null = null;
    private ownedLab = false;
    private activeNode: CmlNode | null = null;
    private sshClient: any = null;
    private sshStream: any = null;

    constructor(
        private apiUrl: string,
        private username?: string,
        private password?: string
    ) {
        super();
        this.state = {
            currentMode: 'PRIVILEGED_EXEC',
            hostname: 'cml-sandbox',
            prompt: 'cml-sandbox#'
        };
    }

    private async request<T = any>(
        method: string,
        path: string,
        body?: object
    ): Promise<T> {
        const base = this.apiUrl.replace(/\/$/, '');
        const url = new URL(`${base}/api/v0${path}`);

        return new Promise<T>((resolve, reject) => {
            const payload = body ? JSON.stringify(body) : undefined;
            const headers: Record<string, string> = {
                'Content-Type': 'application/json',
                'Accept': 'application/json'
            };
            if (this.token) headers['Authorization'] = `Bearer ${this.token}`;
            if (payload) headers['Content-Length'] = Buffer.byteLength(payload).toString();

            const opts: https.RequestOptions = {
                hostname: url.hostname,
                port: Number(url.port) || 443,
                path: url.pathname + url.search,
                method,
                headers,
                rejectUnauthorized: true
            };

            const req = https.request(opts, (res) => {
                let data = '';
                res.on('data', (c) => (data += c));
                res.on('end', () => {
                    if (res.statusCode && res.statusCode >= 400) {
                        return reject(new Error(
                            `CML API Error ${res.statusCode} on ${method} ${path}: ${data}`
                        ));
                    }
                    try {
                        resolve(data ? JSON.parse(data) : ({} as T));
                    } catch {
                        resolve(data as unknown as T);
                    }
                });
            });
            req.on('error', (e) => reject(e));
            if (payload) req.write(payload);
            req.end();
        });
    }

    public async connect(): Promise<void> {
        const base = this.apiUrl.replace(/\/$/, '');
        console.log(chalk.cyan(`❯ Connecting to Cisco Modeling Labs at ${chalk.bold(base)}...`));

        const raw = await this.request<string>('POST', '/authenticate', {
            username: this.username || 'admin',
            password: this.password || ''
        });
        this.token = typeof raw === 'string' ? raw : (raw as any).token || String(raw);
        console.log(chalk.green(`[+] Authenticated as ${chalk.bold(this.username || 'admin')}`));

        console.log(chalk.cyan(`❯ Scanning CML for running labs and nodes...`));
        const labIds = await this.request<string[]>('GET', '/labs');
        const runningNode = await this.findBestRunningNode(labIds || []);

        if (runningNode) {
            this.activeNode = runningNode;
            this.activeLabId = runningNode.labId;
            this.ownedLab = false;
            this.state.hostname = runningNode.label;
            this.state.prompt = `${runningNode.label}#`;
            console.log(chalk.green(
                `[+] Found running node: ${chalk.bold(runningNode.label)} ` +
                `[${runningNode.nodeDefinition}] in lab "${runningNode.labTitle}"`
            ));
            if (runningNode.mgmtIp) {
                try {
                    await this.openSsh(runningNode.mgmtIp, runningNode.mgmtPort || 22);
                    console.log(chalk.green(
                        `[+] SSH reachable at ${runningNode.label} (${runningNode.mgmtIp})`
                    ));
                } catch {
                    this.sshStream = null;
                }
            }
        } else {
            const node = await this.provisionNode();
            this.activeNode = node;
        }
    }

    private async provisionNode(): Promise<CmlNode> {
        console.log(chalk.cyan(`❯ No running nodes found — provisioning a new Cisco node on CML...`));

        const availDefs = await this.request<any[]>('GET', '/simplified_node_definitions').catch(() => []);
        const defIds = (availDefs || []).map((d: any) => d.id as string);
        const chosenDef = PREFERRED_NODE_DEFS.find(d => defIds.includes(d)) || defIds[0];

        if (!chosenDef) {
            throw new Error('No node definitions available on this CML server.');
        }

        console.log(chalk.cyan(`❯ Creating sandbox lab with node type: ${chalk.bold(chosenDef)}...`));
        const labRes = await this.request<{ id: string }>('POST', '/labs', {
            title: `ciscollm-${chosenDef}-${Date.now()}`,
            description: 'Auto-provisioned by ciscollm-cli.'
        });
        this.activeLabId = labRes.id;
        this.ownedLab = true;

        const nodeRes = await this.request<{ id: string }>('POST', `/labs/${this.activeLabId}/nodes`, {
            label: `${chosenDef}-0`,
            node_definition: chosenDef,
            x: 0,
            y: 0
        });
        const nodeId = nodeRes.id;
        console.log(chalk.cyan(`❯ Starting lab ${this.activeLabId}...`));
        await this.request('PUT', `/labs/${this.activeLabId}/start`);

        const node = await this.waitForNodeBoot(this.activeLabId, nodeId, chosenDef);
        console.log(chalk.green(`[+] Node ${chalk.bold(node.label)} is ${chalk.bold(node.state)} and ready.`));
        return node;
    }

    private async waitForNodeBoot(labId: string, nodeId: string, defId: string): Promise<CmlNode> {
        const deadline = Date.now() + NODE_BOOT_TIMEOUT_MS;
        let dots = 0;
        process.stdout.write(chalk.cyan(`❯ Waiting for node to boot`));

        while (Date.now() < deadline) {
            const node = await this.request<any>('GET', `/labs/${labId}/nodes/${nodeId}`);
            const state: string = node.state || '';
            if (state === 'BOOTED') {
                process.stdout.write(`\n`);
                const lab = await this.request<any>('GET', `/labs/${labId}`);
                const cmlNode: CmlNode = {
                    id: nodeId,
                    label: node.label || defId,
                    state,
                    nodeDefinition: defId,
                    labId,
                    labTitle: lab.title || labId
                };
                this.state.hostname = cmlNode.label;
                this.state.prompt = `${cmlNode.label}#`;
                return cmlNode;
            }
            dots++;
            process.stdout.write(chalk.dim('.'));
            await new Promise(r => setTimeout(r, NODE_BOOT_POLL_MS));
        }
        process.stdout.write(`\n`);
        throw new Error(`Node did not reach BOOTED state within ${NODE_BOOT_TIMEOUT_MS / 60000} minutes.`);
    }

    private async findBestRunningNode(labIds: string[]): Promise<CmlNode | null> {
        const candidates: CmlNode[] = [];

        for (const labId of labIds) {
            try {
                const lab = await this.request<any>('GET', `/labs/${labId}`);
                if (!lab || lab.state === 'STOPPED') continue;

                const nodeIds = await this.request<string[]>('GET', `/labs/${labId}/nodes`);
                if (!nodeIds || nodeIds.length === 0) continue;

                for (const nodeId of nodeIds) {
                    try {
                        const node = await this.request<any>('GET', `/labs/${labId}/nodes/${nodeId}`);
                        if (!node || node.state === 'STOPPED' || node.state === 'DEFINED_ON_CORE') {
                            continue;
                        }

                        const candidate: CmlNode = {
                            id: nodeId,
                            label: node.label || nodeId,
                            state: node.state || 'UNKNOWN',
                            nodeDefinition: node.node_definition || 'unknown',
                            labId,
                            labTitle: lab.title || labId
                        };

                        try {
                            const l3 = await this.request<any>(
                                'GET',
                                `/labs/${labId}/nodes/${nodeId}/layer3_addresses`
                            );
                            if (l3 && typeof l3 === 'object') {
                                const addresses = Object.values(l3) as any[];
                                for (const iface of addresses) {
                                    if (iface?.ip4 && iface.ip4.length > 0) {
                                        const ip = iface.ip4[0].split('/')[0];
                                        candidate.mgmtIp = ip;
                                        break;
                                    }
                                }
                            }
                        } catch {}

                        candidates.push(candidate);
                    } catch {}
                }
            } catch {}
        }

        if (candidates.length === 0) return null;

        const sorted = candidates.sort((a, b) => {
            const stateScore = (s: string) =>
                s === 'BOOTED' ? 3 : s === 'STARTED' ? 2 : s === 'DEFINED_ON_CORE' ? 1 : 0;
            const sd = stateScore(b.state) - stateScore(a.state);
            if (sd !== 0) return sd;
            return (b.mgmtIp ? 1 : 0) - (a.mgmtIp ? 1 : 0);
        });

        return sorted[0];
    }

    private openSsh(host: string, port: number): Promise<void> {
        return new Promise((resolve, reject) => {
            const socket = new net.Socket();
            const timeout = setTimeout(() => {
                socket.destroy();
                reject(new Error(`TCP connection to ${host}:${port} timed out`));
            }, 4000);

            socket.connect(port, host, () => {
                clearTimeout(timeout);
                socket.destroy();
                resolve();
            });
            socket.on('error', (e) => {
                clearTimeout(timeout);
                reject(e);
            });
        });
    }

    public async execute(command: string, timeoutMs = 8000): Promise<string> {
        const lower = command.toLowerCase().trim();

        if (lower === 'cml-status' || lower === 'cml status') {
            return this.getCmlStatus();
        }
        if (lower === 'cml-labs' || lower === 'cml labs') {
            return this.listLabs();
        }
        if (lower.startsWith('cml-node ') || lower.startsWith('cml node ')) {
            const nodeLabel = command.split(' ').slice(1).join(' ');
            return this.switchNode(nodeLabel);
        }
        if (lower === 'cml-topology' || lower === 'cml topology') {
            return this.getTopology();
        }

        const prompt = this.state.prompt || `${this.state.hostname}#`;
        console.log(`${chalk.blue('❯')} ${chalk.bold.yellow(prompt)} ${chalk.white(command)}`);

        if (this.activeNode?.mgmtIp && this.sshStream === null) {
            try {
                const output = await this.execViaSsh(
                    this.activeNode.mgmtIp,
                    this.activeNode.mgmtPort || 22,
                    command,
                    timeoutMs
                );
                if (output) return output;
            } catch (e: any) {
                console.log(chalk.dim(`  [SSH fallback: ${e.message}]`));
            }
        }

        if (this.activeLabId && this.activeNode) {
            try {
                const log = await this.request<string>(
                    'GET',
                    `/labs/${this.activeLabId}/nodes/${this.activeNode.id}/consoles/0/log`
                );
                const lines = (log || '').trim().split('\n');
                return lines.slice(-30).join('\n') || '';
            } catch {
                return '';
            }
        }

        return '';
    }

    private execViaSsh(
        host: string,
        port: number,
        command: string,
        timeoutMs: number
    ): Promise<string> {
        return new Promise((resolve, reject) => {
            const { spawn } = require('child_process');
            const args = [
                '-o', 'StrictHostKeyChecking=no',
                '-o', 'UserKnownHostsFile=/dev/null',
                '-o', `ConnectTimeout=${Math.ceil(timeoutMs / 1000)}`,
                '-p', String(port),
                `${this.username || 'admin'}@${host}`,
                command
            ];
            const proc = spawn('ssh', args, { env: process.env });
            let out = '';
            let err = '';
            proc.stdout.on('data', (d: Buffer) => { out += d.toString(); });
            proc.stderr.on('data', (d: Buffer) => { err += d.toString(); });

            const timer = setTimeout(() => {
                proc.kill();
                resolve(out || '');
            }, timeoutMs);

            proc.on('close', () => {
                clearTimeout(timer);
                if (out) resolve(out);
                else if (err && !err.includes('Warning:')) reject(new Error(err.trim()));
                else resolve('');
            });
        });
    }

    private async getCmlStatus(): Promise<string> {
        if (!this.activeLabId) {
            return JSON.stringify({ status: 'not_connected', mode: 'config-only' });
        }
        try {
            const lab = await this.request<any>('GET', `/labs/${this.activeLabId}`);
            const stats = await this.request<any>(
                'GET', `/labs/${this.activeLabId}/simulation_stats`
            ).catch(() => null);
            return JSON.stringify({
                status: lab.state,
                lab_id: this.activeLabId,
                title: lab.title,
                node: this.activeNode
                    ? { id: this.activeNode.id, label: this.activeNode.label, state: this.activeNode.state }
                    : null,
                stats
            }, null, 2);
        } catch (e: any) {
            return JSON.stringify({ error: e.message });
        }
    }

    private async listLabs(): Promise<string> {
        try {
            const labIds = await this.request<string[]>('GET', '/labs');
            const details = await Promise.all(
                (labIds || []).map(async (id) => {
                    try {
                        const lab = await this.request<any>('GET', `/labs/${id}`);
                        const nodes = await this.request<string[]>('GET', `/labs/${id}/nodes`);
                        return { id, title: lab.title, state: lab.state, nodeCount: (nodes || []).length };
                    } catch {
                        return { id, error: 'fetch_failed' };
                    }
                })
            );
            return JSON.stringify(details, null, 2);
        } catch (e: any) {
            return JSON.stringify({ error: e.message });
        }
    }

    private async switchNode(label: string): Promise<string> {
        if (!this.activeLabId) return JSON.stringify({ error: 'no_lab_connected' });
        try {
            const result = await this.request<any>(
                'GET',
                `/labs/${this.activeLabId}/find/node/label/${encodeURIComponent(label)}`
            );
            if (result && result.node_id) {
                const node = await this.request<any>(
                    'GET', `/labs/${this.activeLabId}/nodes/${result.node_id}`
                );
                this.activeNode = {
                    id: result.node_id,
                    label: node.label,
                    state: node.state,
                    nodeDefinition: node.node_definition,
                    labId: this.activeLabId,
                    labTitle: ''
                };
                this.state.hostname = node.label;
                this.state.prompt = `${node.label}#`;
                return JSON.stringify({ switched_to: node.label, node_id: result.node_id });
            }
            return JSON.stringify({ error: `Node "${label}" not found` });
        } catch (e: any) {
            return JSON.stringify({ error: e.message });
        }
    }

    private async getTopology(): Promise<string> {
        if (!this.activeLabId) return JSON.stringify({ error: 'no_lab_connected' });
        try {
            const topology = await this.request<any>(
                'GET', `/labs/${this.activeLabId}/topology`
            );
            return JSON.stringify(topology, null, 2);
        } catch (e: any) {
            return JSON.stringify({ error: e.message });
        }
    }

    public async disconnect(): Promise<void> {
        if (this.activeLabId && this.ownedLab) {
            try {
                console.log(chalk.cyan(`❯ Deleting sandbox lab ${this.activeLabId}...`));
                await this.request('DELETE', `/labs/${this.activeLabId}`);
                console.log(chalk.green(`[+] Sandbox lab deleted cleanly.`));
            } catch (e: any) {
                console.warn(chalk.yellow(`[!] Could not delete lab: ${e.message}`));
            }
        } else if (this.activeLabId && !this.ownedLab) {
            console.log(chalk.dim(
                `  Leaving external lab ${this.activeLabId} intact (not owned by this session).`
            ));
        }
        this.activeLabId = null;

        if (this.token) {
            try {
                await this.request('DELETE', '/logout');
                console.log(chalk.green(`[+] Logged out from CML successfully.`));
            } catch {}
            this.token = null;
        }
    }
}
