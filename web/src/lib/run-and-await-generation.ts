import { fetchGeneration, runGeneration, type GenerationRecord, type RunGenerationPayload } from "@/services/api/generations";

// runAndAwaitGeneration 把「后端任务化生图 + 等结果」收口成一个 awaitable：
//   - POST /api/generations/run 立刻在服务端落一条 running 记录 + 起 worker
//   - 立刻回调 onStarted（caller 可以把 record.id 持久化到节点 / step / 卡片，
//     用于刷新页面后续上）
//   - 然后轮询 fetchGeneration，直到 status 不是 running
//   - 终态 success / partial → 返回 thumbnails[0] 当产物 storageKey
//   - 终态 failed → 抛错（用 errors[0] 或通用文案）
//
// 这个 helper 取代了「直接 requestEdit/requestGeneration + uploadImage」的老模式。
// 老模式有两个问题：① 整段挂在前端闭包里，刷新页面就死、credits 已扣但图丢；
// ② 失败 / 上游慢 / 取消的边界各种重复一遍。helper 收一份就行。
//
// 调用方需要「真的刷新页面也能恢复」时：
//   1. onStarted 里把 record.id 写进可持久化的存储（节点 metadata / step.runningGenerationId / 卡片字段）
//   2. mount / hydrate 时检查这个 id，如果还有就单独跑一遍 awaitGenerationTerminal() 续轮询
// 调用方只关心「这次跑跑完拿张图」时（如 canvas-assistant-panel）：直接 await 即可，
// 已经比老模式好（至少 credits 入了真正的记录、用户能在 records drawer 里看到）。
export type RunAndAwaitOptions = {
  // 拿到后端建好的 record 立刻回调（async 也行，会被 await）。caller 可以在这里持久化 id。
  onStarted?: (record: GenerationRecord) => void | Promise<void>;
  // 轮询间隔，默认 2000ms。
  pollIntervalMs?: number;
  // 总超时（含 POST），默认 10 分钟。超时后抛错，但后端 worker 仍会继续跑。
  timeoutMs?: number;
  // 让 caller 在等待期间打断轮询（例如组件 unmount）。返回 true 则下次轮询 tick 中止。
  isCancelled?: () => boolean;
};

export type RunAndAwaitResult = {
  storageKey: string;
  durationMs: number;
  record: GenerationRecord;
};

export async function runAndAwaitGeneration(
  token: string,
  payload: RunGenerationPayload,
  options: RunAndAwaitOptions = {},
): Promise<RunAndAwaitResult> {
  const { onStarted, pollIntervalMs = 2000, timeoutMs = 10 * 60 * 1000, isCancelled } = options;
  const startedAt = performance.now();
  const record = await runGeneration(token, payload);
  if (onStarted) await onStarted(record);
  const final = await awaitGenerationTerminal(token, record.id, { pollIntervalMs, timeoutMs, isCancelled, startedAt });
  return finalize(final, startedAt);
}

// 只续等已存在的一条 generation。给「mount 时发现节点带 runningGenerationId」这类恢复路径用。
export async function awaitGenerationOnly(
  token: string,
  generationId: string,
  options: RunAndAwaitOptions = {},
): Promise<RunAndAwaitResult> {
  const { pollIntervalMs = 2000, timeoutMs = 10 * 60 * 1000, isCancelled } = options;
  const startedAt = performance.now();
  const final = await awaitGenerationTerminal(token, generationId, { pollIntervalMs, timeoutMs, isCancelled, startedAt });
  return finalize(final, startedAt);
}

async function awaitGenerationTerminal(
  token: string,
  id: string,
  opts: { pollIntervalMs: number; timeoutMs: number; isCancelled?: () => boolean; startedAt: number },
): Promise<GenerationRecord> {
  const { pollIntervalMs, timeoutMs, isCancelled, startedAt } = opts;
  // 第一次拉之前先等一拍，避免 POST 刚回就立刻又拉一次（worker 还没真的开始）。
  // 也减轻服务器压力：典型生图 30s+，2s 间隔足够。
  while (true) {
    if (isCancelled?.()) throw new Error("已取消");
    if (performance.now() - startedAt > timeoutMs) throw new Error("生成超时，请稍后查看生成记录");
    await sleep(pollIntervalMs);
    const latest = await fetchGeneration(token, id);
    if (latest.status !== "running") return latest;
  }
}

function finalize(record: GenerationRecord, startedAt: number): RunAndAwaitResult {
  const durationMs = record.durationMs || Math.round(performance.now() - startedAt);
  if (record.status === "success" || record.status === "partial") {
    const storageKey = record.thumbnails && record.thumbnails[0];
    if (!storageKey) throw new Error("生成完成但没拿到产物图");
    return { storageKey, durationMs, record };
  }
  // failed：errors[0] 是 worker 写的中文友好错误，没有就兜底
  const msg = (record.errors && record.errors[0]) || "生成失败";
  throw new Error(msg);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
