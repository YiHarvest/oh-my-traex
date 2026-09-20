import { existsSync, writeFileSync } from 'node:fs';
import { withStateLock } from '../../src/team/state.js';

const [stateDir, recordName, readyPath, releasePath, publishReadyPath, publishReleasePath] = process.argv.slice(2);
if (stateDir && recordName && readyPath && releasePath) {
  withStateLock(stateDir, recordName, () => {
    writeFileSync(readyPath, String(process.pid));
    while (!existsSync(releasePath)) {
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
    }
  }, {
    beforePublish: publishReadyPath && publishReleasePath ? () => {
      writeFileSync(publishReadyPath, String(process.pid));
      while (!existsSync(publishReleasePath)) {
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
      }
    } : undefined,
  });
}
