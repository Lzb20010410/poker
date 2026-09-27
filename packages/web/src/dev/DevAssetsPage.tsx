/**
 * `/dev/assets` —— M2.1 的验收页：把这一期做的资产一次性平铺出来给人看。
 *
 * ## 为什么要专门做这个页面
 *
 * `TASKS.md` M2.1 的验收标准是「有一个 `/dev/assets` 页面平铺展示全部资产，用户目视验收」。
 * 机器能钉的（张数、面额、色值、体积、id 冲突）都在 `test/` 里钉死了，但**好不好看**
 * 只有人能判——而判断需要一张把 52 张牌、6 档筹码、两档桌布、8 张预置脸放在同一屏的图。
 * 所以这个页面是验收工具，不是产品界面：它不需要接房间、不需要连服务端、不进玩家视线。
 *
 * ## 三处刻意的设计
 *
 * - **牌面渲染两遍**：正常尺寸一遍，`height="24"` 一遍。验收项写的是「24px 高度下点数
 *   与花色仍可辨识」，不摆出来就没法判。
 * - **绿呢蓝呢两张桌子并排**：桌面的渐变和噪点滤镜靠 `id` 引，两档色同时出现在一页
 *   才能暴露 id 撞名（`pokerTable.test.ts` 里那条断言的可视化版本）。
 * - **头像是懒加载的**：这一页第一次打开会先看到 8 个占位块、随后脸才出现。
 *   那是 D-020 的正常行为，不是这个页面的 bug。
 *
 * ## M4.2 之后这一页多了一个前提：要有 `SoundProvider`
 *
 * 音效的试听按钮放在这一页最上面（`TASKS.md`:316 那条「手机 Safari 与 Chrome 都能出声」
 * 在牌桌上没法验——你得先凑齐一桌人打到发牌那一刻；在这里是点一下）。它读的是
 * `useSound()`，于是这一页从「谁都能单独渲染」变成「必须挂在 Provider 下面」，
 * 和 `AppShell` 需要 `RoomProvider` 是同一件事。生产里 `App.tsx` 一直套着，
 * 只有单独渲染这一页的用例要自己套。
 */

import { useState, type ReactNode } from 'react';
import { FELT_VALUES, RANKS, SUITS } from '@poker-room/shared/view';

import { PRESET_AVATAR_SEEDS } from '../avatar';
import { CARD_BACK_DATA_URI } from '../assets/cardBack';
import { cardFaceDataUri } from '../assets/cardFaces';
import { CHIP_DENOMINATIONS, chipDataUri } from '../assets/chips';
import { FELT_LABELS, tableFeltDataUri } from '../assets/pokerTable';
import { AvatarPreview } from '../lobby/components/AvatarPreview';
import { SOUND_LABELS, SOUND_NAMES } from '../sound/synth';
import { useSound } from '../state/SoundContext';
import { cardText } from '../table/components/CardView';

/** 按花色成组、每组从 2 到 A。牌桌上看牌就是按这个顺序认的 */
const ALL_CARDS = SUITS.flatMap((suit) => RANKS.map((rank) => ({ rank, suit })));

/** 牌面正常展示高度（px）。宽度交给浏览器按 viewBox 比例算 */
const FACE_HEIGHT = 96;

/** 24px 那条验收带 */
const SMALL_FACE_HEIGHT = 24;

