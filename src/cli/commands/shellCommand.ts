import readline from 'readline';
import chalk from 'chalk';
import { ShellSimulator } from '../../server/shell-simulator';

export function shellAction() {
    const simulator = new ShellSimulator();
    
    console.clear();
    console.log(chalk.bold.yellow('============================================================'));
    console.log(chalk.bold.yellow('   Cisco IOS Interactive Mock Shell Simulator (v1.1.0)'));
    console.log(chalk.bold.yellow('============================================================'));
    const welcomeBanner = `\r\nCisco IOS Software, C2960 Software (C2960-LANBASEK9-M), Version 15.0(2)SE4, RELEASE SOFTWARE (fc1)\r\nTechnical Support: http://www.cisco.com/techsupport\r\nCopyright (c) 1986-2013 by Cisco Systems, Inc.\r\nCompiled Wed 26-Jun-13 02:49 by prod_rel_team\r\n\r\n`;
    console.log(welcomeBanner);

    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

    const promptUser = () => {
        rl.question(simulator.getPrompt(), (line: string) => {
            const cmd = line.trim();
            if (cmd.toLowerCase() === 'exit' && simulator.mode === 'USER_EXEC') {
                console.log('Connection closed by foreign host.');
                rl.close();
                return;
            }

            try {
                const output = simulator.execute(cmd);
                if (output) {
                    console.log(output);
                }
            } catch (err: any) {
                console.log(`% Error: ${err.message}`);
            }
            promptUser();
        });
    };

    promptUser();

    rl.on('close', () => {
        process.exit(0);
    });
}
