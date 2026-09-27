/**
 * 五个音效的合成表与调度（M4.2）。
 *
 * 这里没有一行是「听着像」——耳朵不在 CI 里。所以断言全部落在**会真出故障**的不变式上：
 *
 * - 图必须通到 `destination`：接错一根线的表现是「代码跑了、一点声音没有」，界面上看不出来；
 * - 指数斜坡的目标值不许为 0：Web Audio 规范里 `exponentialRampToValueAtTime(0, …)` 直接抛
 *   `RangeError`，那是一条只在玩家点下第一下时才炸的错；
 * - 峰值之和要留头寸：五段包络叠在一起超过 1.0 会被浏览器削顶，听起来就是「破音」；
 * - 时长上限：音效盖不住牌局节奏是设计约束（`turn` 是提示不是打断）。
 *
 * 音色本身（哪个音多少赫兹）由 `SOUND_TIMBRES` 那张表说清楚，这里只钉它的**形状**：
 * 声部数、上行还是下滑、峰值区间。至于「好不好听」，那是 `/dev/assets` 那一页的目视（耳视）验收。
 */

import { describe, expect, it } from 'vitest';

import { playSound, SOUND_NAMES, SOUND_TIMBRES, type SoundName } from '../src/sound/synth';

import { FakeAudio, FakeGain, type FakeOscillator } from './fakeAudio';

/** 一条声部自己的包络增益（osc 连过去的第一枚节点） */
function envelopeOf(osc: FakeOscillator): FakeGain {
  const target = osc.connections[0];
  expect(target).toBeInstanceOf(FakeGain);
  return target as FakeGain;
}

function peakOf(osc: FakeOscillator): number {
  return Math.max(...envelopeOf(osc).gain.calls.map(([, value]) => value));
}

function play(name: SoundName, at = 0): FakeAudio {
  const audio = new FakeAudio();
  audio.currentTime = at;
  playSound(name, audio);
  return audio;
}

describe('音效 · 音色表', () => {
  it('正好五个音效，名字钉死（M4.2 验收项就是这五件事）', () => {
    expect(SOUND_NAMES).toEqual(['deal', 'chip', 'board', 'turn', 'win']);
  });

  it('提示类音效（轮到你 / 胜利）音高往上走，且不做下滑', () => {
    // 上行 = 「该你了、有好事」；下滑那种"塌下去"的听感属于发牌和筹码那类物理声
    for (const name of ['turn', 'win'] as const) {
      const voices = SOUND_TIMBRES[name];
      expect(voices.every((voice) => voice.slide === undefined)).toBe(true);
      const pitches = voices.map((voice) => voice.from);
      expect([...pitches].sort((a, b) => a - b)).toEqual(pitches);
    }
  });

  it('物理类音效（发牌 / 筹码 / 翻牌）至少有一声下滑，才有"啪"的落桌感', () => {
    for (const name of ['deal', 'chip', 'board'] as const) {
      expect(SOUND_TIMBRES[name].some((voice) => voice.slide !== undefined && voice.slide < voice.from)).toBe(
        true,
      );
    }
  });
});

describe('音效 · 调度', () => {
  it.each(SOUND_NAMES)('%s：每个声部都被启动并停止，且都通到输出端', (name) => {
    const audio = play(name);
    expect(audio.oscillators.length).toBeGreaterThan(0);
    for (const osc of audio.oscillators) {
      expect(osc.starts).toHaveLength(1);
      expect(osc.stops).toHaveLength(1);
      expect(osc.stops[0]).toBeGreaterThan(osc.starts[0] ?? 0);
      expect(osc.type).not.toBe('custom'); // custom 波形不出声
      expect(audio.reachesDestination(osc)).toBe(true);
    }
  });

  it.each(SOUND_NAMES)('%s：所有指数斜坡的目标值都大于 0（等于 0 会抛 RangeError）', (name) => {
    const audio = play(name);
    const ramps = audio.params().flatMap((param) => param.calls.filter(([kind]) => kind === 'exp'));
    expect(ramps.length).toBeGreaterThan(0);
    for (const [, value] of ramps) expect(value).toBeGreaterThan(0);
  });

  it.each(SOUND_NAMES)('%s：起播时刻不早于当前时间，且按音色表顺序排开', (name) => {
    for (const offset of [0, 12.5, 180_000]) {
      const audio = play(name, offset);
      const starts = audio.oscillators.map((osc) => osc.starts[0] ?? 0);
      expect(Math.min(...starts)).toBeGreaterThanOrEqual(offset);
      expect([...starts].sort((a, b) => a - b)).toEqual(starts);
    }
  });

  it.each(SOUND_NAMES)('%s：单个音效总时长 < 1s，峰值之和留足头寸（≤ 0.5，防削顶）', (name) => {
    const audio = play(name);
    const starts = audio.oscillators.map((osc) => osc.starts[0] ?? 0);
    const stops = audio.oscillators.map((osc) => osc.stops[0] ?? 0);
    expect(Math.max(...stops) - Math.min(...starts)).toBeLessThan(1);
    expect(audio.oscillators.reduce((sum, osc) => sum + peakOf(osc), 0)).toBeLessThanOrEqual(0.5);
    for (const osc of audio.oscillators) expect(peakOf(osc)).toBeLessThanOrEqual(0.25);
  });

  it('声部数与音色表一致（发牌三下、筹码两下、翻牌两下、提示两音、胜利四音）', () => {
    expect(play('deal').oscillators).toHaveLength(3);
    expect(play('chip').oscillators).toHaveLength(2);
    expect(play('board').oscillators).toHaveLength(2);
    expect(play('turn').oscillators).toHaveLength(2);
    expect(play('win').oscillators).toHaveLength(4);
  });

  it('每个音效串一只低通：锯齿和方波的毛刺靠它压住', () => {
    for (const name of SOUND_NAMES) {
      const audio = play(name);
      expect(audio.filters).toHaveLength(1);
      expect(audio.filters[0]?.type).toBe('lowpass');
      expect((audio.filters[0]?.frequency.calls.at(-1)?.[1] ?? 0)).toBeGreaterThan(1000);
    }
  });

  it('不烘焙绝对时间：同一个上下文连着放两次，第二次落在新的当前时间上', () => {
    const audio = new FakeAudio();
    playSound('turn', audio);
    const first = audio.oscillators[0]?.starts[0] ?? 0;
    audio.currentTime = 3;
    playSound('turn', audio);
    const second = audio.oscillators.at(-2)?.starts[0] ?? 0;
    expect(second).toBeGreaterThan(first);
    expect(second).toBeGreaterThanOrEqual(3);
  });
});
