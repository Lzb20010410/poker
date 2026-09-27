# 私局德州扑克 · poker-room

> **合规声明**：本项目为**私人朋友局用途，非商业运营，不涉及任何真实价值交换**。
> 纯虚拟筹码，无充值、无兑换、无回收、无提现功能，且不开放注册、不上架、不公开运营。
> 仓库公开仅作为开发者的技术作品集。

2-8 人在线德州扑克。房主创建房间生成 6 位配对码，其他玩家用配对码入房。PC 与手机浏览器同一套代码。

---

## 技术栈

| 层 | 选型 | 版本（已实测） |
|---|---|---|
| 语言 | TypeScript（strict） | 5.9.3 |
| 包管理 | pnpm workspaces | 9.15 |
| 前端 | React + Vite | 19.3.0 / 7.3.6 |
| 动画 | GSAP | 3.15.0 |
| 图形 | SVG + CSS（不用 Canvas/WebGL） | — |
| 联机 | Colyseus | 0.18.8（客户端 `@colyseus/sdk` 0.18.4） |
| 比牌 | pokersolver | 2.1.4 |
| 测试 | vitest | 5.0.1 |
| 运行 | Node | ≥22（容器与开发机同为 24） |

## 仓库结构

```
packages/
  shared/    纯规则逻辑，零 IO、零框架依赖。整个项目的命脉，100% 单测覆盖。
  server/    Colyseus 服务端。只做权威判定 + 状态同步 + 房间生命周期。
  web/       React 前端。只做渲染状态 + 播动画 + 收集操作。
scripts/
  check-arch.mjs   架构守卫，把分层铁律变成可执行检查
```

分层铁律：**游戏规则只存在于 `shared/engine`**。服务端调用它做权威判定，前端永不自行决策。

## 开发

```bash
pnpm install
pnpm dev        # 并行启动 server(:2567) + web(:5173)，手机可访问 http://<本机IP>:5173
pnpm verify     # lint + 架构守卫 + typecheck + test + build，提交前必跑
pnpm test:cov   # shared 包覆盖率（要求 100% statements）
```

服务端另有 `pnpm --filter @poker-room/server start`（= `tsx src/main.ts`）。
它跑的就是测试跑的那份源码，没有「编译产物」这一步，细节见 `DECISIONS.md` D-043。

## 部署

单台 VPS（2核4G 足够，8 人满座时 CPU 主要花在洗牌与状态同步上），两个容器：
`web`（nginx：静态文件 + `/ws` 反代）与 `server`（Colyseus）。
`server` 不映射宿主机端口，公网只听得见 80/443。

### 第 0 步 · 选地域：这台机器在哪，决定你要不要多等两周

| | 中国大陆地域 | 海外地域（新加坡 / 东京 / 硅谷） |
|---|---|---|
| **ICP 备案** | **要**。域名解析到国内 IP 对外提供 web 服务，接入商要求备案；阿里云走 1–2 周（身份证、实名、核验）。**备案没下来之前 80/443 这条路不要指望能通** | **不要**。买完解析完就能跑 |
| 延迟 | 低 | 国内访问 150–300ms，个别线路不稳 |
| 适合 | 打算长期用、要国内体验稳 | 朋友私局、先跑通看看 |

德州扑克不是动作游戏：一次操作就是一个按钮，300ms 完全无感，**所以"先跑通"选海外更划算**。
国内 IP 直连（不带域名）能不能开 80 我没验证过，别当作可行路径。

机器开好之后，在云控制台把**安全组 / 防火墙入方向只放行 22、80、443**——2567 不要放行，
`server` 容器本来也不映射宿主端口（这是设计：公网没有绕过 nginx 的 `ws://` 入口）。
域名在云解析里加一条 **A 记录**指向公网 IP（`@` 或 `poker` 之类的主机记录都行），
生效判据：`getent hosts 你的域名` 能打印出那个 IP。

```bash
git clone <你的仓库> poker-room && cd poker-room
cp .env.example .env          # 两个变量都有默认值，不填也能起
docker compose up -d --build  # 首次构建慢：本机实测冷缓存下 `pnpm install` 单层 19 分半
                              # （442 个包全量下载）。依赖层命中缓存之后整场 3 秒。
                              # 真正的编译只有 `vite build` 那一步，1.6 秒。

curl http://<域名或IP>/ws/health         # 服务端健康检查，经 nginx 的 /ws 前缀反代
docker compose logs -f server           # 一行一个 JSON，Docker 自己收走
```

> **那 19 分半花在下载上，不花在编译上**（442 个 npm 包 + `node:24-bookworm-slim` / `nginx:1.27-alpine`
> 两个基础镜像，实测机器是国内网络的开发机）。海外 VPS 上大概会快得多；**国内地域的机器很可能反过来
> 卡在这一步或卡在 `docker pull`**。卡住的退路是先配镜像源再构建：npm 侧
> `pnpm config set registry https://registry.npmmirror.com`（要在 Dockerfile 里加这一行才影响镜像内），
> Docker 侧用阿里云控制台给的「容器镜像加速」地址写进 `/etc/docker/daemon.json` 的 `registry-mirrors`。
> **这两条我都没在真机上验过**，是标准做法，写在这里是为了你别把它当成镜像坏了。

