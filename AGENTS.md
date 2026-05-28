# AGENTS.md

本文档用于约束本项目中的 AI / 自动化开发行为。开发时优先遵循本文件，其次遵循用户当前消息。

## 基本原则

- 先读现有代码，再动手修改，优先沿用项目已有结构和写法。
- 写代码保持最少行数，能简单实现就不要引入复杂抽象。
- 不要为了“兼容更多场景”写大量分支，只实现当前明确需要的功能。
- 项目尚未上线，不需要兼容旧数据；表结构或字段调整时直接按新设计修改，不写旧字段兼容、数据迁移兜底或删除旧表的清理逻辑，除非用户明确要求。
- 每次写完代码，不需要检查语法，不需要执行构建，用户会自己做。
- 不要改无关文件，不要顺手重构。
- 如果工作区已有用户改动，不要回滚，不要覆盖；只在必要范围内追加修改。

## 反复提醒沉淀

- 如果开发过程中总是遇到某个问题，或者用户反复提醒同一个注意事项，需要把该注意事项补充到本文件。
- 补充时写成明确、可执行的规则，避免只写模糊描述。
- 新规则应放到最相关的章节；找不到合适章节时放到“项目注意事项”。

## 后端规范

- 后端使用 Go + Gin + GORM。
- `handler/` 只处理 HTTP 入参、调用 service、返回 `OK` / `Fail`。
- `service/` 放业务逻辑、默认值、校验、时间、ID、鉴权等处理。
- `repository/` 只做数据库访问和 GORM 查询。
- `model/` 只定义数据结构、枚举和简单模型方法。
- 列表接口优先沿用 `model.Query`、`Normalize`、分页和标签筛选方式。
- 业务接口保持 `{ code, data, msg }` 的响应结构。
- 新增数据表时同步更新 `docs/backend-database.md`。

## 前端规范

- 前端使用 Next.js App Router、React、TypeScript、Ant Design、Tailwind、Zustand。
- API 请求统一放在 `web/src/services/api/`。
- 全局或跨页面状态优先放在 `web/src/stores/`。
- 画布相关状态和组件放在 `web/src/app/(user)/canvas/` 内部。
- 页面里只有一个主业务组件时直接写在 `page.tsx`，不要单独拆 `Manager` 组件再传一堆 props。
- 管理后台页面私有组件放到各自页面目录的 `components/` 下，例如 `admin/assets/components/`、`admin/prompts/components/`；不要为了单页面使用放到 `admin/components/` 共享目录。
- 管理后台主题、背景、卡片阴影、表格配色等统一在全局 `AntThemeProvider` 或全局 CSS 作用域中配置；页面私有组件不要自己写 `dark ? ...` 主题分支。
- 组件优先使用函数组件和现有 hooks，不新增大型状态管理方案。
- UI 图标优先使用 `lucide-react` 或项目已经使用的 Ant Design 图标。
- 页面文案保持中文。
- 不要在组件里堆太多无关逻辑；复杂逻辑优先抽成同目录工具函数或小组件。
- 前端业务数据需要浏览器本地持久化时，默认使用 `localforage`；`localStorage` 只用于极小的简单配置，不要用来保存业务列表、生成记录、图片、base64 或大 JSON。

## 画布 UI 规范

- 做 canvas 前端 UI 时必须遵循当前画布主题。
- 优先使用 `canvasThemes`、`useThemeStore` 或 Ant Design `ConfigProvider` token。
- 不要硬编码黑白、stone、slate 等颜色导致浅色/深色主题不一致。
- 新增画布按钮、弹窗、浮层时，尽量复用已有工具栏、节点面板、Modal 的视觉风格。
- 图片节点尺寸逻辑要尊重原始比例，除非功能明确要求自由变形。
- 批量生成、多图展示、助手面板等画布交互要尽量简洁，不要占用过多画布空间。

## 文档规范

- README 保持简洁，只放项目介绍、核心功能、快速开始和文档入口。
- 详细功能介绍写到 `docs/features.md`。
- 后续待办写到 `docs/todo.md`。
- 已实现但还需要用户测试确认的事项写到 `docs/pending-test.md`。
- 面向用户的新增、调整、修复等版本变更写到根目录 `CHANGELOG.md` 的 `Unreleased` 中。
- 每次 todo 事项完成后，先从 `docs/todo.md` 移到 `docs/pending-test.md`，不要直接写进正式功能说明；用户确认测试通过后再更新 `docs/features.md`。
- 每次任务完成前，都要根据实际变更检查并更新 `docs/todo.md` 和 `docs/pending-test.md`；如果功能或待办没有变化，也要确认无需修改。
- 接口响应规则写到 `docs/api-response.md`。
- 数据库结构写到 `docs/backend-database.md`。
- 文档不要写过期日期；除非用户明确要求记录具体时间。

