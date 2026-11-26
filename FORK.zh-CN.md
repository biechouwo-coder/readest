# Readest 个人 fork 说明

本仓库是 [readest/readest](https://github.com/readest/readest) 的个人 fork，保留原项目的 AGPL-3.0 许可证、署名和项目说明。README 中的官网、下载、捐赠和社区链接均指向原项目，不能据此认为本 fork 发布了官方安装包。

本次整理前的基线是 `aea3fda086fccf46c9fad765cc1fc0b275b46061`。对比时该分支没有独立于上游的提交，且落后于上游。此状态会变化，请用下面的命令重新核对；本次没有批量同步上游或改动阅读器业务逻辑。

## 克隆与环境

需要近期 Node.js（上游建议 Node 22）、`package.json` 中锁定的 pnpm 10.33.0；构建桌面版还需要 Rust 和对应平台的 Tauri 系统依赖。完整说明见 [CONTRIBUTING.md](CONTRIBUTING.md)。

```bash
git clone --recurse-submodules https://github.com/biechouwo-coder/readest.git
cd readest
corepack enable
pnpm install --frozen-lockfile
pnpm --filter @readest/readest-app setup-vendors
pnpm dev-web
```

只克隆主仓库会缺少 foliate-js、simplecc 等子模块。已克隆但未初始化时，运行 `git submodule update --init --recursive`。不要用 `git submodule update --remote` 替换仓库锁定的版本。

## 常用命令

以下命令均从仓库根目录执行：

| 命令                                              | 用途                                        |
| ------------------------------------------------- | ------------------------------------------- |
| `pnpm dev-web`                                    | Web 开发服务器                              |
| `pnpm build-web`                                  | Web 构建                                    |
| `pnpm start-web`                                  | 启动已构建的 Web 应用                       |
| `pnpm build`                                      | Next.js 的 Tauri 前端构建，不生成桌面安装包 |
| `pnpm tauri build`                                | 生成本机桌面应用，需要 Rust/系统依赖        |
| `CI=true pnpm test`                               | 单元测试，CI 模式运行一次                   |
| `pnpm lint`                                       | 类型检查、Biome 和可用时的 Lua 检查         |
| `pnpm fmt:check`                                  | Rust 格式检查                               |
| `pnpm --filter @readest/readest-app test:browser` | Chromium 浏览器测试，需要 Playwright 浏览器 |

构建、测试依赖 `.env` 配置与 vendor 资源。示例文件在 `apps/readest-app/`；真实密钥放在忽略的 `.env.*.local` 文件中。请勿把签名证书、账号、图书、缓存或私有配置提交到 Git。

## 继续开发与同步

先记录本地状态，再检查上游差异：

```bash
git status
git remote add upstream https://github.com/readest/readest.git
# 已有 upstream 时不必重复添加
git fetch upstream
git log --oneline HEAD..upstream/main
git diff --stat HEAD...upstream/main
```

阅读变更后，在干净的工作区中选择合并或变基，并按原项目要求运行测试；不要对有个人修改的分支直接强制覆盖。新工作分支可使用上游提供的 `pnpm worktree:new <branch-name>`，脚本会处理子模块与资源；执行前应检查本地配置，因为脚本会复制环境文件。

本次补齐了根目录的构建、Web 启动和 worktree 转发命令，并把 Docker 中的 pnpm 版本对齐到仓库声明。个人部署仍需要自己的服务配置与签名凭证，不能直接复用上游发布流程中的 secrets。

## 本次检查记录（2026-11-26）

环境：macOS arm64，Node 22.23.5，按 pnpm 10.33.0 与现有锁文件安装依赖；初始化前端和 Turso 子模块并准备 vendor 资源。

- TypeScript (`tsgo --noEmit`) 与 Biome 均通过。Lua 检查因未安装 LuaJIT 自动跳过。
- 新增的根目录 `pnpm build-web --help` 能正确转发到 Next.js 构建入口；修改的 package.json 与本文档通过 Prettier 检查。
- 单测使用仅测试用途的本地 Supabase URL/占位 key，未连接真实账号。结果为 **3,922 通过、4 失败、31 跳过**；另有 **3 个 PDF 测试套件初始化失败**。失败涉及 EPUB 测试返回空 book、Turso 向量距离精度，以及 jsdom 中缺少 DOMMatrix。
- `apps/`、`packages/` 和依赖锁文件与整理前一致，因此这些是本次环境下暴露的既有测试结果，不代表已定位到某个平台的产品缺陷。没有删除测试或放宽断言。
- 未执行完整 Web 生产构建、Docker 镜像构建、桌面/手机原生构建、签名发布或真实设备测试。

复现时请先按上方步骤初始化子模块和 vendor 资源。测试需要 `NEXT_PUBLIC_SUPABASE_URL` 和 `NEXT_PUBLIC_SUPABASE_ANON_KEY`，可用无真实凭证的本地占位配置；不要为运行单元测试填入生产密钥。
