import * as readline from 'readline';
import chalk from 'chalk';
import { readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { DESTRUCTIVE_TOKENS, DEFAULT_PROTECTED_INTERFACES } from '../../shared/constants';
import { parseSimpleYaml } from '../../shared/utils';

export class CommandFirewall {
    private protectedInterfaces: string[];
    private playbook: any = null;

    constructor(protectedInterfaces: string[] = DEFAULT_PROTECTED_INTERFACES) {
        this.protectedInterfaces = protectedInterfaces.map(i => i.toLowerCase().trim());
        
        try {
            const yamlPath = join(process.cwd(), '.ciscollm-guard.yaml');
            if (existsSync(yamlPath)) {
                const content = readFileSync(yamlPath, 'utf8');
                this.playbook = parseSimpleYaml(content);
                console.log(chalk.green(`[+] Loaded custom safety playbook from .ciscollm-guard.yaml`));
                
                if (this.playbook && Array.isArray(this.playbook.protectedInterfaces)) {
                    this.playbook.protectedInterfaces.forEach((intf: string) => {
                        const normalizedIntf = intf.toLowerCase().trim();
                        if (!this.protectedInterfaces.includes(normalizedIntf)) {
                            this.protectedInterfaces.push(normalizedIntf);
                        }
                    });
                }
            }
        } catch (e: any) {
            console.warn(chalk.yellow(`[!] Warning loading safety playbook: ${e.message}`));
        }
    }

    
    public checkCommand(command: string, currentInterfaceContext: string | null): { dangerous: boolean; reason?: string } {
        const normalized = command.toLowerCase().trim();

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

        const interfaceMatch = /^interface\s+([A-Za-z0-9\/\.\-]+)/i.exec(command.trim());
        if (interfaceMatch) {
            const targetedInterface = interfaceMatch[1].toLowerCase().trim();
            
            if (this.isProtected(targetedInterface) && normalized.includes('shutdown') && !normalized.includes('no shutdown')) {
                return {
                    dangerous: true,
                    reason: `Attempting to shutdown protected management interface: ${interfaceMatch[1]}`
                };
            }
        }

        if (currentInterfaceContext) {
            const activeIntf = currentInterfaceContext.toLowerCase().trim();
            if (this.isProtected(activeIntf)) {
                if (normalized === 'shutdown') {
                    return {
                        dangerous: true,
                        reason: `Cannot shutdown active protected management interface: ${currentInterfaceContext}`
                    };
                }
                if (normalized.startsWith('no ip address') || normalized.startsWith('no ip add')) {
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
        return this.protectedInterfaces.some(p => 
            p === interfaceName || 
            interfaceName.startsWith(p) || 
            p.startsWith(interfaceName)
        );
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
