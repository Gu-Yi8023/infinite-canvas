<p align="center">
  <img src="web/public/logo.svg" width="96" alt="无限画布 logo">
</p>

<h1 align="center">无限画布 (infinite-canvas)</h1>

<p align="center">
  <a href="https://github.com/Gu-Yi8023/infinite-canvas"><img src="https://img.shields.io/github/stars/Gu-Yi8023/infinite-canvas?style=flat-square&logo=github" alt="当前 Fork 的 GitHub stars"></a>
  <a href="https://github.com/basketikun/infinite-canvas"><img src="https://img.shields.io/badge/fork-basketikun%2Finfinite--canvas-2b6de8?style=flat-square" alt="Fork 来源"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-f97316?style=flat-square" alt="MIT License"></a>
</p>

无限画布是一款开源 AI 创作工作台，将图片、文本、视频、音频、提示词和生成流程组织在同一张画布中，支持从参考素材到生成结果的连续创作。

本仓库 [Gu-Yi8023/infinite-canvas](https://github.com/Gu-Yi8023/infinite-canvas) Fork 自 **[basketikun/infinite-canvas](https://github.com/basketikun/infinite-canvas)**，在上游基础上继续开发，并增加面向飞牛 fnOS 的单用户 NAS 部署。感谢原作者 basketikun 及所有贡献者；上游社区与赞助信息见 [原项目 README](https://github.com/basketikun/infinite-canvas#readme)。

> 项目仍处于开发阶段，本地数据格式可能调整，重要画布和素材请先导出备份。NAS 模式已有基础部署与单张生图验证记录，完整验收尚未完成，具体范围见 [待测试事项](docs/content/docs/progress/pending-test.zh-CN.mdx)。

## 核心功能

- **无限画布**：多项目管理、节点连线与分组、拖拽缩放、框选、小地图、撤销重做和导入导出。
- **多模态创作**：文生图、参考图编辑、文本与带图问答、视频生成、音频生成；图片与视频也可在独立工作台中创作，具体能力取决于所选模型和供应商接口。
- **素材与提示词**：本地素材库、生成历史、开源提示词来源与自定义来源，以及通过 `@` 引用画布内容。
- **Agent 协作**：画布助手及本地 Canvas Agent，通过 Codex 和 MCP 读取、操作画布；仓库提供 Codex app 插件。
- **扩展与适配**：远程节点插件、TypeScript SDK，以及普通部署中的自定义图片 / 视频调用脚本。
- **NAS 模式**：HTTPS 登录入口、容器内 Codex 文本与图片任务、服务端音视频 API 配置、任务与产物持久化；断线恢复核对已有任务，不自动重新生成。

画布项目、素材和生成记录主要保存在浏览器本地。WebDAV 需自行配置；NAS 的服务端任务保存不等于完整的跨设备画布同步。

## 选择部署方式

| 方式 | 适用场景 | AI 请求与凭据 |
| --- | --- | --- |
| 本地开发 | 修改前端、试用功能 | 浏览器直连供应商，API Key 保存在浏览器 |
| 普通 Docker 静态站 | 在自己的机器上托管网页 | 与本地前端相同，不包含 NAS 登录网关和 Codex worker |
| 飞牛 NAS | 单用户局域网服务，由 NAS 执行任务 | 浏览器调用同源认证接口；Codex 凭据、音视频 Key 和内部 token 留在 NAS |

以下命令中的域名和路径均为示例；`YOUR_NAS_IPV4`、`/path/to/...` 等占位内容必须替换为自己的值。不要把填好后的私有配置、证书私钥或登录缓存提交到仓库。

## 本地开发与普通 Docker 部署

### 1. 获取源码

准备 Git，然后克隆本 Fork：

```bash
git clone https://github.com/Gu-Yi8023/infinite-canvas.git
cd infinite-canvas
```

### 2. 启动前端

安装 [Bun](https://bun.sh/)，在仓库根目录执行：

```bash
cd web
bun install
bun run dev
```

打开 <http://localhost:3000>，在配置中添加供应商的 `Base URL`、`API Key` 和模型，再创建画布或进入图片 / 视频工作台。需要本地代理时，可按 [Canvas Proxy 说明](canvas-proxy/README.md) 配置。开发命令监听所有网络接口，请只在信任的网络中开放。

### 3. 或使用 Docker 运行静态站

安装 Docker 和 Compose 插件，在仓库根目录运行：

```bash
docker compose -f docker-compose.local.yml up -d --build
docker compose -f docker-compose.local.yml ps
```

同样访问 <http://localhost:3000>；从其他设备访问时，将 `localhost` 换成部署机器地址，并确认端口与防火墙设置。端口冲突时可修改 `docker-compose.local.yml` 中 `ports` 左侧的宿主端口，右侧容器端口保持 `3000`。

此命令从当前 Fork 源码构建镜像。默认的 `docker-compose.yml` 使用上游发布的 `ghcr.io/basketikun/infinite-canvas:latest` 镜像，因此不能用它验证本 Fork 的最新改动。静态资源和深层路由仍需按实际部署环境验收。

停止服务可运行 `docker compose -f docker-compose.local.yml down`。画布和素材仍在浏览器中，换域名、端口或浏览器会进入不同的本地存储空间，迁移前请先导出。

### 4. 可选：启动当前源码的本地 Agent

需要 Node.js `22.19` 或更高版本，并准备好已安装和授权的 Codex CLI。在另一个终端进入仓库：

```bash
cd canvas-agent
npm ci
npm run dev
```

在画布右上角打开 Agent，填入终端显示的本机地址和连接 token。token 仅用于本地连接，不要贴到公开 issue。MCP 与插件配置见 [Canvas Agent 文档](canvas-agent/README.md)；NAS 模式无需在访问网页的电脑上另启本地 Agent。

## 飞牛 NAS 部署

### 1. 准备环境

需要支持 Docker Compose 的 Linux NAS、可访问的源码目录，以及管理员权限来加载 AppArmor 策略。当前沙箱验证范围为 **amd64 / x86_64、Docker 28.5.2、fnOS AppArmor 3.0.8**；其他版本或架构需要重新验证。镜像内置 Node.js 24 和锁定版本的 Codex CLI，无需在 NAS 宿主另装 Node.js 或 Codex。

网络与访问准备：

- 为 NAS 配置固定局域网 IPv4 地址，并选定 HTTPS 入口域名或 IP。
- 准备匹配该域名或 IP 的 TLS 证书、证书链和私钥；每台访问设备都必须信任证书。示例域名需要在局域网 DNS 或 hosts 中解析到 NAS。
- 准备容器可访问的 OpenClash HTTP / mixed 代理地址。代理监听和防火墙只向需要的 NAS 来源开放，不向公网开放；容器中的 `127.0.0.1` 不是 OpenWrt 地址。
- Docker 拉取基础镜像和构建依赖使用自己的网络路径，后续 worker 的运行时代理配置不会自动配置 Docker daemon。

```text
浏览器 → HTTPS gateway → 内网 worker → Codex app-server
                    ↘ 音频 / 视频供应商适配器
worker / 音视频适配器 → OpenClash → 外部服务
```

### 2. 配置部署变量

在 NAS 上按前文克隆源码，进入仓库根目录：

```bash
cp deploy/nas/.env.example .env.nas
```

编辑 `.env.nas`，替换下面的示例值：

```dotenv
NAS_DATA_DIR=/path/to/private/infinite-canvas
NAS_LAN_IP=YOUR_NAS_IPV4
NAS_HTTPS_PORT=3443
CANVAS_PUBLIC_ORIGIN=https://canvas.home.example:3443
```

| 变量 | 要求 |
| --- | --- |
| `NAS_DATA_DIR` | NAS 上专用私有目录的绝对路径；不要设为家庭共享或源码目录 |
| `NAS_LAN_IP` | NAS 实际局域网 IPv4 地址；HTTPS 端口只绑定此地址 |
| `NAS_HTTPS_PORT` | 宿主 HTTPS 端口，默认 `3443`；改动时同步修改 origin 和访问地址 |
| `CANVAS_PUBLIC_ORIGIN` | 完整 HTTPS origin，不带路径或末尾 `/`，必须与证书和实际访问地址一致 |

`.env.nas` 已由 Git 忽略。可选音频环境变量暂时留空；部署后可在网页单独配置音频与视频供应商。

### 3. 构建并初始化私有数据

```bash
docker compose --env-file .env.nas -f docker-compose.nas.yml --profile setup build
docker compose --env-file .env.nas -f docker-compose.nas.yml run --rm setup
```

初始化会创建私有目录、随机应用密码、会话密钥和内部连接 token，并保留已有文件。在自己设置的 `NAS_DATA_DIR/secrets/` 中完成以下配置，必要时使用 NAS 管理员权限操作：

| 文件 | 操作 |
| --- | --- |
| `initial-password.txt` | 在本地读取初始应用密码并存入密码管理器；保存后可删除这份明文文件 |
| `password.hash`、`session.key`、`bridge.token` | 初始化自动生成，保留原文件，不复制给浏览器或提交到 Git |
| `tls.crt` | 放入匹配入口域名或 IP 的证书及所需证书链 |
| `tls.key` | 放入对应证书私钥，仅保存在 NAS 私有目录 |
| `outbound-proxy.txt` | 写入单行 `http://OPENWRT_HOST:HTTP_OR_MIXED_PORT`，替换主机和端口；需要的代理认证信息也只保存在此文件 |
| `audio.key` | 初始化为空；使用网页音频设置时可保持为空，使用环境音频配置时才填写对应 Key |

使用本地编辑器填写凭据，不把真实密码或 Key 写进示例、截图、命令记录和仓库。TLS 证书由自己的证书流程签发和续期，项目不会自动生成证书。填好后再次运行初始化以设置文件权限：

```bash
docker compose --env-file .env.nas -f docker-compose.nas.yml run --rm setup
```

已有部署改变 origin 时，初始化会拒绝静默覆盖；需先备份，并按 [NAS 详细指南](docs/content/docs/overview/nas.zh-CN.mdx) 同步处理证书与原配置。

### 4. 加载沙箱策略并授权 Codex

先确认 NAS 已启用 AppArmor，再在源码目录加载仓库提供的 profile：

```bash
sudo install -m 644 deploy/nas/security/apparmor.profile /etc/apparmor.d/canvas-nas-worker
sudo apparmor_parser -r -K /etc/apparmor.d/canvas-nas-worker
```

Compose 同时引用 `deploy/nas/security/seccomp.json`。策略缺失或不兼容时应先排查，不能用 `privileged`、`unconfined` 或完全访问模式绕过。策略依据见 [沙箱说明](deploy/nas/security/README.md)。

```bash
docker compose --env-file .env.nas -f docker-compose.nas.yml run --rm worker login
docker compose --env-file .env.nas -f docker-compose.nas.yml run --rm worker diagnose
```

登录时，在自己的浏览器打开 CLI 显示的授权地址并输入设备代码；认证缓存保存在 NAS 私有卷。诊断检查版本、登录状态、权限和代理 TLS，不发起生成。登录成功不代表批量生成、token 刷新和恢复流程都已通过验收。

### 5. 启动并访问

```bash
docker compose --env-file .env.nas -f docker-compose.nas.yml up -d worker gateway
docker compose --env-file .env.nas -f docker-compose.nas.yml ps
```

浏览器打开 `.env.nas` 中的 `CANVAS_PUBLIC_ORIGIN`，输入初始化生成的应用密码。应用登录固定有效 **7 天**，不自动续期；到期重新登录应用，不会自动退出 Codex 或重新生成任务。

在网页配置中选择服务返回的 Codex 模型。文本和图片由 NAS 上的 Codex 执行；音频 / 视频需要分别配置供应商的 endpoint、model 和 API Key：

- 音频使用 OpenAI 兼容的 `/v1/audio/speech` 下载型 TTS 接口。
- 视频需要兼容项目的视频模板字段，并支持 `/v1/videos` 创建、`/:id` 查询及 `/:id/content` 下载，具体契约见 [NAS 指南](docs/content/docs/overview/nas.zh-CN.mdx)。
- Key 输入留空会保留已保存的 Key；服务端读取接口和浏览器导出不返回 Key。
- 音视频默认沿用 NAS 代理；显式关闭代理才会直连，代理失败不自动降级。无音视频配置不影响 Codex 功能。

### 6. 检查、更新与备份

查看运行状态和最近日志：

```bash
docker compose --env-file .env.nas -f docker-compose.nas.yml ps
docker compose --env-file .env.nas -f docker-compose.nas.yml logs --tail 100 gateway worker
```

对外提交日志前检查是否包含本机地址、路径或任务内容。部署后至少核对 HTTPS 信任、未登录访问被拒绝、模型列表和一项实际生成；生成会使用自己的模型额度。完整验收还包括音视频真实供应商、批量 / 参考图生成、任务恢复、token 刷新、NAS 重启及其他设备访问。

更新前先导出浏览器画布和素材，再停止服务并备份 `NAS_DATA_DIR/secrets` 以及 Compose 的 `gateway_state`、`worker_state`、`codex_home`、`workspace` 四个命名卷。实际卷名由 Compose 项目名决定，使用 Docker 管理工具核对；包含密钥和历史的备份应加密保管。

```bash
docker compose --env-file .env.nas -f docker-compose.nas.yml stop gateway worker
# 完成私有目录、命名卷和浏览器数据备份后，再更新源码
git pull --ff-only
docker compose --env-file .env.nas -f docker-compose.nas.yml --profile setup build
docker compose --env-file .env.nas -f docker-compose.nas.yml up -d worker gateway
```

若更新涉及沙箱策略，启动前重新核对并加载 profile。普通升级不要运行 `down -v`，它会删除命名卷。NAS 任务恢复只核对已有线程和产物，不自动重跑；原目标删除后已有产物仍可下载。项目未设置自动产物清理或保留天数，需要自行管理磁盘空间。

Compose 只发布 HTTPS gateway，worker 不发布宿主端口；它不提供完整出口防火墙。需要强制代理出站时，还应在 NAS / OpenWrt 配置并验证 IPv4、IPv6 出口规则，不能只凭设置了代理变量判断已禁止直连。

## 文档入口

| 内容 | 入口 |
| --- | --- |
| 使用与功能 | [快速开始](docs/content/docs/overview/quick-start.zh-CN.mdx) · [功能介绍](docs/content/docs/overview/features.zh-CN.mdx) |
| 画布操作 | [节点操作手册](docs/content/docs/canvas/canvas-node-manual.zh-CN.mdx) · [快捷键](docs/content/docs/canvas/canvas-shortcuts.zh-CN.mdx) |
| 部署 | [Docker](docs/content/docs/overview/docker.zh-CN.mdx) · [飞牛 NAS](docs/content/docs/overview/nas.zh-CN.mdx) |
| Agent 与扩展 | [Canvas Agent](canvas-agent/README.md) · [Codex app 插件](plugins/infinite-canvas/README.md) · [节点插件开发](plugins/canvas/README.md) |
| 进度与版本 | [待办事项](docs/content/docs/progress/todo.zh-CN.mdx) · [待测试事项](docs/content/docs/progress/pending-test.zh-CN.mdx) · [更新记录](CHANGELOG.md) |

## 来源与开源协议

- **Fork 源地址**：[https://github.com/basketikun/infinite-canvas](https://github.com/basketikun/infinite-canvas)。
- **原版权声明**：`Copyright (c) 2026 basketikun`。
- 本 Fork 继续使用 [MIT License](LICENSE)，保留原始许可证全文与版权声明。使用、修改或分发本项目及其重要部分时，须保留该版权声明和许可声明；软件按原样提供，不附带担保。第三方依赖及提示词来源遵循各自许可证。
