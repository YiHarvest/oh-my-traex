import { acknowledgeMailboxMessage } from '../../src/team/state.js';

const [stateDir, workerName, messageId] = process.argv.slice(2);
if (stateDir && workerName && messageId) {
  process.stdout.write(`${JSON.stringify(acknowledgeMailboxMessage(stateDir, workerName, messageId))}\n`);
}
