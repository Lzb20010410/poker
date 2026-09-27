/**
 * 五个音效的**音色表**和它的 Web Audio 调度（M4.2）。
 *
 * ## 为什么是合成而不是音频文件
 *
 * `SPEC.md` §4.7 原本写的是「5 个短音效（各 <30KB，ogg/mp3）」。这里改成现场合成，
 * 理由和代价记在 `DECISIONS.md` D-041：离线拿不到可授权的音效资产，而自己产出 mp3/ogg
 * 要新增编码器依赖（违反技术栈锁定）。合成的收益：产物里 0 字节音频（预算 150KB）、
 * 没有解码延迟、跨浏览器音色完全一致。将来要换成真录音，替换点只有本文件——
 * `SOUND_TIMBRES` 换成 buffer、`playSound` 换成 `BufferSource`，其余各层不动。
 *
 * ## 只做「振荡器 + 包络 + 一只低通」
 *
 * 没有噪声 buffer、没有多个滤波器。原因不是偷懒：**每多一件节点，测试就要多写一套假件**，
 * 而真实故障只有两类——图没接到输出端（代码在跑、声音没有）和包络写崩（指数斜坡目标给 0，
 * 浏览器直接抛 `RangeError`）。这两类都能在这五件节点上被测干净。低通是唯一那只：
 * 方波和锯齿的高次谐波在手机小喇叭上非常刺耳，4.2kHz 一刀下去才像"牌桌的声音"。
 *
 * ## 音色表的单位是秒，不是帧
 *
 * 所有时刻都相对 `ctx.currentTime` 现算，绝不烘焙绝对时间——同一枚上下文要能连续放很多声。
 */

/** M4.2 要的那五件事。加一类要同时加音表和 `cues.ts` 的触发条件 */
export type SoundName = 'deal' | 'chip' | 'board' | 'turn' | 'win';

/** 顺序即 `SOUND_NAMES`，也是 `/dev/assets` 上试听按钮的顺序 */
export const SOUND_NAMES: readonly SoundName[] = ['deal', 'chip', 'board', 'turn', 'win'];

/**
 * 试听按钮上的中文名。
 *
 * 名字说的是**什么时候响**（`cues.ts` 那张表的触发条件），不是音色描述——
 * 玩家（和验收时的你）在牌桌上感知到的是事件，「公共牌」比「一下沉的落桌声」更好对。
 */
export const SOUND_LABELS: Record<SoundName, string> = {
  deal: '发牌',
  chip: '筹码',
  board: '公共牌',
  turn: '轮到你',
  win: '胜利',
};

/**
 * `AudioParam` 里我们用到的那三个自动化。
 *
 * 整个文件都不出现 `AudioContext` 这个全局类型，而是自己声明一套最小接口：
 * 一来 jsdom 根本没有 Web Audio，有了它单测才能注入假件；二来这也把「音效层到底
 * 依赖浏览器的哪些能力」写成了可读的一页，将来换实现（真音频文件、Web Audio 之外的
 * 后端）时，越界的地方一眼就看见。
 */
export interface SoundParam {
  setValueAtTime(value: number, startTime: number): void;
  linearRampToValueAtTime(value: number, endTime: number): void;
  exponentialRampToValueAtTime(value: number, endTime: number): void;
}

export interface SoundNode {
  connect(target: SoundNode | SoundParam): void;
}

export interface SoundGain extends SoundNode {
  readonly gain: SoundParam;
}

export interface SoundOscillator extends SoundNode {
  type: OscillatorType;
  readonly frequency: SoundParam;
  start(when: number): void;
  stop(when: number): void;
}

export interface SoundBiquad extends SoundNode {
  type: BiquadFilterType;
  readonly frequency: SoundParam;
  readonly Q: SoundParam;
}

export interface SoundAudioContext {
  readonly currentTime: number;
  readonly destination: SoundNode;
  readonly state: AudioContextState;
  createGain(): SoundGain;
  createOscillator(): SoundOscillator;
  createBiquadFilter(): SoundBiquad;
  resume(): Promise<void>;
}

/** 一段音：一个振荡器 + 一条 Attack→衰减 包络 */
export interface Voice {
  readonly wave: OscillatorType;
  /** 起始频率（Hz） */
  readonly from: number;
  /**
   * 下滑目标频率（Hz）。省略就是"一个音高"。
   *
   * 只做**下**滑：物理声（牌落桌、筹码相碰）靠往下掉的那口气才像东西在动；
   * 提示声要往上走，那是换下一个音高（见 `turn` / `win`），不是滑音。
   */
  readonly slide?: number;
  /** 相对本音效起点的延迟（秒） */
  readonly at: number;
  /** 包络长度（秒） */
  readonly dur: number;
  /** 包络峰值（0..1）。同一段里各峰值之和受削顶约束，见 `soundSynth.test.ts` */
  readonly peak: number;
}

