import { expect, it } from 'vitest';
import * as shared from '../src';

it('exports the complete authoritative table API from shared', () => {
  for (const name of [
    'createTable',
    'startHand',
    'applyAction',
    'applyPlayerAction',
    'getTableLegalActions',
    'tickTable',
    'getTimeoutWarning',
    'addTablePlayer',
    'sitPlayer',
    'standPlayer',
    'setPlayerPresence',
    'rebuyPlayer',
    'setTableConfig',
    'startTable',
    'getPrivateMessages',
  ]) {
    expect(Reflect.get(shared, name), name).toBeTypeOf('function');
  }
});
