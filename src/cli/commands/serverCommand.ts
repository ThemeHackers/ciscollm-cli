import { startSimulator } from '../../server';

export function serverAction(options: any) {
    const sshPort = parseInt(options.sshPort, 10);
    const telnetPort = parseInt(options.telnetPort, 10);
    const httpPort = parseInt(options.httpPort, 10);
    startSimulator({ sshPort, telnetPort, httpPort });
}
