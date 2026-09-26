/**
 * 状态横幅：错误、重连中、断线、连接中。
 *
 * 四种状态用两种 ARIA role，因为它们对读屏用户的紧急程度不一样：
 * - `role="alert"`：错误。会打断当前朗读立刻播报，因为玩家需要马上知道进不去。
 * - `role="status"`：重连中 / 断线 / 连接中。温和地排队播报，不打断当前朗读。
 *
 * ## 「服务端未启动时不白屏」这条验收项主要靠它
 *
 * 关键是连不上时**页面结构照旧**，只是多一条横幅说明发生了什么、
 * 下一步怎么办——连接失败在这里是一个被渲染出来的状态，不是一个被抛出去的异常。
 * 四种状态都不成立时返回 null（没消息就是不该占地方）。
 *
 * ## 为什么「重连中」值得单独一条横幅
 *
 * Colyseus SDK 掉线后会自己重连约 56 秒才放弃（`net/types.ts` 里 `LinkState`
 * 有完整说明）。这段时间里牌桌看起来完全正常，只是不再更新——玩家不会知道网断了，
 * 只会以为别人都在发呆。所以必须把它显式说出来。
 *
 * 措辞在 M1.6 改过一次。原来这里写的是「别刷新页面——刷新会把重连凭证一起丢掉」，
 * 那在 M0.4 是真的，现在不是：重连凭证存在**这个标签页的 sessionStorage**
 * （`net/storage.ts`），刷新后会自动拿它续上同一个座位。留着那句话会让玩家
 * 不敢刷新，从而错过真正有效的自救手段。现在说的是「动作不会被攒着」这件事，
 * 它才是断线期间真正会踩到的坑。
 */

import type { ReactNode } from 'react';

import type { ConnectionFailure } from '../../net/errors';
import type { LinkState } from '../../net/types';
import type { RoomStatus } from '../../state/RoomContext';

export interface StatusBannerProps {
  readonly status: RoomStatus;
  readonly failure: ConnectionFailure | null;
  readonly link: LinkState;
  readonly onDismissFailure?: () => void;
}

export function StatusBanner({ status, failure, link, onDismissFailure }: StatusBannerProps): ReactNode {
  if (failure !== null) {
    return (
      <div className="banner banner--error" role="alert">
        <div className="banner__body">
          <strong className="banner__title">{failure.title}</strong>
          <span className="banner__hint">{failure.hint}</span>
          {/*
            detail 只在认不出错误类型时显示。已知的业务错误不复述服务端原文：
            `room "ABC123" is locked` 这种话对玩家没有信息量，只会暴露内部实现。
          */}
          {failure.kind === 'unknown' && failure.detail !== '' && (
            <code className="banner__detail">{failure.detail}</code>
          )}
        </div>
        {onDismissFailure !== undefined && (
          <button className="banner__close" type="button" onClick={onDismissFailure}>
            知道了
          </button>
        )}
      </div>
    );
  }

  if (link === 'offline') {
    return (
      <div className="banner banner--warn" role="status">
        <div className="banner__body">
          <strong className="banner__title">连接已断开</strong>
          <span className="banner__hint">
            自动重连没成功。刷新这一页或者回大厅再进一次同一个配对码都能重试；
            如果服务端已经不认这个旧身份了，你会以新身份重新入座，界面会说明。
          </span>
        </div>
      </div>
    );
  }

  if (link === 'reconnecting') {
    return (
      <div className="banner banner--warn" role="status">
        <div className="banner__body">
          <strong className="banner__title">连接不稳定，正在重连…</strong>
          <span className="banner__hint">
            这段时间牌桌不会更新，按钮我们也先禁用了——过期的动作不会被攒着等重连后突然打出去。
            手机在 Wi-Fi 和流量之间切换时最常见，大约一分钟内会自动接回去；
            实在接不回去这里会变成「连接已断开」。刷新这一页一般能续上原来的座位。
          </span>
        </div>
      </div>
    );
  }

  if (status === 'connecting') {
    return (
      <div className="banner banner--info" role="status">
        <div className="banner__body">
          <span className="banner__title">正在连接…</span>
        </div>
      </div>
    );
  }

  return null;
}
