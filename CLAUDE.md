# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

无限画布 (infinite-canvas) — 一个面向图片创作的开源工作台。Go + Gin + GORM 后端，Next.js (App Router) + React + Zustand 前端。**面向中文用户，UI 文案保持中文。**

详细 AI/自动化开发约束见 [AGENTS.md](AGENTS.md)（必读，比本文件更具体）。

## 常用命令

### 后端 (Go)

```bash
go run .                  # 启动后端，默认监听 :8080
go build -o server .      # 构建二进制
go test ./...             # 当前无测试用例，命令仅供参考
```

后端入口 [main.go](main.go) 会按顺序：`config.Load()` → `service.EnsureDefaultAdmin()` → `router.New().Run(":" + Cfg.Port)`。

### 前端 (Next.js, in `web/`)

```bash
cd web
bun install               # 使用 bun，存在 bun.lock
bun run dev               # 开发模式，0.0.0.0:3000，webpack
bun run build             # 生产构建
bun run start             # 生产启动
```

前端通过 `next.config.ts` 的 `rewrites` 把 `/api/:path*` 代理到 `API_BASE_URL`（默认 `http://127.0.0.1:8080`）。本地开发：先 `go run .` 起后端，再 `cd web && bun run dev`。

### Docker

```bash
docker compose up -d                                     # 拉取 ghcr 镜像
docker compose -f docker-compose.local.yml up -d --build # 本地源码构建
```

镜像内部 Go API 监听 `:8080`，Next.js 监听 `:3000` 并代理 `/api/*`；只对外暴露 `3000`。

### 配置

复制 `.env.example` 到 `.env`。关键变量：`ADMIN_USERNAME`/`ADMIN_PASSWORD`（首次启动创建管理员）、`JWT_SECRET`、`PORT`、`STORAGE_DRIVER`（`sqlite` / `mysql` / `postgres`）、`DATABASE_DSN`、`API_BASE_URL`（前端开发时指向不同后端端口）。

## 架构总览

### 后端分层（严格遵守）

```
handler/      仅处理 HTTP 入参 → 调 service → 返回 OK/Fail（见 handler/response.go）
service/      业务逻辑、默认值、校验、时间/ID、鉴权
repository/   仅做数据库访问和 GORM 查询
model/        数据结构、枚举、简单模型方法
middleware/   AdminAuth、OptionalAuth、NotFoundJSON
router/       唯一路由出口 router.New()
config/       env + godotenv 加载
```

所有业务接口走 `/api/*`，统一响应 `{ code, data, msg }`（`code:0` 成功）。**前端按 `code` 而不是 HTTP status 判断业务结果。** 见 [docs/api-response.md](docs/api-response.md)。

列表接口沿用 `model.Query` + `Normalize` + 标签筛选 + 分页约定（参考 `handler/prompts.go`、`handler/assets.go`）。

数据库使用 GORM `AutoMigrate`，启动时自动维护表结构。当前项目处于开发期，**不写旧字段兼容、不写数据迁移兜底**；改表结构直接按新设计修改。新增表需同步更新 [docs/backend-database.md](docs/backend-database.md)。

### 前端结构

```
web/src/
  app/
    (user)/      普通用户路由：canvas、image、agents、prompts、assets、asset-library、profile、changelog、login
    (admin)/     管理后台：admin/{users,prompts,assets,prompt-categories,ai-configs,generations,credit-logs}
  components/    跨页面共享组件 + ui/（shadcn）
  services/api/  所有后端 API 请求统一收口（envelope `{code,data,msg}`）
  stores/        Zustand 全局 store（ai-config、theme、user）
  lib/           工具函数：canvas-theme、id、image-utils、ai-config、use-image-uploader
```

画布页面位于 `app/(user)/canvas/`，**画布相关状态和组件都收敛在该目录内部**（`stores/use-canvas-store.ts`、`components/`、`utils/`、`constants.ts`、`types.ts`）。不要把画布状态抽到全局 `stores/`。

