/**
 * 头像预览。
 *
 * 渲染成 `<img src={dataUri}>` 而不是内联 SVG：每张 Notionists 头像约 14.7 KB，
 * 8 个人的等待室里内联会把 DOM 撑到 100 KB+，而且每张都是一个独立文档、
 * 不需要外部交互。`<img>` 还顺带隔离了 SVG 内部的 id（不会互相冲突）。
 */

import { avatarDataUri } from '../../avatar';

export interface AvatarPreviewProps {
  readonly seed: string;
  /** CSS 边长（px）。传给 DiceBear 的也是这个值，保证不是放大糊图 */
  readonly size?: number;
  /** 无障碍用的替代文本。默认写「玩家头像」，列表里应该带上昵称 */
  readonly label?: string;
  readonly className?: string;
}

export function AvatarPreview({ seed, size = 64, label = '玩家头像', className }: AvatarPreviewProps) {
  return (
    <img
      className={className}
      src={avatarDataUri(seed, size)}
      alt={label}
      width={size}
      height={size}
      // 头像是 data URI，本来就没有网络请求，但显式声明能让浏览器跳过解码优先级排队
      decoding="async"
    />
  );
}
