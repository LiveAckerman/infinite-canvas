# CHANGELOG

## Unreleased

## v0.0.25 - 2026-05-28

+ [新增] **图片存储治理：孤儿清理 + 级联删除 + 用户配额**：之前图片只增不减——画布节点删了、生成记录删了、素材删了，对应磁盘文件全留着；服务器 `data/uploads` 累积到 772MB / 393 张。本次三层治理一并落地：
  - **后端 `service/image_cleanup.go`（新）**：核心是 `CollectInUseImageKeys()`，一次扫描 generations.thumbnails/references、canvases.data（递归 JSON 树）、assets.cover_url/url、prompts.cover_url、agents.avatar_url/reference_image_keys、agent_workstation_cards.reference_key/output_key、pipeline_runs.seed_key/steps[].output_key/manual_override_key/last_run_snapshot.input_key —— 拼出全库 in-use storageKey 集合。`FindOrphanImages()` 返回 in-use 集合外的图片（孤儿）+ 全库统计 + 按用户聚合的占用排名；`CleanupOrphanImages()` 实际执行删除。
  - **级联删除（P1）**：`DeleteGeneration` / `DeleteCanvas` / `DeleteMyAsset` / `DeleteMyAgent` / `DeleteMyAgentWorkstationCard` / `DeleteMyPipelineRun` 删完主表记录后，把这条记录引用过的所有 storageKey 攒成数组，调 `CleanupImagesByKeysIfOrphan(userID, keys)`：扫一遍 in-use 集合，对其中已无引用的图片走 owner 校验后物理删除。被别处仍引用的图（比如同一张图加进了多个画布）会保留。
  - **per-user 配额（P2 lite）**：`SaveImage` 上传前查询 `SUM(size) WHERE user_id=?`，超过 **500MB** 拒绝（admin 无限）。错误文案中文友好：「您的图片存储已达上限（500MB），请清理后再上传」。
  - **管理后台「存储管理」页 `/admin/storage`**：仪表盘展示全库图片数 / 总占用 / 孤儿数 / 孤儿占比；表格列出每张孤儿（owner、类型、大小、创建时间）；按用户聚合的占用排名表；红色「清理全部孤儿」按钮带二次确认弹窗。新增接口 `GET /api/admin/storage/orphans` + `POST /api/admin/storage/cleanup`，仅管理员可调。

## v0.0.24 - 2026-05-28

+ [修复] **生图额度并发扣减 race，余额为 0 仍能继续扣**：用户多 tab / 多次连点「开始生成」时，会观察到 `/admin/credit-logs` 出现「-1 → 余额 0」的多条连续记录 —— 看起来扣到 0 还能继续扣。**真正根因**：① `handler/ai_proxy.go` 调 `service.ConsumeCredits` 时把第二个返回值（`ok bool`）用 `_` 丢了，余额不足时 `RowsAffected=0` 返回 `(0, false, nil)`，handler 仍把这个失败当成功走了 `logImageConsume` 写流水 + 把图返给用户；② pre-check `user.Credits <= 0` 用的是请求开始时从 DB 读的快照，多个并发请求同时进来都看到正余额都过 pre-check，下游也都成功生图返回，只有第一个 `ConsumeCredits` 能扣到，其余扣减失败但流水照样记录 —— 形成「1 块钱白嫖 N 次」漏洞。**修法**：handler 改成「reserve-then-confirm」模式 —— 请求开始时按 payload.n（edits 兜底按 1）原子预扣，上游失败 / 数量为 0 全额 `service.RefundCredits` 退回；上游返回 N 小于预扣数退回差额，N 大于预扣数（极少见）补扣；补扣失败时只按 reserved 张数计费、多生的几张算白送不强制扔图。新增 `service.RefundCredits` + `repository.RefundUserCredits`（原子 `credits + ?`）。从根本上让 DB 层的 `WHERE credits >= ?` 原子条件成为唯一防线，pre-check 不再被并发绕过。

+ [修复] **流水线 run 跑到一半刷新页面会无限卡在 loading**：客户端调度器 `usePipelineRunManager.scheduleFromCache` 之前只接管 `status === "queued"` 的 run，看到 `running` 状态默认是「别 tab 在跑」直接跳过。但用户刷新页面时，原来的 tab 已经死了，没有任何 tab 在接管 → run 永远卡死。修复加了两层兜底：
  - **本 tab ownership 标记（sessionStorage）**：runner 启动一条 run 时往 sessionStorage 写入 `infinite-canvas:pipeline-run-ownership:{runId}` 标记，跑到终态时清掉。sessionStorage 的特性是「跨刷新保留、跨 tab 隔离、tab 关闭/crash 清空」，正好符合「我刷新后接管自己之前在跑的」语义。
  - **5 分钟孤儿超时兜底**：scheduleFromCache 扫描 cache 时，对 `status === "running"` 且本 tab 不在 inflight 的 run，检查：① 本 tab 之前 own 过 → 接管恢复；② 没 own 但 `updatedAt > 5min` → 也接管（防止别 tab crash 留下死锁、跨设备遗留等）。其余视为「别 tab 在正常跑」，仍按原逻辑跳过避免双重执行。
  - **恢复动作**：`recoverStaleRun()` 把 `step.status === "running"` 的步骤重置为 `idle`（runner 看到 idle 会继续跑那一步；已 success 的步骤不动自动跳过）。run.status 改 `queued`、立即乐观更新 cache 让 UI pill 从「运行中」变「排队中」、PUT 写回后端、加入 inflight、调 `runRun` 接管。
  - 多 tab 共用同账号的场景：sessionStorage 是 per-tab 的，Tab B 看不到 Tab A 的 ownership 标记，所以 Tab B 不会接管 Tab A 还在正常跑的 run（updatedAt 仍在 5min 内）。只有真孤儿才会被 Tab B 救活。

+ [修复] **`/image` 生图工作台左侧记录列表混进了 `/agents` 角色工作台的图**：之前 `fetchGenerations(token, { page: 1, pageSize: 100 })` 没传任何过滤参数，返回的是用户名下所有 generation（包括 `/agents` 工作台保存的、带 `agentId` 的那些）。`/agents` Drawer 之前已经用 `hasAgent=1` 筛过自己一半；但 `/image` 这边一直缺一个反向的「排除角色工作台」筛选。修复：
  - 后端 `model.Query` 加 `ExcludeAgent bool` 字段，`parseQuery` 接受 `excludeAgent=1 / true`，`repository.ListGenerations` 在 `ExcludeAgent` 为 true 时加 `WHERE agent_id IS NULL OR agent_id = ''` 子句（SQLite 历史数据里这列可能两种空状态都有）。优先级 `AgentID > HasAgent > ExcludeAgent`。
  - 前端 `GenerationQuery` 类型加 `excludeAgent?: string`；`image-workspace.tsx` 的 `logsQuery` 传 `{ excludeAgent: "1" }`，并把 react-query queryKey 改成 `["my-generations", "exclude-agent", token]` —— 跟 `/agents` Drawer 的 queryKey（不带 `exclude-agent` 段）分开，避免一边的 `setQueryData` / `invalidateQueries` 把另一边的缓存搞污。`saveLogMutation.onSuccess` 的乐观写入也同步用新 key 落点，保证「点开始生成 → 列表立刻刷新出现新记录」依然瞬时。
  - 隔离结果：`/image` 左侧只看到从 `/image` 和 `/canvas` 发起的记录；`/agents` Drawer 只看到从角色工作台发起的记录；两边内容互不重叠，DB 里仍然是一张 `generations` 表。

+ [修复] **后端业务错误（如「额度不足，请联系管理员」）在前端被降级显示成「请求失败」**：根因是 `services/api/image.ts` 的 `requestGeneration` / `requestEdit` 包了一层「外层 try 抓所有 error → 再 throw new Error(readAxiosError(error, "请求失败"))」的兜底逻辑——本意是处理网络层错误，结果把内层 envelope 解析后已经正确提取的 `error.message`（中文业务错误）又走了一遍 readAxiosError 流程；这条流程在某些边缘情况（envelope.msg 短暂被覆盖、Error 对象被特殊属性误判成 AxiosError 等）下会把消息降级到 fallback "请求失败"。修复方式：拆成两段，先做 axios 请求只 catch **「网络层失败」**，然后**直接**读 envelope.code / msg，envelope.msg（如「额度不足，请联系管理员」）现在能 100% 透传到 UI 的 FailedImageCard / 角色卡的错误条 / 顶部 toast。同时给 `readEnvelopeError` / `readAxiosError` 加了 `msg.trim() && msg !== "ok"` 防御性判断，避免空 msg / 兜底 "ok" 串进错误链；envelope 非空但格式异常时也会走 `describeStatus` 兜底。失败时 console.error 落一行原始 envelope 内容，DevTools 能直接复盘。