`/image` 生图工作台主体在 `app/(user)/image/layout.tsx` 渲染（`<ImageWorkspace>`），`/image/page.tsx` 与 `/image/[id]/page.tsx` 都是 `return null`。这是为了**让 ImageWorkspace 在 `router.replace('/image/{id}')` 时不被卸载重挂载**，避免一次生成跑在两个 React 实例上撕裂 state/ref。仿照新页面想做类似深链时要注意同样模式。

### 数据存储边界（已经上云）

**早期文档说"画布项目、素材、AI Key 都在浏览器本地、未上云"——这是过时信息，不要再这么写。** 当前状态：

- **画布、我的素材、生图记录（generations）、角色（agents）、提示词（prompts）** 全部走后端，按 `user_id` 隔离；列表统一 `/api/<resource>/me` 或 `/api/<resource>`。
- **图片二进制** 落服务器磁盘（默认 `data/uploads/{userId}/`），数据库 `images` 表只存 `path + meta`；前端拿到的 `storageKey` (`img-xxx`) 都通过 `GET /api/images/:id` 渲染（公开访问，不带 Authorization 也能 200，命中 `Cache-Control: public, max-age=86400, immutable`）。
- **AI 上游配置（Base URL / API Key / model）** 落 `ai_configs` 表，由管理员在 `/admin/ai-configs` 维护；普通用户拿不到。
- 仍在浏览器本地的只剩：① 用户的轻量偏好（`use-ai-config-store.ts` 只存 `size / quality / count`，并自动上传到 `/api/user/preferences`）；② 个别 UI 状态（如 `/image` 左侧面板是否收起）放 `localStorage`；③ 早期 IndexedDB（`image_files_{userId}`）仅作向后兼容读取，新代码不再写入。

图片节点结构和兼容边界详见 [docs/canvas-data-structure.md](docs/canvas-data-structure.md)。

### AI 调用模型（已改成后端反代）

**早期文档说"前端直接请求 OpenAI 兼容接口"——也是过时的。** 当前所有 AI 请求统一走后端反代：

- 前端调 `/api/v1/images/generations`、`/api/v1/images/edits`、`/api/v1/chat/completions`、`/api/v1/models`；后端读取当前启用的 `ai_configs` 行，拼上 API Key 转发上游，前端永远拿不到 Key。
- 图生图 `/v1/images/edits` 支持两种 body：**首选 JSON `{ prompt, n, size?, quality?, references: ["img-xxx", ...] }`**（references 全是图床 storageKey），后端校验 owner 后从磁盘读图再 multipart 转发上游，请求体只有几百字节；**回落 multipart** 用于画布里截屏/裁剪还没存盘的瞬时图（前端 `requestEdit` 自动识别）。最多 8 张 references。
- 提示词优化 `POST /api/prompts/improve` 在服务端硬编码 system prompt，前端永远拿不到内容；复用 chat 限流（5/min，admin 跳过）。
- 上游 HTML 错误页（504/502/503）被 `handler.parseUpstreamMessage` / `service.parseUpstreamError` 转中文友好提示，前端不会展示 `<html>...` 原文。**用户可见文案中不要使用「上游」这种开发术语**，改成「服务器」「模型」「生图请求」。

## 非显而易见的实现约定（先看，再写）

