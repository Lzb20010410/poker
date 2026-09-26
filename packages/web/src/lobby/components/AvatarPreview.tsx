/**
 * 头像预览。
 *
 * 渲染成 `<img src={dataUri}>` 而不是内联 SVG：每张 Notionists 头像约 14.7 KB，
 * 8 个人的等待室里内联会把 DOM 撑到 100 KB+，而且每张都是一个独立文档、
 * 不需要外部交互。`<img>` 还顺带隔离了 SVG 内部的 id（不会互相冲突）。
 *
 * 头像库是懒加载的（D-020），所以图片没就绪时画的是一个**同尺寸的占位块**：
 * 保留宽高，图一到 DOM 位置不动，列表不会跳一下；保留无障碍标签，读屏里
 * 从头到尾都念得出「阿博的头像」，不会先念成"空元素"再变。
 *
 * 状态里存的是 `{ key, uri }` 而不是光一个 uri：seed 换了要能立刻认出来
 * "这张脸不属于这个人"，宁可退回占位也不挂一张旧脸。
 */

import { useEffect, useState } from 'react';

import { loadAvatarDataUri, peekAvatarDataUri } from '../../avatar';

export interface AvatarPreviewProps {
  readonly seed: string;
  /** CSS 边长（px）。传给 DiceBear 的也是这个值，保证不是放大糊图 */
  readonly size?: number;
  /** 无障碍用的替代文本。默认写「玩家头像」，列表里应该带上昵称 */
  readonly label?: string;
  readonly className?: string;
}

export function AvatarPreview({ seed, size = 64, label = '玩家头像', className }: AvatarPreviewProps) {
  const [loaded, setLoaded] = useState<{ readonly key: string; readonly uri: string } | null>(null);
  const key = `${size}:${seed}`;
  const uri = loaded !== null && loaded.key === key ? loaded.uri : peekAvatarDataUri(seed, size);

  useEffect(() => {
    let alive = true;
    void loadAvatarDataUri(seed, size).then(
      (next) => {
        if (alive) setLoaded({ key: `${size}:${seed}`, uri: next });
      },
      // 头像库没加载出来就一直用占位块。它是装饰性内容，
      // 为一张脸去打断玩家操作（或者甩一个未捕获的 rejection）都不划算。
      () => undefined,
    );
    return () => {
      alive = false;
    };
  }, [seed, size]);

  if (uri === undefined) {
    return (
      <span
        aria-label={label}
        className={className}
        data-avatar="loading"
        role="img"
        style={{ width: size, height: size }}
      />
    );
  }

  return (
    <img
      className={className}
      src={uri}
      alt={label}
      width={size}
      height={size}
      // 头像是 data URI，本来就没有网络请求，但显式声明能让浏览器跳过解码优先级排队
      decoding="async"
    />
  );
}