/** 指数斜坡不许碰到 0（Web Audio 规范会抛 `RangeError`），用这个当"静音" */
const SILENT = 0.0001;
/** 起音时间。6ms 以下的方波会"拍"一下，正好是我们要的瞬态 */
const ATTACK = 0.006;
/** `stop()` 之后多留的一点余量，防包络末尾被切出爆音 */
const RELEASE = 0.012;
/** 总线音量：给各段包络留出叠加头寸 */
const MASTER = 0.8;
/** 低通截止（Hz）：压掉方波/锯齿在手机喇叭上的毛刺 */
const LOWPASS_HZ = 4200;

/**
 * 音色表。听感属于目视（耳视）验收，这里只说清每个音效的意图：
 *
 * | 音效 | 意图 |
 * |---|---|
 * | `deal` | 三下由重到轻的下滑，像牌从牌堆滑出来落到桌上 |
 * | `chip` | 两下高频短促的"叮"，一枚筹码压在另一枚上 |
 * | `board` | 一下比发牌更沉的落桌（公共牌是亮给全桌看的，要有分量） |
 * | `turn` | A5→E6 两音上行，提示而不是打断 |
 * | `win` | C 大调琶音 C5 E5 G5 C6，最后一音拖长 |
 *
 * 单段总长都压在 1 秒内：音效不许盖住牌局节奏，也不许在玩家快速连动时叠成一片。
 */
export const SOUND_TIMBRES: Record<SoundName, readonly Voice[]> = {
  deal: [
    { wave: 'triangle', from: 1500, slide: 170, at: 0, dur: 0.055, peak: 0.17 },
    { wave: 'triangle', from: 1400, slide: 170, at: 0.115, dur: 0.055, peak: 0.14 },
    { wave: 'triangle', from: 1200, slide: 150, at: 0.235, dur: 0.06, peak: 0.12 },
  ],
  chip: [
    { wave: 'square', from: 2200, slide: 1500, at: 0, dur: 0.03, peak: 0.06 },
    { wave: 'sine', from: 3300, slide: 2400, at: 0.022, dur: 0.07, peak: 0.09 },
  ],
  board: [
    { wave: 'triangle', from: 720, slide: 110, at: 0, dur: 0.085, peak: 0.18 },
    { wave: 'sine', from: 320, slide: 85, at: 0.03, dur: 0.13, peak: 0.1 },
  ],
  turn: [
    { wave: 'sine', from: 880, at: 0, dur: 0.11, peak: 0.11 },
    { wave: 'sine', from: 1318.51, at: 0.1, dur: 0.2, peak: 0.11 },
  ],
  win: [
    { wave: 'triangle', from: 523.25, at: 0, dur: 0.13, peak: 0.1 },
    { wave: 'triangle', from: 659.25, at: 0.085, dur: 0.13, peak: 0.1 },
    { wave: 'triangle', from: 783.99, at: 0.17, dur: 0.13, peak: 0.1 },
    { wave: 'triangle', from: 1046.5, at: 0.255, dur: 0.4, peak: 0.12 },
  ],
};

/**
 * 放一声。每次调用都搭一条**新的**子图（振荡器 → 包络 → 总线 → 低通 → 输出），
 * 因为最后一段包络走完，这些节点就会被回收——留一条常驻总线反而要操心什么时候断开。
 */
export function playSound(name: SoundName, context: SoundAudioContext): void {
  const t0 = context.currentTime;

  const bus = context.createGain();
  bus.gain.setValueAtTime(MASTER, t0);
  const tone = context.createBiquadFilter();
  tone.type = 'lowpass';
  tone.frequency.setValueAtTime(LOWPASS_HZ, t0);
  tone.Q.setValueAtTime(0.707, t0);
  bus.connect(tone);
  tone.connect(context.destination);

  for (const voice of SOUND_TIMBRES[name]) {
    const at = t0 + voice.at;

    const osc = context.createOscillator();
    osc.type = voice.wave;
    osc.frequency.setValueAtTime(voice.from, at);
    if (voice.slide !== undefined) osc.frequency.exponentialRampToValueAtTime(voice.slide, at + voice.dur);

    const envelope = context.createGain();
    envelope.gain.setValueAtTime(SILENT, at);
    envelope.gain.linearRampToValueAtTime(voice.peak, at + Math.min(ATTACK, voice.dur / 3));
    envelope.gain.exponentialRampToValueAtTime(SILENT, at + voice.dur);

    osc.connect(envelope);
    envelope.connect(bus);
    osc.start(at);
    osc.stop(at + voice.dur + RELEASE);
  }
}
