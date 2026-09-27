/**
 * 播放器：什么时候**不许**碰 AudioContext（M4.2 的验收核心）。
 *
 * 浏览器自动播放策略下，在没有用户手势的时机创建 / 播放 AudioContext，表现是
 * 控制台一条警告（Chrome）或者干脆静音且状态停在 `suspended`（iOS Safari）。
 * 这一层的三条规矩都是为了那两条：
 *
 * 1. 没解锁过就一声都不放，连上下文都不建 ——「首次加载不触发警告」；
 * 2. 上下文只建一枚，全程复用；`suspended` 时才 `resume()`；
 * 3. 只认「解锁」这一个开关。
 *
 * 第 3 条值得单独说一句：**这里没有静音的份**。要不要出声是策略，由
 * `state/SoundContext.tsx` 决定，静音时它根本不会调到这里来，于是
 * 「静音连上下文都不建」这条保证天然成立，不必在这一层再判一次。
 *
 * 另两条是"别把界面搞挂"：不支持 Web Audio（老浏览器、被策略拦了）时静默退化，
 * `resume()` 被拒时不许漏出未处理的 promise rejection。
 */

import { describe, expect, it, vi } from 'vitest';

import { createSoundPlayer } from '../src/sound/player';
import type { SoundAudioContext } from '../src/sound/synth';

import { FakeAudio } from './fakeAudio';

function harness(options: { supported?: boolean; throws?: boolean } = {}) {
  const contexts: FakeAudio[] = [];
  let opens = 0;
  const player = createSoundPlayer({
    openAudioContext: (): SoundAudioContext | null => {
      opens += 1;
      if (options.throws === true) throw new Error('构造被拒');
      if (options.supported === false) return null;
      const audio = new FakeAudio();
      contexts.push(audio);
      return audio;
    },
  });
  return { player, contexts, opens: () => opens };
}

describe('音效播放器 · 自动播放策略', () => {
  it('解锁之前 play 连上下文都不建（首次加载不许触发浏览器警告）', () => {
    const f = harness();
    f.player.play('deal');
    f.player.play('turn');
    expect(f.opens()).toBe(0);
    expect(f.contexts).toHaveLength(0);
  });

  it('解锁之后才建，且全程只建一枚', () => {
    const f = harness();
    f.player.unlock();
    f.player.play('deal');
    f.player.play('chip');
    f.player.play('win');
    expect(f.opens()).toBe(1);
    expect(f.contexts).toHaveLength(1);
    expect(f.contexts[0]?.oscillators.length).toBeGreaterThan(0);
  });

  it('解锁本身就是那个手势：这时才 resume 挂起的上下文', () => {
    const audio = new FakeAudio();
    audio.state = 'suspended';
    const player = createSoundPlayer({ openAudioContext: () => audio });
    player.unlock();
    expect(audio.resumes).toBe(1);
  });

  it('切后台又挂起时，下一次播放会再试着唤醒它', () => {
    const f = harness();
    f.player.unlock();
    const audio = f.contexts[0];
    if (!audio) throw new Error('没有建出上下文');
    audio.state = 'suspended';
    f.player.play('turn');
    expect(audio.resumes).toBe(1);
  });

  it('已经是 running 就不重复 resume，但也照常出声', () => {
    const f = harness();
    f.player.unlock();
    f.player.unlock();
    f.player.play('board');
    expect(f.contexts[0]?.resumes).toBe(0);
    expect(f.contexts[0]?.oscillators).toHaveLength(2);
  });

  it('resume() 被拒不漏出未处理的 promise rejection', async () => {
    const audio = new FakeAudio();
    audio.state = 'suspended';
    audio.resumeMode = 'reject';
    const player = createSoundPlayer({ openAudioContext: () => audio });
    expect(() => player.unlock()).not.toThrow();
    expect(() => player.play('win')).not.toThrow();
    await Promise.resolve();
    await Promise.resolve();
  });
});

describe('音效播放器 · 降级', () => {
  it('浏览器不支持 Web Audio 时静默退化，而且只试一次', () => {
    const f = harness({ supported: false });
    f.player.unlock();
    expect(() => f.player.play('turn')).not.toThrow();
    f.player.play('win');
    f.player.unlock();
    expect(f.opens()).toBe(1);
  });

  it('构造上下文抛错（iOS 名额用尽）也不冒到 React 事件处理里', () => {
    const f = harness({ throws: true });
    expect(() => f.player.unlock()).not.toThrow();
    expect(() => f.player.play('deal')).not.toThrow();
    expect(f.opens()).toBe(1);
  });
});

describe('音效播放器 · 取浏览器给的构造函数', () => {
  it('有 AudioContext 就用它', async () => {
    const { openAudioContext } = await import('../src/sound/browser');
    class Standard extends FakeAudio {}
    vi.stubGlobal('AudioContext', Standard);
    const opened = openAudioContext();
    expect(opened).toBeInstanceOf(Standard);
    vi.unstubAllGlobals();
  });

  it('只有带 webkit 前缀的那个名字（旧版 iOS Safari）也要能出声', async () => {
    const { openAudioContext } = await import('../src/sound/browser');
    class Webkit extends FakeAudio {}
    vi.stubGlobal('AudioContext', undefined);
    vi.stubGlobal('webkitAudioContext', Webkit);
    const opened = openAudioContext();
    expect(opened).toBeInstanceOf(Webkit);
    vi.unstubAllGlobals();
  });

  it('两个名字都没有就返回 null，不猜也不抛', async () => {
    const { openAudioContext } = await import('../src/sound/browser');
    vi.stubGlobal('AudioContext', undefined);
    vi.stubGlobal('webkitAudioContext', undefined);
    expect(openAudioContext()).toBeNull();
    vi.unstubAllGlobals();
  });
});