+ [调整] **`/v1/images/edits` 参考图上限定为 9 张**：之前 8 张太死板（用户传 9 张就被拒），上次改到 16 又怕用户拿着 16 张去喂模型遭遇质量崩。最终落到 **9 张** —— gpt-image-2 实践中超过 4 张关注度就会被稀释，9 张是「比 4 张多一点的余量 + 仍在可用范围内」的折中。`handler/ai_proxy.go:editsJSONReferenceLimit = 9`，超过返回「参考图数量超过上限（最多 9 张）」。multipart 路径（画布瞬时图）本来就没设硬上限，由前端 50MB 体积阈值兜底。

## v0.0.23 - 2026-05-22

+ [新增] **角色工作台两处提示词输入框接入「提示词优化」**：跟 `/image` 工作台 / 画布节点 prompt 面板 / 画布助手输入框一样，复用 `<PromptImproveBar>` 组件——
  - **并行模式卡片的「附加说明」TextArea** 下方：读卡片当前 `extraNote`，点优化后预览面板出在 TextArea 下面，接受时调 `handleExtraNoteChange(improved)` 自动 800ms 防抖 PUT 回 `agent_workstation_cards` 表；`status === "running"` 期间按钮禁用。
  - **角色编辑 Modal 的「系统提示词」Form.Item** 下方：通过 `form.getFieldValue("systemPrompt")` 读当前值，接受时 `form.setFieldsValue({ systemPrompt: improved })` 写回；`submitting` 时禁用。
  - 复用 chat 限流（5/min；admin 跳过）；服务端硬编码 system prompt（前端拿不到 system prompt 也拿不到 API Key）。

+ [调整] **角色工作台并行模式：成功后加「重做」按钮，改附加说明可直接重做**：之前生成成功后只有「下载 / 加入素材 / 再来一张」三个按钮，「再来一张」点了只清空回 idle，用户还要再点一次「开始生成」才能跑——两步操作。改成 ——
  - **新增「重做」蓝色主按钮**（`RotateCw` 图标）：直接调 `generate()` 用**当前**的原图 + 附加说明（用户可能在 success 状态下改过）重新跑一次。status 立即切回 running，新产物回来时 setResult 覆盖旧的。tooltip 「用当前的原图和附加说明直接重做」。
  - 「再来一张」改成 `type="text"` 的次要「清空」按钮，仍调 `resetForNext()` 清空回 idle 状态，留给「想从头开始换图换说明」的场景。
  - 附加说明 TextArea 在 success 状态本来就允许编辑（debounce 800ms PUT 回库），现在配合「重做」按钮形成完整闭环：改说明 → 点重做 → 拿新产物。
  - 行为不影响产物上云：生成完成后跟之前一样调 `onPersistCard({ status, outputKey, errorMessage, durationMs })` 推到 `agent_workstation_cards` 表。

## v0.0.22 - 2026-05-22

+ [调整] **`/image` 二次生成改成编辑现有 record，不再新建**：上一版「二次生成产物追加」改的只是 UI 累加（每点一次仍新建一条 generation record，左侧列表越点越多）。这次进一步把数据模型也改了：当 `previewLog` 存在且不是从「微调」按钮触发时，generate() **直接 PUT 编辑现有 record**，不创建新 placeholder：count / thumbnails / errors / durationMs 全部累加；prompt / refs / size / quality / requestParams 取本次最新；URL 不变。三种触发的语义：
  - **没有 previewLog**（点过「新建」或首次进 /image）→ 创建新 record（保留原行为）
  - **有 previewLog 且非微调**（同记录内迭代）→ 编辑现有 record，累加这次的 batch
  - **微调按钮触发**（有 `pendingParentIdRef`）→ 仍创建新 record + `parentId` 串到源记录（保留派生子记录的语义）
  - 想强制开新一条 → 走左侧「新建」清掉 previewLog
  - 中途刷新页面：第一阶段 PUT 已把 count 升到累加值、thumbnails 仍是旧的，刷新瞬间 `previewGenerationLog` 看到 `status=running` 且不是「自己的 placeholder」（isGeneratingRef=false），剩余 slot 渲染成「被中断」红卡片可重试，符合既有两阶段入库语义。
  - toast 文案区分：编辑模式跑成功 → 「图片已追加」；新建模式 → 「图片已生成」。
  - 左侧记录列表：连续多次迭代后只看到 **1 条记录**（不再每点 +1），thumbnails 计数累加。

+ [修复] **`/image` 生图工作台两个相关的「二次生成」bug**：
  - **改参考图后再点开始生成，生成完成瞬间参考图被回退到上次的旧值**。根因是 auto-preview useEffect 跟 `generate()` 之间的 race window —— generate() 同步执行链里依次：① saveLogMutation.onSuccess 把新 placeholder 推进 logs cache（`logs.length` +1）、② `autoPreviewedIdRef.current = placeholder.id`、③ `router.replace('/image/{placeholder.id}')`。但第 ③ 步 router.replace 不会同步更新 `initialLogId` prop，要等下一次 render。中间会出现一个 render 状态：`logs.length` 已变 / `initialLogId` 还是上一条记录 id / `autoPreviewedIdRef` 已经是新 placeholder。这时 useEffect 触发（dep `logs.length` 变了），条件 `autoPreviewedIdRef === initialLogId` 不成立，进入正常分支拿**旧的** initialLogId 找 target log，调 `previewGenerationLog(旧 log)` → 把 refs / prompt / count / size / quality 全部回填成旧记录的内容 → 用户刚改的参考图被覆盖。修复：useEffect 顶部加 `if (isGeneratingRef.current) return;`，整个 generate 期间不允许 auto-preview 反向覆盖 workspace state。
  - **二次生成的产物把第一次的结果替换掉**。`generate()` 第一行 `setResults(Array.from(...))` 整段重置 results，所以连续点几次「开始生成」只能看到最后一次的结果。改成**追加**：`const slotOffset = results.length; setResults((prev) => [...prev, ...newSlots])`，并把 `slotOffset + index` 作为绝对位置传给 `runGenerationSlot`，updateResultAt 落点不会冲突。想清空回到「干净的工作台」走左侧「新建」按钮（沿用 `createSession` 的 `setResults([])`）。切到左侧别的历史记录看时 `previewGenerationLog` 仍是替换语义（用那条记录的图替换 results，避免历史视图和当前会话混淆）。每条 generation 记录在 DB 里**仍只代表自己这次的 batch**，刷新页面会回归 canonical 视图。

## v0.0.21 - 2026-05-22

+ [新增] **`/image` 工作台参考图支持点击放大预览**：参考图横向列表里每张缩略图的 `<img>` 换成 antd `<Image>`，所有缩略图共享一个 `<Image.PreviewGroup>` —— 点击任意一张打开全屏预览，浮层里能左右切换浏览全部参考图、缩放、旋转、键盘 ←→。和 `frontend-design` skill 强调的「画布图片节点可点击放大」是同一套预览体验。拖动重排不受影响（PointerSensor 6px 距离阈值 + 整张缩略图仍是 drag handle）；X 删除按钮的 `pointerdown` 和 `click` 都 stopPropagation，所以点 × 不会被误识别成「点开预览」或「开始拖动」。

+ [新增] **并行模式工作区数据上云**：之前「加入工作区的角色 + 每张卡的原图 / 附加说明 / 产物 / 错误」要么在 localStorage（仅工作区角色列表），要么只在内存（卡片状态全丢），换设备 / 清浏览器就什么都没了。本次完整上云：
  - **新表 `agent_workstation_cards`**：字段 `id / user_id / agent_id / position / reference_key / extra_note / output_key / status / error_message / duration_ms / 时间戳`，按 `(user_id, agent_id)` 唯一（每个角色在工作区里最多一张卡）。`status` 只入库 `idle / success / failed`，**running 不入库**（页面挂掉后 task 没法续跑，恢复时按 idle 渲染留个手动重做入口）。
  - **CRUD 接口** `me.{GET,POST,DELETE} /api/agent-workstations/me[/:id]`：upsert 按 `(user_id, agent_id)` 自动认成 update 或 insert；reference_key / output_key 非空时强制 owner 校验；前端不区分 insert / update，都走 POST。
  - **前端「加入 / 移出工作区」**：之前 `workspaceIds` 存 `localStorage:infinite-canvas:agents:workspace:{userId}`，现在改成 react-query 查 `/api/agent-workstations/me`；加入工作区 = POST 新建卡（`position = max+1, status=idle`），移出 = DELETE 卡。`workspaceIds` 从 Set 派生。**localStorage 的工作区列表 key 不再读不再写**，旧本地数据自然过期；按 AGENTS.md 项目期约定不写迁移。
  - **AgentWorkstation 内部状态全部上云**：组件新增 `initialCard` + `onPersistCard` 两个 prop，mount 时从 server card hydrate 各 useState（reference / extraNote / status / result / errorMessage），关键时机调 onPersistCard 让父层 PUT 回库 —— ① 上传 / 移除原图 → 立即 PUT `referenceKey`；② 改附加说明 → **debounce 800ms** PUT `extraNote`（避免连打字每个字符一次请求）；③ 生成成功 / 失败 → 立即 PUT `status + outputKey + errorMessage + durationMs`；④ 点「再来一张」重置 → PUT 把这 4 个字段都清回 idle。
  - **跨设备验证**：A 浏览器加几个角色到工作区、给每张卡上传原图、跑出产物，再到 B 浏览器登录同账号进 `/agents`，工作区应该原样恢复（同一批角色卡 + 上次的原图缩略 + 附加说明 + 上次的产物图）。第一次 mount 会有 ~300ms 的 list 拉取 loading，之后操作都是乐观更新 + 后台 PUT。
  - **越权防护**：所有接口都用 `requireUser` + `ownership check`；service 校验 `agent.UserID == user.ID` 才允许写，`reference_key / output_key` 非本人图片直接报错。

