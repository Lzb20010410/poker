/**
 * 配对码的**本进程预留表**。
 *
 * 这里测的是"锁"本身，不起服务端、不占端口：`isPairingCodeTaken` 走 matchMaker，
 * 是异步的，所以两个 `onCreate` 会各自看到"这码没人用"（典型的 TOCTOU）。
 * 预留表把「占位」挪到 `await` 之前，Node 单线程里同步读写就是原子的。
 *
 * 跨进程的同一码仍要靠部署层（见 PROGRESS.md 遗留问题），本表只管本进程。
 */
import { describe, expect, it } from 'vitest';

import {
  isPairingCodeReserved,
  PAIRING_RESERVATION,
  releasePairingCode,
  reservePairingCode,
} from '../src/rooms/pairingReservation';

describe('reservePairingCode / releasePairingCode', () => {
  it('第一次占位成功，第二次同一码失败', () => {
    expect(reservePairingCode('KPHAAA')).toBe(true);
    expect(reservePairingCode('KPHAAA')).toBe(false);
    expect(isPairingCodeReserved('KPHAAA')).toBe(true);
    releasePairingCode('KPHAAA');
  });

  it('释放后可以再占，且释放是幂等的（重复释放、释放没占过的都不抛错）', () => {
    expect(reservePairingCode('KPHBAA')).toBe(true);
    expect(() => releasePairingCode('KPHBAA')).not.toThrow();
    expect(() => releasePairingCode('KPHBAA')).not.toThrow();
    expect(() => releasePairingCode('KPHCAA')).not.toThrow();
    expect(isPairingCodeReserved('KPHBAA')).toBe(false);
    expect(reservePairingCode('KPHBAA')).toBe(true);
    releasePairingCode('KPHBAA');
  });

  it('释放只归还自己那个码，不会把别人的码一起解掉', () => {
    expect(reservePairingCode('KPHDAA')).toBe(true);
    expect(reservePairingCode('KPHEAA')).toBe(true);
    releasePairingCode('KPHDAA');
    expect(isPairingCodeReserved('KPHDAA')).toBe(false);
    expect(isPairingCodeReserved('KPHEAA')).toBe(true);
    releasePairingCode('KPHEAA');
  });

  it('导出给 shared 的 reservation 适配器直接复用同一张表', () => {
    expect(PAIRING_RESERVATION.reserve('KPHFAA')).toBe(true);
    expect(PAIRING_RESERVATION.reserve('KPHFAA')).toBe(false);
    expect(isPairingCodeReserved('KPHFAA')).toBe(true);
    PAIRING_RESERVATION.release('KPHFAA');
    expect(isPairingCodeReserved('KPHFAA')).toBe(false);
  });
});