**前端连的是同源 `/ws`**（构建期写死在 `docker-compose.yml` 的 `VITE_SERVER_URL`），
所以换域名、从 http 升到 https 都**不需要重新构建前端**，只改 nginx 配置和环境变量。

### 谁能连进来

公网机器上只有 80/443 在听（`server` 不映射宿主机端口），入口就是 nginx 那条
`location /ws/`，而它带了一道**同源校验**：请求头里的 `Origin` 必须等于「回答这个
请求的 host」，或者干脆不带 `Origin`（健康检查、`curl`）。它比对的是运行时变量而不是
配置里的常量，所以换域名、换端口、http 升 https 都不用改这段。
**唯一要留意的是那个 scheme 从哪儿来**：只听 80 的 `default.conf` 会认 `X-Forwarded-Proto`
（否则 TLS 在前面那跳终结时 `$scheme` 停在 `http`，全场 403），TLS 在本层终结的 `https.conf`
**故意不认**（那里 `$scheme` 本来就是 https，多信一个客户端可自定的头等于留一条自我封锁的路）。
两份配置因此是有意的不对称，别再"统一成一份拷贝"，取舍见 D-043。
`ALLOWED_ORIGINS` 那个环境变量是**第二道**，只管服务端自己注册的路由——
Colyseus 会先把 `/matchmake` 挂好再调用我们传进去的回调，第一道够不到它，
这条是实测出来的，写在 `DECISIONS.md` D-043。

### 上 HTTPS（手机 4G/5G 连的前提）

浏览器在 https 页面里会直接拒掉 `ws://`，所以 `wss://` 不是加分项而是必需项。
证书用 Let's Encrypt，走 nginx webroot 校验：

```bash
# 1. 先用上面的 HTTP 形态跑通，再申请证书（校验时 80 必须是活的）
docker compose run --rm certbot certonly --webroot -w /var/www/certbot \
  -d poker.example.com --email you@example.com --agree-tos -n
#    certbot 这个服务挂在 profiles: [tls] 下，所以它不参与 up。
#    如果你的 compose 说找不到这个服务，显式打开那个 profile 即可：
#    docker compose --profile tls run --rm certbot certonly --webroot -w /var/www/certbot -d …

# 2. 把 deploy/nginx/https.conf 里的域名换成你的（共 4 处），
#    再去 docker-compose.yml 把挂载 https.conf 那一行的注释去掉

# 3. 重建 web 容器
docker compose up -d --force-recreate web
```

浏览器打开 `https://你的域名`，F12 → Network → WS 看到一条状态 `101 Switching Protocols`
的连接即成功。**续期**（证书 90 天有效）：

```bash
# crontab -e 加一行（续期后必须重启 web 才会加载新证书）
0 3 * * 1 cd /path/to/poker-room && docker compose run --rm certbot renew --quiet && docker compose up -d --force-recreate web
```

### 排错

| 现象 | 先看这里 |
|---|---|
| 页面能开、进房转圈 | `docker compose logs server`；再 `docker compose exec web wget -qO- http://server:2567/health` 绕开 nginx 直接问服务端（server 不发布宿主机端口，在宿主机上 curl 127.0.0.1:2567 是不通的） |
| 控制台报 `mixed content` | 页面已经是 https，但连的是 `ws://` —— 第 2、3 步没做完 |
| `docker compose up` 后 server 反复重启 | 多为 `PORT` 写了非法值：端口解析不出来时进程会**主动退出**而不是回落到 2567 |
| 房间号突然没人了 | v1 房间状态只在内存里，容器重启即清空。UI 有提示，也会引导回大厅重新建房 |
| `/ws/health` 返回 **403** | 同源门判不相等。要么请求带了不相干的 `Origin`（浏览器以外的东西才会这么干），要么**前面还有一层终结 TLS 的代理**（Cloudflare / CDN）而 nginx 那层的 `$scheme` 停在 `http`——`default.conf` 已经改成有 `X-Forwarded-Proto` 就按它判 scheme，别把它删回去，删了的表征是"页面能打开、进房一直转圈"而不是 403 页（`/matchmake` 与 WS 握手都吃 403）。取舍写在 D-043 |
| 单独 `docker run … nginx -t` 报 `host not found in upstream "server"` | **不是配置坏了。** `proxy_pass http://server:2567/` 里的 `server` 是 compose 服务名，容器不在那个网络上就解析不出来，而 nginx 在测试阶段就要解析上游。要脱离 compose 验语法：`docker network create tmp` + 起一个带 `--network-alias server` 的占位容器，再把 conf 挂进去跑 `-t`（本机就是这样拿到 `test is successful` 的） |

## 文档

| 文件 | 内容 |
|---|---|
| `AGENTS.md` | AI 编码代理的常驻行为规范 |
| `SPEC.md` | 架构 / 协议 / 动画 / UI 技术规格 |
| `RULES-SPEC.md` | 德州规则引擎的精确算法（边池、下注轮、状态机） |
| `TASKS.md` | 24 个任务的工作队列与验收标准 |
| `PROGRESS.md` | 进度账本 |
| `DECISIONS.md` | 技术决策记录 |

## 开发进度

M0 骨架 → M1 规则引擎与可玩 → M2 视觉 → M3 动画 → M4 打磨与部署。
详见 `PROGRESS.md`。