## v0.0.20 - 2026-05-22

+ [新增] **流水线列表卡支持「重新执行」**：之前「执行 / 多选执行 / 全部执行」只对「待执行（paused + 有 seed）」状态生效，导致已完成 / 失败的 run 想再跑一次只能去详情页点「全部重跑」。现在 list 卡的「eligible」语义扩展为「有 seed 且不在跑」—— 涵盖 paused / success / partial / failed 四种状态：
  - **单条**：有产物的 run（success / partial / failed / 跑了一半 paused）主按钮保持「打开」(看历史结果是高频操作)，旁边并列一个次要按钮「↻ 重新执行」（`RotateCw` 图标 + tooltip 说明"清空旧产物从第 1 步重新跑"）。
  - **多选 / 全部**：Checkbox / 顶部「执行选中 N」「全部执行 N」覆盖范围同步扩大；批量工具栏下方加一行提示文案「包含「待执行」「已完成」「失败」的流程；点了会清掉旧产物从第 1 步重新跑。想保留旧结果请改用「复制」」，避免用户误触把已完成的 run 全清掉。
  - **启动逻辑**：内部抽出 `buildResetRun()` —— 把每步 status 重置为 idle，清掉 outputKey / errorMessage / durationMs / lastRunSnapshot，再把整体 status 推到 queued。这是必要的，否则调度器 `runRun` 看到 `step.status === "success"` 会跳过整步，「重新执行」就会变成「无操作」。
  - 旧 outputKey 对应的图床文件**不删**，已经被加入素材 / 复制 run 引用的图都不受影响。
  - 状态 pill：success → 「全部完成」绿色；partial → 「部分完成 N/M」橙色；failed → 「失败」红色。点「重新执行」后立即变蓝色 → 排队中 → 运行中。

+ [新增] **流水线单步「迭代微调」模式**：详情页一步如果**已经成功跑过有产物**了，用户在附加说明里加一段指令（例如「将衣服改成红色」），点重做按钮时会切到「迭代」模式 —— 把这一步**自己刚才的产物**作为输入图、叠加上新附加说明再调用模型一次，**不会**从上游产物 / seed 重新跑。典型场景是基于已有结果做小修小补，比起重头跑更快、更能保留之前的构图和风格。如果用户只是常规点重做（没改附加说明）/ 上游变了，仍然按以前的「上游/seed/手动覆盖 + 角色提示词」重头跑。
  - **触发条件**（跟 backend snapshot 的 `inputSource` 字段联动）：本步有 outputKey + 附加说明非空且跟 lastRunSnapshot.extraNote 不同 + 「上次本身就是 iterate」或「上次是 upstream 且 upstream 至今没变」。其它情况按 vanilla 重做走。
  - **UI 提示**：当下一次点击会走迭代时，按钮文案换成「基于产物微调」、图标变成 `Sparkles`、`Tag` 由金色「上游已变更」改成紫色「将基于产物迭代」；Tooltip 写明这两种行为差异（迭代 vs 重头跑）。
  - **持续迭代**：连续多次「加一点说明 → 微调」会持续基于最新一次的 outputKey 迭代下去（不会回退到上游），靠 `lastRunSnapshot.inputSource: "iterate"` 标记保持链条。
  - **stale 检测同步调整**：上次是 iterate 模式时只看附加说明是否又变了（上游变了不再触发 stale），避免迭代过一次后永远被误判为「上游已变更」。
  - **后端**：`model.PipelineRunStepSnapshot` 加 `InputSource string` 字段（`omitempty`，老数据缺省视作 `upstream`，零迁移压力）。前端 `PipelineRunStepSnapshot.inputSource` 同步加。

+ [调整] **执行流程改成手动触发**：之前上传完原图就自动 queued 让调度器跑，现在改成「上传原图后保持 paused 状态」，由用户**显式触发**才进 queued。三种触发方式：
  - **单条**：每张卡片在「已上传原图 + 待执行」状态下显示蓝色「▶ 执行」主按钮（替代「打开」位置），点了把 status 推到 queued。
  - **多选**：每张「待执行」卡片左上角有 Checkbox 可勾，列表上方批量工具栏显示「全选可执行（N）/ 已选 N 条 / 执行选中 / 全部执行」。勾中态卡片有蓝色 ring 高亮；非「待执行」状态的卡 Checkbox 置灰、勾不上。
  - **全部**：批量工具栏右侧「全部执行（N）」蓝色主按钮，一键把所有「待执行」run 推进 queued，调度器按 cap=3 顺序跑。
  - 状态 pill 文案区分：seed 未传 → 金色「待上传原图」；seed 已传 + paused → 金色「待执行」；queued / running / success / partial / failed 不变。
  - 后端：`saveMyPipelineRun` 不再因为上传 seed 自动改 status，前端 PUT 时显式带 `status: "queued"` 才触发执行；批量串行 PUT（避免一次性打太多写请求），调度器最终用 cap=3 并发跑。

+ [修复] **流水线 detail 页单步「用新输入重做」/「重做」/「重试」的三个体验问题**：
  - **点击按钮没有 loading 反馈**：根因是 `runSingleStep` 先 `await persistRun(running 状态)` 才会让 cache 进入 running 态，整个 PUT 往返期间 UI 没动静。改成「立刻乐观把 step.status 同时改到 list 和 detail 两份 react-query 缓存（`applyStepPatchOptimistically`），PUT 在后台异步走」，点完按钮**立刻**出 `Loader2` spinner + 「正在生成…」。
  - **重做完产物没立即替换**：同样的乐观更新模式 —— `invokeStep` 一返回，先把 `outputKey + status: success + durationMs` 写进缓存（两份），用户**立刻**看到新图，然后才在后台 PUT 写库。失败也立刻显示红色错误条 + 重试。
  - **用户填写的附加说明被覆盖丢失**：根因是详情页用 `[...RUNS_QUERY_KEY, runId]` detail cache，runner 读 `RUNS_QUERY_KEY` list cache，两份不同步；并且 runner 的 PUT 用了**事先抓的 `working` 快照**，会把用户在 `invokeStep` 期间在 detail 页继续敲的附加说明、换的角色、换的覆盖图全覆盖回旧值。解决方案：① 详情页的 `patchRun` 改成「乐观更新 detail + list 两份缓存」+ 「不在 mutation onSuccess 里 `setQueryData`」，避免服务器响应延迟把用户连续打字的字符回退；② runner `persistRun` 在 PUT 前用 `mergeUserEditableFields` 从最新缓存里读回 `extraNote / manualOverrideKey / agentId / agentName / avatarUrl` 等**用户可编辑字段**，保证 runner 的 PUT 只写 runner 自己管的字段（status / outputKey / errorMessage / durationMs / lastRunSnapshot），不动用户编辑的部分。
  - 附带修复：`handleRestartAll` / `handleContinueFromStep` 改走同一个 `patchRun` 通道，统一乐观写两份缓存，UI 切到 `queued` 立刻反应；连点连改场景下不会再出现 textarea 字符消失。

