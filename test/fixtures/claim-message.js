import { claimTaskMessage } from '../../src/team/state.js';

const [stateDir, workerName, messageId] = process.argv.slice(2);
if (stateDir && workerName && messageId) {
  process.stdout.write(`${JSON.stringify(claimTaskMessage(stateDir, workerName, messageId))}\n`);
}
