import { SwitchDevice } from '../../server/devices/SwitchDevice';
import { logger } from '../../cli/ui/ui';
import chalk from 'chalk';

export class DigitalTwin {
    private simulator: SwitchDevice;

    constructor(initialHostname: string = 'Switch1') {
        this.simulator = new SwitchDevice();

        this.simulator.hostname = initialHostname;
        this.simulator.mode = 'PRIVILEGED_EXEC';
    }

  
    public async preFlightCheck(commands: string[]): Promise<{ success: boolean; errorIndex: number; output: string }> {
        logger.info(chalk.magenta(`[Digital Twin] Starting Pre-Flight Check for ${commands.length} commands...`));
        let fullOutput = '';
        
        for (let i = 0; i < commands.length; i++) {
            const cmd = commands[i].trim();
            if (!cmd) continue;

            const out = this.simulator.processCommand(cmd);
            fullOutput += `> ${cmd}\n${out}\n`;

          
            if (out.includes('% Invalid input detected') || 
                out.includes('% Incomplete command') ||
                out.includes('% Command rejected')) {
                logger.warn(chalk.red(`[Digital Twin] Pre-Flight Failed at command: "${cmd}"`));
                return { success: false, errorIndex: i, output: fullOutput };
            }
        }

        logger.info(chalk.green(`[Digital Twin] Pre-Flight Check Passed!`));
        return { success: true, errorIndex: -1, output: fullOutput };
    }

    public getSimulatorState(): string {
        return `Mode: ${this.simulator.mode}, Interfaces: ${this.simulator.interfaces.size}, VLANs: ${this.simulator.vlans.size}`;
    }
}