+ [重构] **流水线模式拆分成「模板 + 执行流程」两套概念**（option A 方案，浏览器端并发 cap=3）：
  - **流水线模板（编排）**：新建 / 编辑全部走 Modal（`PipelineTemplateModal`），关闭时有 dirty 检测 + 二次确认。「管理流水线模板」按钮弹 `PipelineTemplateManagerModal` 列出 / 复制 / 删除 / 编辑全部模板。原来 `/agents` 主区域内嵌的编辑器全部撤掉。
  - **执行流程（运行实例）**：新表 `pipeline_runs`（id / user_id / pipelineId / pipelineNameSnap / seedKey / steps[JSON] / status / 时间戳）+ CRUD 接口 `me.{GET,POST,GET,PUT,DELETE} /api/pipeline-runs/me[/:id]` + 流式 zip 下载 `GET /api/pipeline-runs/me/:id/zip`（stdlib `archive/zip` 边读边写，零内存压力，按 `{序号}_{角色名}.{ext}` 命名）。
  - **新增执行流程**：「+ 新增执行流程」按钮弹 `PipelineRunCreateModal`：Select 模板 + 上传原图（复用 `PipelineSeedCard`）+ 启动 → 后端 `POST /api/pipeline-runs/me` 创建 run（status=queued，每步 agentName/avatarUrl 快照到 step 里，模板被删/角色被改名都不会丢）→ 前端 cache 立即插入新行 → RunManager 接管。
  - **客户端调度器 `usePipelineRunManager`**：单 tab 级别，cap=3 并发；从 react-query 缓存里挑 queued run，启动后串行跑步骤，每步开始/结束 PUT 写回后端；用 `inflightIdsRef`/`cancelledIdsRef` 锁防止并发触发与中途停止；终态判定 success/partial/failed。挂在 `/agents/layout.tsx` 的 `PipelineRunManagerProvider` 里，列表页与详情页共用同一个调度器实例，跨页导航不打断在跑 run。
  - **执行流程列表卡**：`PipelineRunCard` 显示模板名 + 状态 pill（排队中 / 运行中 N/M / 已暂停 / 全部完成 / 部分完成 / 失败）+ seed → 步骤的小缩略图横排（状态色：绿成功 / 红失败 / 蓝脉冲运行中 / 灰未运行）+「打开」「下载所有产物 (zip)」「删除」三按钮。当列表里有 queued/running 项时 react-query refetchInterval 3 秒拉一次列表，否则不轮询省请求。
  - **执行流程详情页 `/agents/runs/[id]`**：子路由（不是 Modal，方便分享 / 刷新 / 书签）。顶栏「返回 / 模板名 / 状态 / 步骤计数 / 全部重跑 / 下载 zip / 删除」；下方原图卡 + 步骤卡链。每张步骤卡支持：① 改附加说明（PUT 回库）、② 替换输入图（手动覆盖，走 `useImageUploader`）、③ 单步「重做 / 重试」（直接调 `runner.runSingleStep` 不走队列、不影响其它步）、④ 「从此处续跑」（把该步及之后全部重置为 idle + run 标 queued → RunManager 接管）、⑤ stale 判定（输入 key 或附加说明跟 lastRunSnapshot 不一致时显示金色「上游已变更」+「用新输入重做」按钮文案）、⑥ 失败显示红色错误条、⑦ 切换该步的角色（不再用拖拽换序，运行实例不能改顺序）。
  - **角色 / 模板被删的兜底**：run 创建时 snap 了角色名 + 头像，模板被删后 run 详情仍能渲染；如果某步引用的 agent.id 已经不存在，对应步骤显示红色「角色已删除」+ Select 可改成存在的角色。模板管理 Modal 里每条模板用红色 Tag 标「N 个角色已删」。
  - **顶栏提示「单浏览器最多并行 3 条；超出会进排队」**，缓解多 tab 用户期望（每 tab 自己 cap=3，未做全局协调）。

+ [新增] **流水线运行时持久化**：`/agents` 流水线模式跑出的产物（seed 原图 + 每一步的输出图 / 状态 / 错误 / lastRunSnapshot / 手动覆盖图 / 用时）现在按用户 + 流水线 id 隔离存到 localStorage（key=`infinite-canvas:agents:pipeline-runtime:{userId}:{pipelineId}`），刷新页面 / 重开浏览器都能恢复上次跑的结果。图床里的图本来就在服务器，前端只持久化 storageKey 数组，URL 在恢复时通过 `imageUrl(key)` 现拼。`running` 状态降级为 `idle`（页面挂掉后 task 没法续跑，留个手动重跑的入口）；删除流水线时同步清掉对应的 localStorage 快照。切换流水线 / 切账号都会自动加载新 id 对应的快照，A 看不到 B 的运行结果。
+ [调整] **`/agents` 整页 UI 优化 + 移动端/桌面端兼容**：大布局（左库右 Tab）不变，按 `frontend-design` skill 的 8 点 checklist 走了一遍，集中处理了多个样式 bug 和窄屏体验问题——
  - **页头**：标题 `text-xl` 起步（lg+ `text-2xl`），副标题 `< sm` 隐藏（窄屏给工作区留出更多垂直空间）。
  - **左库 mobile 限高**：手机/平板 stacked 模式下侧栏 `max-h-[45vh]`，避免长角色列表把右侧 Tab 推到首屏外；桌面 `lg:max-h-none` 恢复全高独立滚动。
  - **Tabs 内边距响应式**：手机 `px-3 pb-3`，桌面 `lg:px-4 lg:pb-4`，对应 antd 内部 `[&_.ant-tabs-nav]` / `[&_.ant-tabs-content-holder]` 都做了断点。
  - **流水线模式工具栏合并**：原来「选择条」+「控制条」两条独立 bar 合并为一条横向工具栏，主操作（▶ 运行）放右侧 `ml-auto`、视觉权重最高；次要按钮（另存为 / 复制 / 删除）在 `< md` 只露图标省宽度；状态提示文本独立成一行轻量元信息。
  - **流水线 step / seed 卡响应式宽度**：`w-[280px] sm:w-[300px]` / `w-[240px] sm:w-[260px]`，窄屏更紧凑；末尾「+ 添加步骤」按钮同步 `w-[140px] sm:w-[160px]`。
  - **触摸目标加大**：grip 把手 / X 按钮 / ⋯ 菜单从 `size-6` (24px) 升到 `size-7` (28px)，符合移动端 32px 触摸目标的下限。
  - **工作站卡修复**：① `<input type="file" className="hidden">` 改成 `style={{ display: "none" }} tabIndex={-1} aria-hidden`，跟 skill 里强调的「Tailwind hidden 在 antd Form 上下文会失效」对齐统一；② 状态徽标移到独立的第 2 行右对齐，避免「长角色名 + 长状态 pill + X」三者抢宽度互挤；③ 去掉 `min-w-[260px]` 强制宽度（在窄屏会溢出网格），改用 `min-w-0` 让网格控制。
  - **工作区网格对齐**：grid 加 `items-stretch`，多列时卡片底部对齐不再参差。
  - **并行 tab 顶部「生成记录」按钮**：`< sm` 只露图标，文字 hidden，省宽度避免计数 Tag + 描述文本 + 按钮三者挤一行。

+ [新增] **`/image` 工作台参考图支持拖动重排**：参考图横向列表里每张缩略图都可以拖动调整顺序，复用画布里同款 `@dnd-kit`。顺序对上游 `/v1/images/edits` 是有语义的（第一张往往被模型当主要构图参考），用户拖完再点开始生成 / 重试时 references 数组就是新顺序。拖动触发距离 6px，X 删除按钮的点击单独 stopPropagation，所以点 × 删除不会被误识别成拖动；同时缩略图加了 `draggable={false}` 阻止浏览器原生「拖图标到地址栏」副作用。
+ [调整] **`/agents` 左侧角色卡的「+ 加入工作区」按钮在流水线模式下隐藏**：这个按钮只有并行模式下有意义（把角色添加到独立工作台网格里）。流水线模式有自己的「+ 添加步骤」+ 角色 Select 来选角色，留这个按钮反而让人误以为也能加进流水线，所以模式切到「流水线」时直接隐藏，只保留卡片底部的「已用 N 次」。`AgentLibraryCard` 新增可选 prop `showAddToWorkspace`（默认 true），`page.tsx` 把 `mode === "parallel"` 透传进去。

+ [调整] **`/agents` 改成左库右 Tab 双列布局**：原来「我的角色（顶部横滚卡片）+ 工作区（下方网格）」上下堆叠 + 顶部 Segmented 切换模式，变成 ——
  - **左侧 280–320px 固定边栏**：「我的角色」列表 + CRUD 全集中在这里，顶部「+ 新建」按钮 + 搜索框 + 下方独立竖向滚动的卡片列表（卡片宽度自适应、不再横滚）；
  - **右侧主区域 Tab 切换**：`并行模式` / `流水线模式` 改用 antd Tabs，原 Segmented 撤掉；
  - 两列在桌面端 `lg+` 各自有独立的 `overflow-y-auto`，主页面不再整体滚动；窄屏（< `lg`）退化为「上库 + 下工作区」竖向堆叠，跟之前的体验接近不会丢操作；
  - 「生成记录」按钮移到并行模式 Tab 内顶部一行，跟工作区计数挨在一起；模式偏好仍然按浏览器 localStorage（`infinite-canvas:agents:mode`）持久化。

