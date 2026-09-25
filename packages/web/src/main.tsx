/**
 * 浏览器入口。
 *
 * 保留 `StrictMode`：它会在 dev 下把每个 effect 跑两遍，正好用来验证
 * 「打开分享链接自动进房」这条路径的防重复连接守卫是不是真的有效。
 * 如果哪天为了省事把它摘掉，那批守卫就再也没人测了。
 */

import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

import { App } from './App';

import './styles/global.css';

const container = document.getElementById('root');
if (!container) throw new Error('#root 容器不存在');

createRoot(container).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