- **生图两阶段入库**：点击「开始生成」立即 POST 一条 `status:running` 占位 generation，URL 切到 `/image/{id}`；所有 task 跑完后用同一个 `id` upsert 成 `success / partial / failed`。中途关页面 / 网络抖动也能在历史里看到这条调用，slot 显示「生成被中断，请点击重试」（语义不同于真实「生成失败」）。新的"调一次外部 API"流程都参考这套模式。
- **跨 React 实例 race 防护**：长跑任务的「是否还在跑」判断**用 `useRef` 不要用 `useState`**。React 18 自动 batch + 路由切换 + setQueryData 之间可能让 `useEffect` closure 拿到 stale state；`isGeneratingRef` / `activeGenerationIdRef` 永远是最新值。本会话发起的 placeholder.id 也存 ref，避免被「这是别人的 running 占位」逻辑误刷成失败。
- **图片上传统一走 `useImageUploader`**（`web/src/lib/use-image-uploader.ts`）：自动 loading toast、失败友好提示、413 中文化。所有触发上传的入口（按钮 / 粘贴 / 拖拽 / 剪切板 / 头像 / 参考图）都用它，不直接调 `uploadImage`。
- **图片落库后的 URL**：`uploadImage` 返回的 `result.url` 是当前会话的 ObjectURL，**只能用于刚上传后的即时渲染**；要持久化（写入头像、参考图字段、`coverUrl` 等）一律存 `imageUrl(result.storageKey)`（= `/api/images/{id}`），否则刷新 / 换浏览器立刻 404。
- **隐藏 `<input type="file">`**：在 antd Form 嵌套上下文里 `className="hidden"`（Tailwind）会被 Form 子元素 CSS 抢走特异性。**用 `style={{ display: "none" }} tabIndex={-1} aria-hidden`**。多槽位上传（如最多 N 张参考图）建议**共用一个隐藏 input**，靠 `slotIndexRef` 记目标槽位再 `.click()`，避免渲染多份原生 file UI。
- **ID 前缀约定**：`service.newID("agent")`、`newID("gen")`、`newID("aic")` 等，按资源类型加前缀的短 ID；新表新建 ID 沿用这个 helper，不要直接 `uuid`。
- **后端校验所有权**：所有 `/api/.../me` 接口先 `requireUser`，再 `repository.GetXxxByID` 后比对 `saved.UserID == user.ID`。普通用户用 admin 的 ID 越权访问直接返回中文错误，**没有 ownership 校验的 me 接口绝对不能 merge**。
- **chat / improve 限流**：`service.AllowChat(user.ID)` 5/min，admin 跳过；做新「调上游文本模型」类接口时复用这个限流。

## 画布 UI 约束

新增 canvas 组件时**必须**使用 `canvasThemes`、`useThemeStore` 或 Ant Design `ConfigProvider` token；禁止硬编码黑白/stone/slate 颜色（会破坏浅色/深色主题切换）。复用已有工具栏、节点面板、Modal 的视觉风格。图片节点尺寸默认保持原始比例（`freeResize` 切换才放开）。

管理后台主题统一在 `AntThemeProvider` 或全局 CSS 配置，**页面私有组件不要写 `dark ? ...` 主题分支**。

## 文档流程（与代码改动配套）

- 新功能/调整/修复 → 写到根目录 [CHANGELOG.md](CHANGELOG.md) 的 `Unreleased` 节
- 新待办 → [docs/todo.md](docs/todo.md)
- 已实现待用户验证 → [docs/pending-test.md](docs/pending-test.md)（**不要**直接进 `features.md`）
- 用户确认通过后 → 从 `pending-test.md` 迁到 [docs/features.md](docs/features.md)
- 每次任务完成前都要回查 `todo.md` / `pending-test.md` 是否需要同步
- 新增数据表 → 同步 [docs/backend-database.md](docs/backend-database.md)
- 文档**不要**写日期，除非用户明确要求

## 开发风格强约束（来自 AGENTS.md）

- 先读现有代码，沿用既有结构和写法；不顺手重构无关文件
- 项目未上线，**不写旧数据兼容、不写迁移兜底**
- 不为"兼容更多场景"加分支；只实现当前明确需要的功能
- 写完代码**不要**自己跑构建/检查语法，用户会自己验
- 工作区已有用户改动时不回滚、不覆盖，只在必要范围追加
- 页面内只有一个主业务组件时直接写在 `page.tsx`，不要拆 `XxxManager` 再透传一堆 props
- 管理后台页面私有组件放各自页面目录的 `components/`，不要塞到 `admin/components/` 共享目录
- UI 图标优先 `lucide-react` 或已用的 Ant Design 图标