+ [新增] **角色工作台「流水线」模式（可 CRUD）**：`/agents` 顶部新增 Segmented 切换「并行模式 / 流水线模式」，模式偏好按浏览器持久化。流水线模式让用户把多个角色串成一条链，**上一步的产物自动喂给下一步**，并支持以下完整能力：
  - **编排**：横向流水线视图，最左侧「原图 seed」卡（拖/粘/上传/剪切板）→ 中间 N 个角色步骤卡（最多 10 步，序号 + 角色 Select 切换 + 附加说明 TextArea + 输入图缩略 + 输出图缩略 + 状态 pill + 单步「重做/重试/运行」按钮）→ 末尾「+ 添加步骤」。步骤间 `ChevronRight` 箭头表示数据流向。
  - **拖拽换序**：基于 `@dnd-kit/core` + `@dnd-kit/sortable`，每张步骤卡左上 grip 把手；拖完所有步骤的 `lastRunSnapshot` 自动失效（链已变），需要重跑。运行中禁用拖拽。
  - **三种输入源（每步独立）**：① 来自上一步的产物（默认）；② 用户在该步「替换输入」手动上传一张图覆盖；③ 第一步取 seed。手动覆盖时显示橙色 `Pencil` 图标 + 「手动替换」标签，可一键「用上游」恢复。
  - **每步独立重做**：每张步骤卡都有自己的「重做 / 重试 / 运行」按钮，**不会自动级联到下游**。下游步骤检测到自己的输入 key 或附加说明跟 `lastRunSnapshot` 不一致时，pill 变金色「上游已变更」、输出图右上角出现琥珀色「已变更」徽标，提示用户手动点重做。
  - **顶部智能运行按钮**：根据当前状态自动切换标签 ——「▶ 运行流水线」（全部 idle 时）/「▶ 从第 N 步续跑」（有 stale / failed 步骤时）/「▶ 全部重跑」（全部 success 且无 stale 时）。运行中显示「停止」按钮。
  - **流水线 CRUD**：顶部选择条提供 Select 切换 + 「新建 / 保存 / 另存为 / 复制 / 删除」按钮；有未保存修改时显示橙色 ●「有未保存修改」徽标 + 切换流水线 / 关页面前确认。
  - **后端新表 `pipelines`**：字段 `id / user_id / name / description / steps(JSON 数组，每条 `{stepId, agentId, extraNote}`) / 时间戳`。CRUD 接口 `me.{GET,POST,DELETE} /api/pipelines/me[/:id]`；service 校验名字≤30 / 描述≤80 / 步骤数 1~10 / 附加说明≤4000，ownership 严格校验；**不**校验 `agentId 必须存在`，允许保存后该角色被删除（前端显示红色「角色已删除」灰态让用户替换）。
  - **复用现有能力**：单步调上游直接走 `requestEdit`，把「角色固定参考图 + 当前步输入」拼成 references；下载 / 加入素材沿用 workstation 那套；不写流水线 generations 历史（产物只活在 session 内，跟单角色工作台一致）。

+ [新增] **角色工作台「生成记录」Drawer**：`/agents` 工作区标题旁加「生成记录」按钮，点击弹出右侧 Drawer 显示从角色工作台发出的所有 generations 记录（默认按角色聚合，顶部 Select 可按指定角色筛选，下方按时间倒序分页 10 条/页）。每条记录显示结果缩略图 / 角色头像 + 名字 / 状态 tag / 提示词截断 / 时间 / 耗时；点击一行在新 Tab 打开 `/image/{id}` 复用已有详情页（提示词、参考图、所有缩略图、加入素材 / 微调 / 加入提示词库等所有现有操作都能用）。
  - 后端：`/api/generations` 加两个 query 参数 —— `agentId=<id>` 精确筛指定角色，`hasAgent=1` 筛「任意非空 agentId」即只看来自角色工作台的记录，避免把 `/image` 和 canvas 的记录混进来。`model.Query` 加 `AgentID` 和 `HasAgent` 字段，`repository.ListGenerations` 应用 WHERE。
  - 前端：`agent-workstation` 每次跑完（成功 / 失败都算）都调一次 `saveGeneration` 写库，payload 带 `agentId`、`requestParams.via="agent-workstation"`、缩略图 / references 等，跟 `/image` 工作台的字段对齐；写库失败只是 Drawer 里少一条记录，不打扰用户拿图的主流程。
  - 父层 `setRecordsRefreshKey` 自增触发 Drawer 内 react-query 重新拉，关闭再打开能记住筛选 + 分页位置。：编辑角色 Modal 的「参考图」区改成 3 个 104×104 的方形槽位，按顺序点 + 逐个加，每张 hover 出现「换 / 删」按钮；不连续的空槽不可点。后端 `agents.reference_image_url` / `reference_image_key` 两列废弃，改为 `reference_image_keys`（JSON 数组），service 层保存时去空白 / 去重 / 截断到最多 3 张。前端 type `Agent.referenceImageKeys: string[]`；workstation 调上游时按顺序把所有角色参考图拼到 `references` 前面 + 用户原图末尾发 `/v1/images/edits`。库卡 / 工作台 chip 都改成显示一排叠放的小缩略图（最多 3 个）+ 「带 N 张参考图」文案。
+ [新增] **角色工作区持久化**：`/agents` 把哪些角色加进了「工作区」按用户 id 隔离地存到 localStorage（key=`infinite-canvas:agents:workspace:{userId}`），刷新页面 / 重开浏览器 / 第二天再来都能恢复用户上次摆放的几张工作台卡片。切账号会自动切到新账号自己的快照（A 看不到 B 的工作区，B 也看不到 A 的）。**注**：工作区里每张卡的临时状态（用户当次上传的原图 / 附加说明 / 当次的结果图）仍然只活在内存里，刷新就丢；上云属于下一轮再做。
+ [修复] 编辑角色 Modal 上传头像 / 参考图时，写入数据库的是浏览器临时 `ObjectURL`（`blob:...`），刷新页面后失效导致角色卡上显示破图。现在统一存服务端直链 `/api/images/{storageKey}`，跨会话 / 跨浏览器 / 跨设备都能正常加载。
+ [新增] **角色工作台 `/agents`（第一版）**：把"常用流程 + 固定提示词"打包成「角色」（带名字、头像、描述、系统提示词、默认尺寸/质量），同页可以加入多个角色到工作区**各自独立处理图片，并行不互扰**。
  - 后端：新表 `agents`（id / user_id / name / avatar_url / description / system_prompt / default_size / default_quality / usage_count），CRUD 接口挂在 `me.{GET,POST,DELETE} /api/agents/me[/:id]`。同时给 `generations` 加 `agent_id` 字段用于追溯（暂未在 admin 后台展示）。
  - 前端：新页面 `/agents` 拆三块——① 顶部「我的角色」横向卡片库（头像 + 名字 + 描述 + 已用次数 + ⋯ 菜单：编辑 / 复制一份 / 删除 + 主按钮「加入工作区」），支持名字/描述/提示词关键词搜索；② 下方「工作区」网格：每张卡是一个**独立小工作台**（拖入/粘贴/上传/剪切板原图 + 附加说明 textarea + 开始生成 + 状态 pill：待上传 / 生成中 / 已完成 / 失败），生成成功后展示结果图 + 下载 / 加入素材 / 再来一张，失败给一行错误 + 重试按钮；③ 「新建 / 编辑角色」Modal：头像（首字 fallback + 自动取色 / 可上传图片覆盖，走 `useImageUploader`）、名字（≤20 字）、一行描述（≤80 字）、系统提示词（必填，≤4000 字）、默认尺寸 / 质量。
  - 单角色单次只生 1 张，复用 `/api/v1/images/{generations,edits}` 反代，不重复造轮子；附加说明会拼到角色 systemPrompt 后面再发上游。
  - 顶部导航加入「角色工作台」入口（Users 图标），桌面端 nav 与移动端 Drawer 都生效。

## v0.0.19 - 2026-05-22

+ [调整] `/image` 生图工作台提示词输入框的回车键操作改为「按 Enter 直接开始生成、Shift + Enter 换行」，跟主流聊天/创作产品的快捷键习惯对齐。输入框下方加了一行小字提示（`Enter 直接开始生成，Shift + Enter 换行`），placeholder 末尾也追加同样说明。中文输入法候选阶段（`isComposing`）以及 Ctrl/Meta/Alt 组合键全部放行，不会误把"敲回车确认候选词"当成提交；当前正在生成（`running`）或提示词为空时按 Enter 也不触发。

## v0.0.18 - 2026-05-22

+ [调整] 生图结果卡片底部 4 个操作按钮（AI 微调 / 添加到素材 / 加入参考图 / 下载）以前常驻显示，列宽不够时会折两行甚至溢出。现在改成图片上**桌面端 hover 才显示**的浮层（带半透明渐变背景），移动端继续常显；按钮文案缩短为「素材」「参考图」更省位；底部只保留尺寸/大小/耗时 metadata 行。
+ [调整] `/image` 左侧"生成记录"面板折叠/展开按钮改为带 CSS 动画：`grid-template-columns` 加 `transition` 300ms ease-in-out，宽度变化平滑滑动而不是瞬切。`aside` 的内边距也跟着过渡，视觉一致。
+ [调整] 提示词输入框旁的「AI 优化」按钮重命名为「提示词优化」，文案更明确。所有使用 `<PromptImproveBar>` 的位置（生图工作台 / 画布节点 prompt 面板 / 画布助手输入框）一并生效。

## v0.0.17 - 2026-05-22

