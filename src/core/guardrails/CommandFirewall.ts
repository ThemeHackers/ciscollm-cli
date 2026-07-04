import * as readline from 'readline';
import chalk from 'chalk';
import { readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { DESTRUCTIVE_TOKENS, DEFAULT_PROTECTED_INTERFACES } from '../../shared/constants';
import { parseSimpleYaml } from '../../shared/utils';

export class CommandFirewall {
    private protectedInterfaces: string[] = [];
    private playbook: any = null;

    constructor(protectedInterfaces?: string[]) {
        if (protectedInterfaces) {
            this.protectedInterfaces = protectedInterfaces.map(i => i.toLowerCase().trim());
            this.playbook = { protectedInterfaces };
        }
        
        try {
            const yamlPath = join(process.cwd(), '.ciscollm-guard.yaml');
            if (existsSync(yamlPath)) {
                const content = readFileSync(yamlPath, 'utf8');
                this.playbook = parseSimpleYaml(content) || {};
                console.log(chalk.green(`[+] Loaded custom safety playbook from .ciscollm-guard.yaml`));
                
                if (this.playbook && Array.isArray(this.playbook.protectedInterfaces)) {
                    this.playbook.protectedInterfaces.forEach((intf: string) => {
                        const normalizedIntf = intf.toLowerCase().trim();
                        if (!this.protectedInterfaces.includes(normalizedIntf)) {
                            this.protectedInterfaces.push(normalizedIntf);
                        }
                    });
                }
            } else if (!protectedInterfaces) {
                this.playbook = null;
            }
        } catch (e: any) {
            console.warn(chalk.yellow(`[!] Warning loading safety playbook: ${e.message}`));
        }
    }

    
    public static normalizeCiscoCommand(command: string): string {
        const trimmed = command.trim();
        const parts = trimmed.split(/\s+/);
        if (parts.length === 0 || !parts[0]) return trimmed;

        const firstToken = parts[0].toLowerCase();

       
        if (firstToken === 'no' && parts.length > 1) {
            const subNormalized = CommandFirewall.normalizeCiscoCommand(parts.slice(1).join(' '));
            return `no ${subNormalized}`;
        }

        
        if (firstToken.startsWith('conf') && 'configure'.startsWith(firstToken)) {
            if (parts[1] && parts[1].toLowerCase().startsWith('t') && 'terminal'.startsWith(parts[1].toLowerCase())) {
                return 'configure terminal';
            }
            parts[0] = 'configure';
        } else if (firstToken.startsWith('int') && 'interface'.startsWith(firstToken)) {
            parts[0] = 'interface';
            if (parts[1]) {
                parts[1] = CommandFirewall.normalizeInterfaceName(parts[1]);
            }
        } else if (firstToken.startsWith('shut') && 'shutdown'.startsWith(firstToken)) {
            parts[0] = 'shutdown';
        } else if (firstToken.startsWith('desc') && 'description'.startsWith(firstToken)) {
            parts[0] = 'description';
        } else if (firstToken.startsWith('cry') && 'crypto'.startsWith(firstToken)) {
            parts[0] = 'crypto';
            if (parts[1] && parts[1].toLowerCase().startsWith('ke') && 'key'.startsWith(parts[1].toLowerCase())) {
                parts[1] = 'key';
                if (parts[2] && parts[2].toLowerCase().startsWith('ze') && 'zeroize'.startsWith(parts[2].toLowerCase())) {
                    parts[2] = 'zeroize';
                }
            }
        } else if (firstToken.startsWith('wr') && 'write'.startsWith(firstToken)) {
            parts[0] = 'write';
            if (parts[1] && parts[1].toLowerCase().startsWith('er') && 'erase'.startsWith(parts[1].toLowerCase())) {
                parts[1] = 'erase';
            }
        } else if (firstToken.startsWith('er') && 'erase'.startsWith(firstToken)) {
            parts[0] = 'erase';
        } else if (firstToken.startsWith('reload') && 'reload'.startsWith(firstToken)) {
            parts[0] = 'reload';
        } else if (firstToken === 'ip') {
            if (parts[1] && parts[1].toLowerCase().startsWith('add') && 'address'.startsWith(parts[1].toLowerCase())) {
                parts[1] = 'address';
            } else if (parts[1] && parts[1].toLowerCase().startsWith('access-g') && 'access-group'.startsWith(parts[1].toLowerCase())) {
                parts[1] = 'access-group';
            } else if (parts[1] && parts[1].toLowerCase().startsWith('access-l') && 'access-list'.startsWith(parts[1].toLowerCase())) {
                parts[1] = 'access-list';
            }
        } else if (firstToken === 'aaa') {
            if (parts[1] && parts[1].toLowerCase().startsWith('new') && 'new-model'.startsWith(parts[1].toLowerCase())) {
                parts[1] = 'new-model';
            }
        } else if (firstToken === 'feature') {
            const rest = parts.slice(1).join(' ').toLowerCase();
            if (rest === 'nv-overlay' || rest === 'nv_overlay') {
                return 'feature nv overlay';
            }
        }

        return parts.join(' ');
    }

    public static normalizeInterfaceName(name: string): string {
        const lower = name.toLowerCase();
        if (lower.startsWith('gi') && !lower.startsWith('gigabitethernet')) {
            return 'gigabitethernet' + name.substring(2);
        }
        if (lower.startsWith('fa') && !lower.startsWith('fastethernet')) {
            return 'fastethernet' + name.substring(2);
        }
        if (lower.startsWith('te') && !lower.startsWith('tengigabitethernet')) {
            return 'tengigabitethernet' + name.substring(2);
        }
        if (lower.startsWith('vl') && !lower.startsWith('vlan')) {
            return 'vlan' + name.substring(2);
        }
        if (lower.startsWith('lo') && !lower.startsWith('loopback')) {
            return 'loopback' + name.substring(2);
        }
        if (lower.startsWith('eth') && !lower.startsWith('ethernet')) {
            return 'ethernet' + name.substring(3);
        }
        if (lower.startsWith('po') && !lower.startsWith('port-channel')) {
            return 'port-channel' + name.substring(2);
        }
        if (lower.startsWith('nv') && !lower.startsWith('nve')) {
            return 'nve' + name.substring(2);
        }
        return name;
    }

    public checkCommand(command: string, currentInterfaceContext: string | null): { dangerous: boolean; reason?: string } {
        if (!this.playbook) {
            return { dangerous: false };
        }

        const normalizedCommand = CommandFirewall.normalizeCiscoCommand(command);
        const normalized = normalizedCommand.toLowerCase().trim();

        if (this.playbook) {
            if (Array.isArray(this.playbook.blockedCommands)) {
                const isBlocked = this.playbook.blockedCommands.some((blocked: string) => 
                    normalized === blocked.toLowerCase().trim() || normalized.includes(blocked.toLowerCase().trim())
                );
                if (isBlocked) {
                    return {
                        dangerous: true,
                        reason: `Command is strictly blocked by the custom safety playbook (.ciscollm-guard.yaml).`
                    };
                }
            }

            if (Array.isArray(this.playbook.requireConfirmationCommands)) {
                const requiresConfirm = this.playbook.requireConfirmationCommands.some((cmd: string) => 
                    normalized === cmd.toLowerCase().trim() || normalized.includes(cmd.toLowerCase().trim())
                );
                if (requiresConfirm) {
                    return {
                        dangerous: true,
                        reason: `Command requires administrator confirmation according to safety playbook (.ciscollm-guard.yaml).`
                    };
                }
            }
        }

        if (normalized.startsWith('no ip route 0.0.0.0') || normalized.startsWith('no ip route 0.0.0.0 0.0.0.0')) {
            return {
                dangerous: true,
                reason: 'Attempting to remove the default static route (0.0.0.0/0) which may sever SSH/telnet connectivity.'
            };
        }

        if (normalized.startsWith('no aaa new-model') || normalized.startsWith('crypto key zeroize')) {
            return {
                dangerous: true,
                reason: 'Attempting to disable AAA security or zeroize crypto keys, which can lock out admin access.'
            };
        }

        if (normalized.startsWith('no access-list') || normalized.startsWith('no ip access-group')) {
            return {
                dangerous: true,
                reason: 'Attempting to remove or disable an access-list which could expose or lock the management interface.'
            };
        }

        const matchedDestructive = DESTRUCTIVE_TOKENS.find(token => 
            normalized.startsWith(token) || normalized.includes(` ${token}`)
        );
        if (matchedDestructive) {
            return { 
                dangerous: true, 
                reason: `Destructive keyword detected ("${matchedDestructive}")` 
            };
        }

        const interfaceMatch = /^interface\s+([A-Za-z0-9\/\.\-]+)/i.exec(normalizedCommand);
        if (interfaceMatch) {
            const targetedInterface = CommandFirewall.normalizeInterfaceName(interfaceMatch[1]).toLowerCase().trim();
            
            if (this.isProtected(targetedInterface) && normalized.includes('shutdown') && !normalized.includes('no shutdown')) {
                return {
                    dangerous: true,
                    reason: `Attempting to shutdown protected management interface: ${interfaceMatch[1]}`
                };
            }
        }

        if (currentInterfaceContext) {
            const activeIntf = CommandFirewall.normalizeInterfaceName(currentInterfaceContext).toLowerCase().trim();
            if (this.isProtected(activeIntf)) {
                if (normalized === 'shutdown') {
                    return {
                        dangerous: true,
                        reason: `Cannot shutdown active protected management interface: ${currentInterfaceContext}`
                    };
                }
                if (normalized.startsWith('no ip address')) {
                    return {
                        dangerous: true,
                        reason: `Cannot remove IP address configuration from protected interface: ${currentInterfaceContext}`
                    };
                }
            }
        }

        return { dangerous: false };
    }

    private isProtected(interfaceName: string): boolean {
        const normalizedTarget = CommandFirewall.normalizeInterfaceName(interfaceName).toLowerCase().trim();
        return this.protectedInterfaces.some(p => {
            const normalizedP = CommandFirewall.normalizeInterfaceName(p).toLowerCase().trim();
            return normalizedP === normalizedTarget || 
                   normalizedTarget.startsWith(normalizedP) || 
                   normalizedP.startsWith(normalizedTarget);
        });
    }

    public async verifyWithHuman(command: string, reason: string): Promise<boolean> {
        const isNonInteractive = process.env.CISCOLLM_NON_INTERACTIVE === 'true';
        if (isNonInteractive) {
            console.warn('\n' + chalk.bold.red(`[GUARDRAIL BLOCK]: Non-interactive mode active. Automatically rejecting high-risk command: "${command}"`));
            console.warn(`- Protection Rule Match:      ${chalk.cyan(reason)}\n`);
            return false;
        }

        const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
        
        return new Promise((resolve) => {
            console.warn('\n' + chalk.bold.red('[GUARDRAIL WARNING]: High-Risk Command Blocked'));
            console.warn(chalk.bold.red('============================================================'));
            console.warn(`- The Agent requested to run: ${chalk.bold.yellow(`"${command}"`)}`);
            console.warn(`- Protection Rule Match:      ${chalk.cyan(reason)}`);
            console.warn(chalk.bold.red('============================================================'));
            
            rl.question(chalk.bold.white('Do you want to authorize the execution of this command? (y/N): '), (answer) => {
                rl.close();
                console.log('');
                resolve(answer.toLowerCase() === 'y');
            });
        });
    }
}
