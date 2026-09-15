import { claimTeamTask } from '../../src/team/state.js';

const [stateDir, taskId, workerName] = process.argv.slice(2);
if (stateDir && taskId && workerName) {
  process.stdout.write(JSON.stringify(claimTeamTask(stateDir, taskId, workerName)));
}