+ [新增] **加入提示词库**：`/image/{id}` 详情页"生成结果"标题旁新增「加入提示词库」按钮（仅在有成功图片时显示）。点击后弹出 Modal：必填标题（≤30 字）、从该记录成功的缩略图里选 1 张作为效果图、分类（默认 system）、标签（输入后回车添加；每个 ≤6 字、最多 8 个），提示词内容默认填入 record.prompt 可编辑。提交进 `pending` 审核队列。后端 `model.Prompt` 加 `Visibility`（public/pending/rejected）和 `SubmitterID` 字段，前台 `/prompts` 强制 `visibility=public-only`（兼容历史无 visibility 数据）不会漏出 pending。新增端点：`POST /api/prompts/submit`（普通用户）+ `POST /api/admin/prompts/:id/review`（管理员）。
+ [新增] **管理后台提示词审核 Tab**：`/admin/prompts` 顶部新增 Segmented 切换「全部 / 待审核 / 已公开 / 已拒绝」，待审核 Tab 自带红点 badge 实时显示 pending 数量。表格加「状态」列；待审核行操作区显示绿色「通过」+ 红色「拒绝」按钮，点了立即变更 visibility 并刷新列表 + badge。
+ [新增] **生成结果「AI 微调」**：`/image/{id}` 详情页每张成功结果卡片新增蓝色「AI 微调」主按钮。点击：把该图自动加入参考图列表（用 storageKey 关联，不重复上传）、提示词框预填「在这张图基础上：」、把当前记录 id 暂存到 `pendingParentIdRef`。用户写完修改指令点开始生成时，新记录会带 `parentId` 指向源记录。`model.Generation` 加 `ParentID` 字段（gorm index）；前端 `GenerationRecord.parentId` 同步。从子记录详情页的「生成结果」标题旁会显示「← 来自微调」面包屑链接，点击跳回父记录。
+ [新增] **提示词优化（端到端）**：所有提示词输入框（`/image` 工作台、画布节点 prompt 面板、画布助手输入框）旁新增「✨ AI 优化」按钮，点击调后端 `POST /api/prompts/improve` 反代：服务端在 `service/prompt_improve.go` 硬编码一段「你是图像提示词优化专家…」的 system prompt 注入到 chat completions 请求，调启用配置的 textModel，前端永远拿不到 system prompt 也拿不到 API Key。优化结果**原地预览**（不弹 Modal）：蓝色边框面板里显示优化文本 + 三个按钮「接受并替换 / 重试 / 拒绝」，**只有点接受才覆盖输入框**，拒绝就丢弃。复用 chat 限流（每用户 5/min；admin 跳过）。
+ [新增] **`/image` 左侧生成记录可收起**：panel 顶部新增 PanelLeftClose 按钮，点击收起为 44px 窄柄（只显示 PanelLeftOpen 展开按钮）；状态走 localStorage 持久化（`image-log-panel-collapsed`），不上云。移动端原本就走 Drawer 不受影响。
+ [调整] **新建场景统一回归 count=1，不读偏好**：
  - `/image` 工作台点「新建」按钮时主动 `updateConfig("count", "1")`，避免上次跑了 N 张的偏好继续生效；
  - `/canvas` 新建配置节点（3 处入口 createConnectedNode / createNode / generateImageFromTextNode）固定 metadata `count: 1`，不再读 `config.count`；
  - `buildNodeConfig` 和 `buildGenerationConfig` 的 fallback 跳过 `globalConfig.count`，只看 `node.metadata.count → defaultConfig.count`；
  - 用户偏好里 `count` 字段不再对画布新建节点起作用，避免「工作台一次性输的张数」被错误地理解成永久偏好。
+ [修复] 画布节点提示词面板（文/图生图节点上方那一栏）新建图片节点时生成次数仍显示 `3`。v0.0.10 自称"清掉了 4 处硬编码"，但 `canvas-node-prompt-panel.tsx:104` 还藏着一处 `(mode === "image" ? 3 : globalConfig.count)` 漏网。现在跟 Config 节点 / 工作台一样统一走 `node.metadata?.count → globalConfig.count → defaultConfig.count`（默认新用户 1），新建节点默认使用账号偏好。已存的旧节点 metadata 里的 3 不变，手动改一次即可。

## v0.0.16 - 2026-05-22

+ [新增] `/image` 生图工作台输入提示词的方式扩展到 4 种（之前只有"点上传按钮 / 点剪切板按钮"两种）：
  - 提示词输入框直接 `Ctrl/Cmd+V` **粘贴**图片，支持一次粘贴多张；图片不会出现在 prompt 文本里，而是直接进参考图列表；
  - 提示词输入框可以**拖入**图片（一次拖多张）；
  - 参考图区域也可以拖入图片；
  - 拖入时输入框 / 参考图区域出现蓝色高亮 + "松开以添加参考图" 提示；
  - 非图片类型拖入会被忽略并 toast 提示。四个入口（按钮上传 / 剪切板 / 提示词粘贴 / 拖拽）共用同一个 `addReferencesFromBlobs` helper，单张上传失败只跳过那一张不影响其他张。
+ [修复] 启用新 AI 上游配置「主号池-2」（`cpam.lijiwang.top`，反代到本机 `127.0.0.1:18317` 的 cpa-manager）后，生图统一返回中文提示「上游服务异常（502 Bad Gateway），请稍后再试」。错误并非业务 / 鉴权 / 上游真挂——而是 **`cpam.lijiwang.top` 的 nginx 配置缺了 `proxy_read_timeout` 和 `client_max_body_size`**：默认 60s 读超时让 1-2 分钟的图生图请求一律被 nginx 切，错误透传到 infinite-canvas 后端被 `parseUpstreamMessage` 友好化成 502 文案；同时 multipart 参考图遇到默认 1MB 上限会 `client intended to send too large body: 1904802 bytes`。**额外根因**：`/etc/nginx/sites-enabled/cpam.lijiwang.top` 不是指向 `sites-available` 的 symlink 而是一个被 nginx-panel 独立维护的实文件，之前几次改 `sites-available` 都没生效。这次把 sites-enabled 改成 symlink 并写入 `client_max_body_size 50M;` + `proxy_read_timeout/send_timeout 600s` + `proxy_buffering off` + `proxy_request_buffering off`，与 `chatgpt2api.lijiwang.top`、`infinite-canvas.lijiwang.top` 那两份配置对齐。

## v0.0.15 - 2026-05-22

+ [修复] 生图工作台点「开始生成」后页面立刻显示「生成失败 / 生成被中断，请点击重试」（即便后端 `/api/v1/images/generations` 200、`/api/images` 200，task 实际跑成功了 UI 仍然中断）。**真正根因**：`/image/page.tsx` 和 `/image/[id]/page.tsx` 是两个独立的 page 组件，generate() 走到 `router.replace('/image/{id}')` 时整个 `<ImageWorkspace>` 被 React 卸载并在新路由下重挂载——所有 `useRef`（包括 v0.0.13 加的 `isGeneratingRef` / `activeGenerationIdRef`）全部重置成初始值，旧实例的 closure 里 generate 还在跑，新实例完全没有 generate 的状态，看到 logs 缓存里 status=running 的 placeholder 就当成"中断"。前两轮 closure 修复在跨实例 race 下完全失效。**这次的修复**：新增 `app/(user)/image/layout.tsx`，把 `<ImageWorkspace>` 抬到 layout 层渲染，跨 `/image` 与 `/image/[id]` 共享同一个组件实例（Next.js App Router 的 layout 在子路由切换时不会卸载）；两个 `page.tsx` 改为 `return null`，仅作路由占位。从此 `router.replace` 只触发 props 变化不再 remount，generate 全程跑在同一个实例上，ref / state / setResults 都生效。

## v0.0.14 - 2026-05-21

