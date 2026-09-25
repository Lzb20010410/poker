/**
 * 渲染兜底。
 *
 * 连接失败有 `StatusBanner` 处理，那不会白屏。但 React 在**渲染阶段抛异常**时
 * 会把整棵树卸掉——页面就是一片空白，连控制台之外的线索都没有。
 * 「服务端未启动时不白屏」这条验收项要真的成立，就得把这条路也堵上。
 *
 * React 到 19 仍然没有捕获渲染错误的 Hook，只能写类组件。
 * 这里只用 `componentDidCatch`（在里面 setState），不用 `getDerivedStateFromError`：
 * 后者是静态成员，`noImplicitOverride` 下的写法要跟着 React 类型定义变，
 * 而 `componentDidCatch` 是实例成员，基类把它声明成可选属性，加 `override` 就行
 * （和 Colyseus 的 `onCreate` 是同一类坑，见 DECISIONS.md D-009）。
 */

import { Component, type ErrorInfo, type ReactNode } from 'react';

interface ErrorBoundaryProps {
  readonly children: ReactNode;
}

interface ErrorBoundaryState {
  readonly error: Error | null;
}

export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  override state: ErrorBoundaryState = { error: null };

  override componentDidCatch(error: Error, errorInfo: ErrorInfo): void {
    // 打到控制台是因为这个项目没有前端错误上报，本地/局域网调试时
    // 控制台就是唯一的现场。生产部署（M4.3）如果接了上报，从这里接出去。
    console.error('[poker-room] 渲染出错', error, errorInfo.componentStack);
    this.setState({ error });
  }

  override render(): ReactNode {
    const { error } = this.state;
    if (error === null) return this.props.children;

    return (
      <div className="fatal">
        <h1 className="fatal__title">页面出错了</h1>
        <p className="fatal__hint">
          这不应该发生。先刷新一下试试；如果刷新后还是这样，把下面这行连同浏览器控制台的报错一起发给开发者。
        </p>
        <code className="fatal__detail">{`${error.name}: ${error.message}`}</code>
        <button
          className="btn btn--primary"
          type="button"
          onClick={() => {
            window.location.reload();
          }}
        >
          刷新页面
        </button>
      </div>
    );
  }
}
