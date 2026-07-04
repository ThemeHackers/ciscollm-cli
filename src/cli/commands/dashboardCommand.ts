import chalk from 'chalk';
import { MultiAgentCoordinator } from '../../core/agent/MultiAgentCoordinator';
import { startDashboardServer } from '../../server/dashboard';

export function dashboardAction(options: any) {
    const port = parseInt(options.port, 10);
    const coordinator = new MultiAgentCoordinator();
    startDashboardServer(coordinator, port);
    console.log(chalk.yellow('Standalone mode: Visualizing historical records and active topology when connected.'));
}