export function DevAssetsPage(): ReactNode {
  const [seedDraft, setSeedDraft] = useState('');
  const [customSeed, setCustomSeed] = useState<string | null>(null);
  const { muted, play } = useSound();

  return (
    <div className="dev-assets">
      <h1 className="dev-assets__title">资产总览</h1>
      <p className="dev-assets__hint">
        M2.1 的目视验收页：牌面 52 张、牌背、6 档筹码、两档桌布、8 个预置头像。
        牌面素材来自 <code>hayeah/playing-cards-assets</code>（MIT，上游牌面本身为 public domain），
        出处与许可证见 <code>src/assets/LICENSE-playing-cards.txt</code> 与 DECISIONS.md D-023。
      </p>

      {/*
        试听区排在最前面，不是随手放的：这一页在手机上打开时，五十二张牌面要滚很久才到底，
        而「手机 Safari 能不能出声」这条验收项只需要点一下。放在第一屏，点完就走。
      */}
      <section className="asset-section" aria-label="音效">
        <h2 className="asset-section__title">音效 5 声（Web Audio 现场合成，产物里 0 字节音频）</h2>
        <div className="asset-sounds" data-assets="sounds">
          {SOUND_NAMES.map((name) => (
            <button className="btn" key={name} onClick={() => play(name)} type="button">
              {SOUND_LABELS[name]}
            </button>
          ))}
        </div>
        <p className="dev-assets__hint">
          {muted
            ? '当前是静音档（页头那颗开关可以取消）。静音时点这几颗什么都不响是设计如此，不是坏了。'
            : '第一次点击本身就是浏览器的「用户手势」，所以第一下就该出声。没有声音 → 看页头开关是不是静音档；有声音但刺耳或不贴图 → 判的是音色表，见 src/sound/synth.ts。'}
        </p>
      </section>

      <section className="asset-section" aria-label="牌面">
        <h2 className="asset-section__title">牌面 52 张</h2>
        <div className="asset-grid" data-assets="faces">
          {ALL_CARDS.map((card) => (
            <figure className="asset-tile" key={cardText(card)}>
              <img alt={cardText(card)} height={FACE_HEIGHT} src={cardFaceDataUri(card)} />
              <figcaption className="asset-tile__caption">{cardText(card)}</figcaption>
            </figure>
          ))}
        </div>

        <h3 className="asset-section__subtitle">24px 高（手机对面座位的实际观感）</h3>
        <div className="asset-strip" data-assets="faces-small">
          {ALL_CARDS.map((card) => (
            <img alt={cardText(card)} height={SMALL_FACE_HEIGHT} key={`small-${cardText(card)}`} src={cardFaceDataUri(card)} />
          ))}
        </div>
      </section>

      <section className="asset-section" aria-label="牌背">
        <h2 className="asset-section__title">牌背</h2>
        <div className="asset-grid" data-assets="back">
          <figure className="asset-tile">
            <img alt="牌背" height={FACE_HEIGHT} src={CARD_BACK_DATA_URI} />
            <figcaption className="asset-tile__caption">自绘，与牌面同 viewBox</figcaption>
          </figure>
        </div>
      </section>

      <section className="asset-section" aria-label="筹码">
        <h2 className="asset-section__title">筹码 6 档</h2>
        <div className="asset-grid asset-grid--chips" data-assets="chips">
          {CHIP_DENOMINATIONS.map((value) => (
            <figure className="asset-tile" key={value}>
              <img alt={`筹码 ${value.toLocaleString('en-US')}`} height={64} src={chipDataUri(value)} width={64} />
              <figcaption className="asset-tile__caption">{value.toLocaleString('en-US')}</figcaption>
            </figure>
          ))}
        </div>
      </section>

      <section className="asset-section" aria-label="桌面">
        <h2 className="asset-section__title">桌布两档（房主可选）</h2>
        <div className="asset-felts" data-assets="table">
          {FELT_VALUES.map((felt) => (
            <img
              alt={`${FELT_LABELS[felt]}桌面`}
              className="asset-felts__img"
              key={felt}
              src={tableFeltDataUri({ felt, idPrefix: `dev-${felt}` })}
            />
          ))}
        </div>
      </section>

      <section className="asset-section" aria-label="头像">
        <h2 className="asset-section__title">头像（DiceBear Notionists，MIT）</h2>
        <div className="asset-grid asset-grid--avatars" data-assets="avatars">
          {PRESET_AVATAR_SEEDS.map((seed, index) => (
            <figure className="asset-tile" key={seed}>
              <AvatarPreview label={`预置头像 ${index + 1}`} seed={seed} size={128} />
              <figcaption className="asset-tile__caption">{seed}</figcaption>
            </figure>
          ))}
          {customSeed !== null && (
            <figure className="asset-tile">
              <AvatarPreview label={`seed ${customSeed} 的头像`} seed={customSeed} size={128} />
              <figcaption className="asset-tile__caption">{customSeed}</figcaption>
            </figure>
          )}
          <form
            className="asset-seed-form"
            onSubmit={(event) => {
              event.preventDefault();
              const next = seedDraft.trim();
              if (next !== '') setCustomSeed(next);
            }}
          >
            <label className="asset-seed-form__label" htmlFor="dev-avatar-seed">
              自定义头像 seed
            </label>
            <input
              className="asset-seed-form__input"
              id="dev-avatar-seed"
              onChange={(event) => {
                setSeedDraft(event.target.value);
              }}
              type="text"
              value={seedDraft}
            />
            <button className="btn" disabled={seedDraft.trim() === ''} type="submit">
              看看这张
            </button>
          </form>
        </div>
      </section>
    </div>
  );
}