+ [调整] 顶栏 `VersionReleaseModal` 版本弹窗按钮先彻底隐藏：组件实现改为 `return null`，文件保留备用。当前所有版本号显示统一走头像左侧的 `<Link href="/changelog">vX.X.X</Link>`（在 `UserStatusActions` 内部，未登录态也在 `app-top-nav` 里单独有一份链接形态），保留画布详情页那个；之前生产页面残留的 `v0.0.13 v0.0.13` 双显示问题，部署本次构建后强刷浏览器即可消失。
+ [调整] 图生图接口 `/api/v1/images/edits` 同时支持 JSON 请求：`{ prompt, n, size?, quality?, references: ["img-xxx", ...] }`，references 是图片在服务器图床的 storageKey（`images.id`）。后端校验 owner（必须当前用户拥有）后从磁盘读图，再自己拼 multipart 转发到上游。请求体从 MB 级降到 KB 级，省一次"前端转 base64 → 上传 → 服务器再读请求体"的来回。最多 8 张参考图。原 multipart 路径保留，画布里截屏/裁剪还没存盘的瞬时图仍可用。前端 `requestEdit` 自动识别：所有 reference 都有 storageKey 时走 JSON，否则回落到 multipart。
+ [修复] v0.0.13 加的「running guard」仍有漏洞：用 useState 的 `running` 做 closure 判断，React 18 自动 batching + Next.js 路由切换 + 多次 setQueryData 触发的 commit 之间可能让 `previewGenerationLog` 闭包拿到 stale `running===false`，导致 task 跑成功后页面被刷成「生成失败 / 生成被中断」、生成结果图片消失（服务器 gin 日志显示 edits 46s 200、image 上传 25s 200、generations upsert 3ms 200，前后端状态出现分裂）。改用 `isGeneratingRef` + `activeGenerationIdRef` 两个 ref：ref 永远是最新值不受 closure 影响；本会话发起的 placeholder.id 也记下来，即便 setRunning(false) 之后再触发 previewGenerationLog 也认得出这条 running 是自己的，不刷成「被中断」。
+ [修复] 顶栏右上角同时渲染了「`/changelog` 版本号链接」和「VersionReleaseModal 版本弹窗按钮」，两者都显示同一个版本号文字（如 `v0.0.13 v0.0.13`）。保留前者跳转专门的更新日志页 `/changelog`，移除 `VersionReleaseModal` 渲染调用（组件文件保留备用）。原本传给 modal 的 `versionStyle`（画布详情页主题色）改而应用到 `<Link>` 上，画布详情页版本号配色不变。

## v0.0.13 - 2026-05-21

+ [修复] 上游网关返回 HTML 错误页（最常见的 nginx 504/502/503）时，前端会原样显示一整段 `<html><head><title>504 Gateway Time-out</title>...`，普通用户看不懂。后端 `handler.parseUpstreamMessage` 和 `service.parseUpstreamError` 现在识别 HTML body 不再直接透传，按 502/503/504 给出中文友好提示（如「上游服务响应超时（504），请稍后再试」），其他状态码兜底「上游响应异常：{status}」。同时给 `chatgpt2api.lijiwang.top` 那段 nginx 加上 `proxy_read_timeout 600s` + 关闭 buffering，跟 infinite-canvas 这边对齐避免上游链路过早 504。
+ [修复] 生图工作台点开始生成后，UI 立刻把所有 slot 渲染成"生成被中断，请点击重试"。根因是 v0.0.12 引入两阶段入库后，左侧记录列表立刻插入了 status=running 的 placeholder，用户/列表点击或自动联动到这条 placeholder 时 `previewGenerationLog` 看到 `status=running` 就按"中断"占位刷成 failed 卡片，把当前会话还在跑的 task 进度盖掉了。`previewGenerationLog` 现在判断「`status=running` 且本会话正在跑（running===true）」时仅切 URL 不重写 results，把 pending → success/failed 的控制权交还 generate() 自身。`/admin/generations` 上游响应区已能看到上游 chatgpt2api 真实报错信息（如 `/backend-api/conversation/... failed: status=500`），便于排查上游故障。

+ [修复] 上传图片接口 `/api/images` 偶发"一直在待处理"：multipart 大文件经 Next.js `rewrites` 默认转发时，会被 buffer 整个请求体再转给后端，加上生产模式下 rewrites 自身的 30/60s 响应超时，前端 fetch 容易长时间挂起。新增 `src/app/api/images/route.ts`（POST 上传）与 `src/app/api/images/[id]/route.ts`（GET 下载 / DELETE 删除）两个 Route Handler，沿用 `/api/v1/images/*` 已经验证过的 `duplex: "half"` streaming + `maxDuration = 5min` 模式直转后端，绕过 rewrites 卡顿。
+ [调整] 生图工作台点击「开始生成」后**立即**入库一条 `status=running` 占位记录，URL 同时切到 `/image/{id}`。之前要等所有 task 跑完才写库，过程中关页面/网络抖动会丢掉整次调用；现在两阶段：先 POST 创建占位 → 跑完 task → 用 id upsert 最终状态（success/partial/failed）。后端 `GenerationStatus` 枚举加 `running`；前端类型同步；左侧记录卡显示「进行中」金色 tag；管理后台「生图记录」状态筛选/列表也支持 running 项。若用户在 task 完成前关闭页面再回来，历史里仍能看到这条记录，被中断的 slot 显示「生成被中断，请点击重试」与真实"生成失败"做语义区分。
+ [新增] 管理后台「生图记录」详情弹窗在原有"提示词 + 参考图 + 生成结果"之上，新增「错误信息 / 请求参数 / 上游响应」三块审计区。`generations` 表加 `errors` / `request_params` / `upstream_meta` 三个字段：失败 slot 的 error.message 全部记录、调用反代时实际带的 size/quality/n/referenceCount 等参数透明可查、上游 OpenAI 兼容接口的原始响应 JSON（去掉 b64_json 大字段后）也落库。无论生成成功、部分成功、还是全部失败，admin 都能在一个页面看到完整调用细节。
+ [新增] 所有用户主动上传图片的位置（生图工作台参考图、剪贴板、画布拖入、画布节点替换、节点裁剪、素材库新增、公开素材库"加入我的素材"等）统一走新的 `useImageUploader` hook：上传期间右上角 antd `message.loading` 实时显示「正在上传XX…」，失败时换成中文错误提示。AI 生图结果自动落库不弹（避免与"正在生成图片"占位卡片重复反馈）。
+ [修复] 管理后台「生图记录」「积分流水」「用户管理」和个人中心 `/profile` 的时间显示比本地少 8 小时。根因是服务器进程跑在 UTC 时区，`time.Now().Format(time.RFC3339)` 输出 `…Z` 字符串，前端原样渲染。新增 `lib/format-datetime.ts` 工具按浏览器时区做 `toLocaleString("zh-CN")` 转换，所有"创建时间 / 时间 / 注册时间"列统一调用；后端时间格式保持 UTC + RFC3339 不动，避免再去碰镜像 TZ 设置。
+ [新增] 顶栏版本号变成可点击链接，跳转到 `/changelog` 更新日志页：以 Ant Design Timeline 时间线形式列出每个版本的「新增 / 修复 / 调整 / 安全 / 文档」条目，按 CHANGELOG.md 解析生成（不入库，发版改 markdown 自动同步）。Unreleased 标记「开发中」灰色节点。
+ [补录] 修复 CHANGELOG 中遗漏 `979f1fa config(next): 配置 TypeScript 构建错误忽略选项` 提交，补到 v0.0.2。

## v0.0.11 - 2026-05-21

+ [调整] 图片上传遇到 413 不再原样把"图片上传失败 HTTP 413""请求失败：413"等技术字符串显示给用户，统一换成中文友好提示：上传走「图片素材太大了（最多 50MB），请压缩或裁剪后再上传」；图生图等 multipart 接口走「请求体过大（超过 50MB），请压缩参考图或减少同时上传的图片数量」。前端在 `uploadImage` 上传前先按 50MB 预判，超过直接拦截，省一次网络往返。顺手把 401（未登录）/504（超时）也做了中文化。
+ [修复] 切换账号后 `/canvas` 列表仍短暂展示上一个用户的画布，需要手动刷新。根因是 `useCanvasStore` 是模块级 zustand state，登出/切账号时没被清空，新账号的 React Query 还在 pending 那段时间 UI 一直读旧数据。`useCanvasListSync` 现在监听 `userId` 变化，立即清空 store 并切回 loading 状态；queryKey 也从易变的 token 改为更稳定的 userId，避免 JWT 续签触发无谓重拉。
+ [修复] 画布助手面板标题误显示「画布助手(未开发)」。该面板（对话、生图、历史会话、参考图等）实际早已完整可用，标题恢复成「画布助手」。
+ [新增] 画布助手输入区支持点击「上传图片」按钮选取本地文件，以及把图片拖拽到输入框上传，与原本的粘贴上传效果一致；支持一次拖多张，非图片类型自动忽略。拖入时输入框出现蓝色高亮提示。
+ [新增] 画布内的所有图片现在都可以点击放大查看（复用 Ant Design `<Image>` 自带的预览浮层，支持缩放/旋转/键盘上下张切换，无需额外依赖）：
  - 图片节点：hover 工具栏新增「放大查看」按钮，与「下载图片」相邻；
  - 画布助手消息里的生图结果、参考图缩略图：直接点击即可放大；
  - 配置节点上下游输入预览缩略图：直接点击即可放大；点击不会触发节点拖拽。

## v0.0.10 - 2026-05-21

+ [调整] 画布详情页 Config 节点生图次数默认值：之前硬编码 `3`（4 处）。现在跟 size 一样走 `useAiConfigStore.config.count` → `defaultConfig.count` 的回退链，新建节点使用当前账号的偏好（默认新用户 1）。已存的旧节点 metadata 里的 3 不变，手动改一次或重新建节点即可。
+ [新增] 管理后台增加「生图记录」菜单 `/admin/generations`：跨用户分页展示所有生图调用（用户名、模式、状态、成功/总数、模型、尺寸、耗时、时间），支持按用户名/提示词关键词搜索与状态筛选；点击行可看到完整提示词、参考图、生成结果缩略图。
+ [新增] 管理后台增加「积分流水」菜单 `/admin/credit-logs`：跨用户分页展示所有积分变动，附带操作员用户名（管理员调整）和备注，支持按用户名/备注/模型关键词搜索与类型筛选。
+ [新增] 后端新增 `GET /api/admin/generations` 与 `GET /api/admin/credit-logs`，仅管理员可调用；列表会一次性 join `users` 表把 `username` 填到响应里。

