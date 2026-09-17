import { existsSync, writeFileSync } from 'node:fs';
import { withStateLock } from '../../src/team/state.js';

const [stateDir, recordName, readyPath, releasePath] = process.argv.slice(2);
if (stateDir && recordName && readyPath && releasePath) {
  withStateLock(stateDir, recordName, () => {
    writeFileSync(readyPath, String(process.pid));
    while (!existsSync(releasePath)) {
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
    }
  });
}
