import * as readline from 'readline';
import chalk from 'chalk';
import { DESTRUCTIVE_TOKENS, DEFAULT_PROTECTED_INTERFACES } from '../../shared/constants';

export class CommandFirewall {
    private protectedInterfaces: string[];

    constructor(protectedInterfaces: string[] = DEFAULT_PROTECTED_INTERFACES) {
        this.protectedInterfaces = protectedInterfaces.map(i => i.toLowerCase().trim());
    }

    
    public checkCommand(command: string, currentInterfaceContext: string | null): { dangerous: boolean; reason?: string } {
        const normalized = command.toLowerCase().trim();

        
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
            
            if (this.isProtected(targetedInterface) && normalized.includes('shutdown')) {
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
        const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
        
        return new Promise((resolve) => {
            console.warn('\n' + chalk.bold.red('⚠️  [GUARDRAIL WARNING]: High-Risk Command Blocked'));
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