## v0.0.9 - 2026-05-21

+ [修复] 生图工作台「重试」流程只更新本地 state、不写库：刷新页面后重试出来的图和参考图都丢失。现在重试成功后会带 `id` 调 `saveGeneration` upsert，同时把当前的 references 也写入记录，刷新后能完整恢复。
+ [新增] `generations` 表加 `references` 字段（JSON 数组，存参考图 storageKey），切换历史记录时左侧参考图能恢复，跨设备/换浏览器同样可见。
+ [安全] 后端 `service.SaveGeneration`：传入的 id 必须是当前用户自己的记录，否则报"权限不足"；id 指向不存在的记录直接报错而不是创建，避免客户端伪造 id。

## v0.0.8 - 2026-05-21

+ [调整] 图片不再以 BLOB 存数据库，改为落盘到 `IMAGE_DIR`（默认 `data/uploads`）目录，DB `images` 表只保留 `path` 元数据。Docker 镜像和 `docker-compose.yml` 已带挂载，升级老库不做迁移（按 AGENTS 约定），旧 BLOB 数据失效请重新生成或重新上传。
+ [调整] `GET /api/images/:id` 改为公开访问（id 是 UUID 不可枚举），方便 `<img src="/api/images/{id}">` 直接渲染；上传仍需登录，DELETE 仍需 owner。上传接口响应新增 `url` 字段。
+ [调整] 前端 `resolveImageUrl` 跨刷新场景不再 fetch + ObjectURL，直接返回相对 URL `/api/images/{id}`；本地刚上传的图仍走 ObjectURL 避免多一次往返。
+ [修复] 生产环境 nginx 上传图片返回 413：服务器 nginx 配置加上 `client_max_body_size 50M;`，并新增 `/api/images` 长接口 location（`proxy_request_buffering off`、`proxy_read_timeout 600s`）。

## v0.0.7 - 2026-05-21

+ [新增] 生图工作台支持深链：点击左侧生成记录会把 URL 切到 `/image/{id}`，直接访问 `/image/{id}` 也会自动展开对应记录，可以收藏/分享/刷新。生成新图后 URL 也会切到新记录的 id。
+ [调整] 生图历史里图片缓存丢失（多发生在换浏览器、清缓存、隐身模式）时，原本会被当成"生成失败"展示。现在用独立的琥珀色「图片缓存丢失」卡片与真实失败区分，并解释原因；底层数据/提示词/参数仍可查看，仅原图无法找回。
+ [新增] 图片二进制全面上云：新增 `images` 表（owner 隔离）+ `/api/images` 上传/读取/删除接口；前端 `uploadImage` 改为 POST 到服务端，`resolveImageUrl` 改为带 JWT 拉取后构造 ObjectURL。画布节点、参考图、生图结果、素材等所有 27 处调用点不变，新数据天然跨设备可见，彻底解决换浏览器/清缓存丢图的根因。迁移前 `image:` 前缀的旧 storageKey 仍兜底读取原浏览器 IndexedDB，新写入一律走服务器。
+ [新增] 用户生图默认偏好（`quality`、`size`、`count`）上云到 `users.preferences`，新增 `PUT /api/user/preferences` 接口；登录后从服务端拉取覆盖本地，修改后 600ms 防抖推送。换设备/换浏览器都能保留个人偏好。
+ [清理] 移除未被任何模块引用的 `web/src/lib/localforage-storage.ts` 死代码。

## v0.0.6 - 2026-05-20

+ [修复] 生图工作台 `/image` 在生成记录列表里切换记录时，左侧提示词/参考图/生成次数/尺寸/质量没有回填，右侧"生成结果"对全失败记录显示空白。现在切换记录会同步回填表单（参考图除外，历史未存原图），全失败记录会按张数渲染失败占位卡片。
+ [修复] 生产环境（`next start`）下生图、图生图请求经反向代理时仍然出现 504 Gateway Time-out。原因是 `next start` 的 rewrites 内部也存在响应头超时（约 30 秒），与 dev 模式同病。现在生产模式也走 `src/app/api/v1/images/*` 的 Route Handler，与 dev 行为统一，并把 `maxDuration` 设为 5 分钟；同时 nginx 反代配置 `/api/v1/` 长接口 `proxy_read_timeout 300s` + `proxy_buffering off`。

## v0.0.5 - 2026-05-20

+ [新增] 管理后台增加「用户管理」菜单，支持账号 CRUD、设置普通/管理员角色和生图额度。
+ [新增] 管理后台增加「模型配置」菜单，支持多套 Base URL/API Key/图像与文本模型，可启用其中一个并提供连通测试。
+ [调整] AI 调用改为后端反代 `/api/v1/images/generations`、`/api/v1/images/edits`、`/api/v1/chat/completions`，API Key 不再下发到前端，前台配置弹窗下线。
+ [新增] 普通用户每生成成功一张图片扣 1 点额度，余额不足时禁止调用并提示联系管理员；管理员账号不消耗额度。
+ [新增] 文本问答按用户限流，每分钟最多 5 次。
+ [新增] 重新开放注册，新注册账号默认赠送 4 次生图额度。
+ [调整] 前台顶部用户区显示剩余生图额度，仅管理员能看到「管理后台」入口。
+ [新增] 我的画布、我的素材、生图历史改为按用户隔离，画布数据与历史记录上云同步到后端数据库。
+ [新增] 个人中心 `/profile`：展示当前积分、累计消耗、累计获赠、生图次数和分页积分流水。
+ [新增] 注册赠送、管理员调整额度、生图扣减都会写入积分流水。
+ [调整] 默认生成尺寸调整为 `auto`、默认生成次数调整为 `1`；旧用户本地保存的偏好会一次性重置。
+ [调整] `/canvas`、`/image`、`/assets`、`/profile` 需要登录后才能访问；未登录会被跳转到 `/login`。
+ [调整] 浏览器本地图片缓存按用户 ID 分桶（`image_files_${userId}`），换账号互不可见。
+ [新增] 管理后台「模型配置」新增/编辑弹窗支持「获取模型列表」按钮，填好 Base URL 和 API Key 后可一键拉取上游 `/v1/models`，并把结果作为图像/文本模型输入框的下拉建议；新增配置时默认填入聊天模型 `gpt-5.4`、生图模型 `gpt-image-2`。
+ [修复] 生图、图生图请求经 Next.js dev rewrites 转发时，超过 30 秒会被切断返回 `Internal Server Error / socket hang up`。dev 模式改走 Route Handler 直转后端绕过超时，生产模式（`next start`）仍由 rewrites 直接代理避免多一跳 Node 中转；同时新增 `dev:turbo` 脚本可选 Turbopack。
+ [调整] 画布详情页（`/canvas/[id]`）顶部浮动条新增积分 Tag，普通用户显示「N 积分」、管理员显示「∞」，点击跳转 `/profile`，行为与首页顶栏一致。

## v0.0.4 - 2026-05-20

+ [调整] Docker 运行入口改为 Next.js 对外提供页面，`/api/*` 由 Next.js 代理到内部 Go 服务。
+ [修复] 文本复制在局域网 IP 访问时可能失败的问题。

## v0.0.3 - 2026-05-19

+ [修复] 更新 nanoid 依赖并修改 ID 生成方式，防止其他ip无法使用crypto模块导致的ID生成失败问题。

## v0.0.2 - 2026-05-19

+ [新增] 增加生图工作台功能，支持文生图、图生图、查看历史记录，并增加移动端适配。
+ [修复] 画布生成尺寸控件支持选择更多常用比例，并可直接输入自定义比例。
+ [修复] 生成配置节点恢复拖拽操作，避免面板控件拦截整块节点拖动。
+ [调整] `next.config.ts` 开启 `typescript.ignoreBuildErrors`，允许 build 阶段跳过 TypeScript 错误，避免开发期类型未完全收敛阻塞镜像构建。
+ [文档] 增加 Render 部署说明。

## v0.0.1 - 2026-05-19

+ [新增] 首次开源版本，包含无限画布能力：多画布项目、节点拖拽缩放、连线、小地图、撤销重做、导入导出。
+ [新增] AI 创作能力：支持 OpenAI 兼容接口的文生图、图生图、参考图编辑和文本问答。
+ [新增] 画布助手能力：支持围绕选中节点和上游节点对话、生图，并把结果插回画布。
+ [新增] 提示词库能力：抓取多个 GitHub 开源项目，按案例整理数百个图片提示词。
