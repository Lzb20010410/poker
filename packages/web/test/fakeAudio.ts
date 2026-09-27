/**
 * 一只假的 Web Audio 图，用来证明合成器**到底排了些什么**。
 *
 * jsdom 完全没有 Web Audio（`window.AudioContext` 是 `undefined`），所以想验「五个音效
 * 各自的声音怎么排出来」只有两条路：注入假上下文，或者不测。这里选注入，而且要的不是
 * 「调用了几次」这种弱断言——包络写错（指数斜坡目标给成 0）、图没接到 `destination`，
 * 在真浏览器里分别是**抛异常**和**一点声音都没有**，界面上都看不出来，只能在这里钉住。
 *
 * 这些类都 `implements` 产物侧的接口：接口一改这里立刻编译不过，
 * 不会出现「假件还在配合旧实现」的假绿。
 */

import type {
  SoundAudioContext,
  SoundBiquad,
  SoundGain,
  SoundNode,
  SoundOscillator,
  SoundParam,
} from '../src/sound/synth';

/** 一次参数自动化：`kind` 是 set / linear / exp，后面跟着目标值和时刻（秒） */
export type ParamCall = readonly [kind: string, value: number, time: number];

class FakeParam implements SoundParam {
  readonly calls: ParamCall[] = [];

  setValueAtTime(value: number, startTime: number): void {
    this.calls.push(['set', value, startTime]);
  }

  linearRampToValueAtTime(value: number, endTime: number): void {
    this.calls.push(['linear', value, endTime]);
  }

  exponentialRampToValueAtTime(value: number, endTime: number): void {
    this.calls.push(['exp', value, endTime]);
  }
}

class FakeNode implements SoundNode {
  readonly connections: SoundNode[] = [];

  connect(target: SoundNode): void {
    this.connections.push(target);
  }
}

export class FakeOscillator extends FakeNode implements SoundOscillator {
  readonly frequency = new FakeParam();
  type: OscillatorType = 'sine';
  readonly starts: number[] = [];
  readonly stops: number[] = [];

  start(when: number): void {
    this.starts.push(when);
  }

  stop(when: number): void {
    this.stops.push(when);
  }
}

export class FakeGain extends FakeNode implements SoundGain {
  readonly gain = new FakeParam();
}

export class FakeFilter extends FakeNode implements SoundBiquad {
  readonly frequency = new FakeParam();
  readonly Q = new FakeParam();
  type: BiquadFilterType = 'lowpass';
}

export class FakeAudio implements SoundAudioContext {
  readonly oscillators: FakeOscillator[] = [];
  readonly gains: FakeGain[] = [];
  readonly filters: FakeFilter[] = [];
  readonly destination = new FakeNode();
  currentTime = 0;
  state: AudioContextState = 'running';
  resumes = 0;
  /** `'reject'` 用来模拟 iOS 上 `resume()` 被拒（切后台、手势已过期） */
  resumeMode: 'ok' | 'reject' = 'ok';

  createOscillator(): FakeOscillator {
    const node = new FakeOscillator();
    this.oscillators.push(node);
    return node;
  }

  createGain(): FakeGain {
    const node = new FakeGain();
    this.gains.push(node);
    return node;
  }

  createBiquadFilter(): FakeFilter {
    const node = new FakeFilter();
    this.filters.push(node);
    return node;
  }

  resume(): Promise<void> {
    this.resumes += 1;
    if (this.resumeMode === 'reject') return Promise.reject(new Error('resume 被拒'));
    this.state = 'running';
    return Promise.resolve();
  }

  /** 图里出现过的所有参数（扫全局不变式用） */
  params(): FakeParam[] {
    const list: FakeParam[] = [];
    for (const osc of this.oscillators) list.push(osc.frequency);
    for (const gain of this.gains) list.push(gain.gain);
    for (const filter of this.filters) list.push(filter.frequency, filter.Q);
    return list;
  }

  /** 从某个节点出发能否走到输出端。接错一根线就是「代码在跑、声音没有」 */
  reachesDestination(from: SoundNode): boolean {
    const seen = new Set<SoundNode>();
    const walk = (node: SoundNode): boolean => {
      if (node === this.destination) return true;
      if (seen.has(node)) return false;
      seen.add(node);
      return (node as FakeNode).connections.some(walk);
    };
    return walk(from);
  }
}
