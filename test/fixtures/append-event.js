import { appendTeamEvent } from '../../src/team/events.js';

const [stateDir, index] = process.argv.slice(2);
if (stateDir) process.stdout.write(`${JSON.stringify(appendTeamEvent(stateDir, 'stress.event', { actor: `writer-${index}` }))}\n`);