## CHANGELOG 写作风格（重要）

CHANGELOG 是写给**普通用户**看的，不是开发笔记。每条目控制在 1-2 句话，不要展开成"根因 + 修法 + 文件名"的小论文。

**禁止出现**：
- 函数名、变量名（`CollectInUseImageKeys()`、`isGeneratingRef`）
- 文件路径、组件名（`service/image_cleanup.go`、`PromptImproveBar`）
- 接口路径、SQL 列名、表名（`POST /api/admin/storage/cleanup`、`generations.thumbnails`）
- 技术名词（race condition、closure、debounce、reserve-then-confirm、AutoMigrate）
- 调用链分析、内部架构说明

**应该出现**：
- 用户用得到的功能描述（点哪个按钮、看到什么效果）
- 修复了什么样的"用起来不对劲"
- 哪个页面 / 哪个入口（用 UI 上的中文名，不用代码里的英文）

**坏例子**（v0.0.25 原版）：
> `service/image_cleanup.go` 新增 `CollectInUseImageKeys()`，扫描 generations.thumbnails/references、canvases.data 递归 JSON 树……

**好例子**（重写）：
> 管理后台新增「存储管理」页，可以看到所有用户的图片占用情况，一键清理无用图片释放磁盘。普通用户单人图片上限 500MB，超出会提示先清理。

需要技术细节的地方（root cause、文件位置、为什么这么改）写到 commit message 里，CHANGELOG 只保留用户面。

## 部署流程（本项目专用，不要忘）

线上服务器：`root@103.65.39.210`，SSH key `~/.ssh/id_ed25519_nopass`。
镜像仓库：`ghcr.io/ljw0404/infinite-canvas`（私有；服务器有 read:packages PAT）。

**标准发版流程**：

1. 改完代码 + 自测后，按上述「CHANGELOG 写作风格」整理 `Unreleased`
2. `VERSION` 升一位（语义 patch）
3. 把 `CHANGELOG.md` 的 `## Unreleased` 改名成 `## v0.0.X - YYYY-MM-DD`，上方再补一个空 `## Unreleased`
4. `git add -A && git commit -m "release: v0.0.X - 一句话总结" && git push origin main`
5. **运行 `./deploy/deploy.sh`**（不要手敲 docker build / docker push / scp）

`deploy/deploy.sh` 已经做好了完整流程（脚本里都有注释）：
- 本地 `docker buildx build --platform linux/amd64`（镜像约 333MB）
- `docker push` 增量到 ghcr（首次基线 ~3min，后续秒级）
- ssh 到服务器：备份 data（自动保留最近 3 个）→ `docker compose pull` → `docker compose up -d` → 健康检查
- ssh 调用全部带 keepalive + 3 次自动重试（中间路径偶尔切断会自愈）

**常见踩坑（前人经验）**：
- 本地用 ClashX 代理时，`docker push` 可能卡住 / `apt-get` 502。retry 一次通常能过；继续失败就切节点
- `docker build` 拉基础镜像走 `daocloud` mirror（`~/.docker/daemon.json` 已配），不依赖代理
- 服务器磁盘 100% 满了：① `data.bak.*` 累积（deploy.sh 已加自动保留最近 3 个）② docker image 累积（手动 `docker image prune -af`）③ build cache（`docker builder prune -af`）
- ssh 长会话中途 `Connection closed by ...:22` 是常态，deploy.sh 已经处理，不用慌
- 发版完去 https://infinite-canvas.lijiwang.top 验证一下，看 `/api/health` 和真实页面

## 发版本流程

- 发版本时，先把 `CHANGELOG.md` 的 `Unreleased` 变更整理成新的版本记录，并保留空的 `Unreleased` 标题。
- 按当前版本号提升一个版本，更新根目录 `VERSION`。
- 将当前未提交的代码全部提交到 Git。
- 提交完成后，给当前提交打最新版本号对应的 tag，例如 `v0.0.5`。
- 发版本流程中不要执行编译、测试或构建，除非用户明确要求。

## 项目注意事项

- 当前画布项目和“我的素材”主要保存在浏览器本地，不要在文档中误写成已支持云同步。
- 当前 AI API Key 存在浏览器本地，并由前端直接请求 OpenAI 兼容接口；涉及安全说明时要写清楚。
- Docker 静态资源路径目前仍是待办项，文档中不要过度承诺生产部署已经完全验证。
