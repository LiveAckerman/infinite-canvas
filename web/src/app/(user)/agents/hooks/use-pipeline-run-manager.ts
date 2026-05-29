"use client";

import { useEffect, useRef } from "react";
import { useQueryClient } from "@tanstack/react-query";

import { defaultConfig } from "@/lib/ai-config";
import { requestEdit, requestGeneration } from "@/services/api/image";
import { imageUrl, uploadImage } from "@/services/image-storage";
import type { Agent } from "@/services/api/agents";
import {
  saveMyPipelineRun,
  type PipelineRun,
  type PipelineRunListResponse,
  type PipelineRunSourceRef,
  type PipelineRunStatus,
  type PipelineRunStep,
} from "@/services/api/pipeline-runs";
import { useUserStore } from "@/stores/use-user-store";
import type { ReferenceImage } from "@/types/image";

export const RUNS_QUERY_KEY = ["my-pipeline-runs"] as const;

// 单 tab 客户端最多并发跑几条 run。超出的 run 保持 queued 状态，
// 前面的跑完才会被 pickQueued 选中。设 3 是为了不让单 tab 一次性把上游打挂。
const CONCURRENCY_CAP = 3;

// 孤儿 run 的 updatedAt 阈值：超过这个时长没有任何 step PUT 更新，
// 即便不是本 tab 的 ownership 也接管恢复（防止跨 tab crash / 跨设备遗留死锁）。
// 单步生图 30s~2min，5 分钟没动静基本就是孤儿了。
const ORPHAN_THRESHOLD_MS = 5 * 60 * 1000;

// 本 tab 跑 run 的 sessionStorage 标记前缀。sessionStorage 跨刷新保留、跨 tab 隔离、
// tab 关闭/crash 清空 —— 正好符合「我刷新后接管自己之前在跑的」语义。
const OWNERSHIP_STORAGE_PREFIX = "infinite-canvas:pipeline-run-ownership:";
function ownershipKey(runId: string) {
  return `${OWNERSHIP_STORAGE_PREFIX}${runId}`;
}
function markRunOwned(runId: string) {
  if (typeof window === "undefined") return;
  try {
    window.sessionStorage.setItem(ownershipKey(runId), String(Date.now()));
  } catch {
    // sessionStorage 满 / 隐身模式禁用都不致命，单独失败不影响主流程
  }
}
function unmarkRunOwned(runId: string) {
  if (typeof window === "undefined") return;
  try {
    window.sessionStorage.removeItem(ownershipKey(runId));
  } catch {
    // ignore
  }
}
function isOwnedByThisTab(runId: string) {
  if (typeof window === "undefined") return false;
  try {
    return Boolean(window.sessionStorage.getItem(ownershipKey(runId)));
  } catch {
    return false;
  }
}

// 把一条 status="running"（但本 tab 没在跑、调度器拿不到任何 inflight）的孤儿 run
// 「软重置」回 queued：所有 step.status === "running" 的步骤改成 idle，让 runner 能从头跑那一步，
// 已经 success 的不动（runner 自动跳过）。
function recoverStaleRun(run: PipelineRun): PipelineRun {
  return {
    ...run,
    status: "queued",
    steps: run.steps.map((step) => {
      if (step.status !== "running") return step;
      return {
        ...step,
        status: "idle",
        errorMessage: undefined,
        durationMs: undefined,
      };
    }),
  };
}

// 一条 run 是否还有「没干完的活」——存在 idle / running 的步骤才算。
// failed 是已终结的失败、success 是已完成，都不算「还要跑」。
// 用来区分「真孤儿（跑一半断了，要恢复重跑）」和「假 running（步骤其实全终结了，只是
// 上次最后一次 persist 终态没落库，run.status 卡在 running）」。
function runHasPendingWork(run: PipelineRun): boolean {
  return run.steps.some((step) => step.status === "idle" || step.status === "running");
}

// 按各步骤的最终结果算 run 的终态，跟 runRun 收尾时的判定保持一致。
function computeRunFinalStatus(run: PipelineRun): PipelineRunStatus {
  const successCount = run.steps.filter((step) => step.status === "success").length;
  const failedCount = run.steps.filter((step) => step.status === "failed").length;
  if (failedCount === 0) return "success";
  if (successCount === 0) return "failed";
  return "partial";
}

type Props = {
  // 当前用户角色库，用来调上游时找 agent.systemPrompt / referenceImageKeys / defaultSize 等
  agents: Agent[];
};

// usePipelineRunManager —— 单 tab 级别的「执行流程调度器」。
//
// 工作流程：
// 1. 不主动拉数据。订阅 react-query 缓存里 RUNS_QUERY_KEY 的变化（无论是 polling 拉来的新数据
//    还是 createMyPipelineRun 后 setQueryData 推过来的新 run）。
// 2. 每次缓存变化时扫一遍 runs：
//    - 在 inflightIdsRef 里但缓存里已经 success/failed/partial → 从 inflight 拿走
//    - 不在 inflight 且 status=queued + 当前 inflight 数 < CONCURRENCY_CAP → 加入 inflight 启动 runRun()
// 3. runRun() 串行跑所有 idle / failed 步骤，每步开始 / 结束 PUT 写回后端。
//    跑完整条 run 之后从 inflight 拿走，可能让下一条 queued 上来。
//
// **关键约束**：所有调度都在这个 hook 实例的 ref 里跑；多 tab 各自独立。
// 即多开 2 个 tab，每 tab 都最多并发 3 条；总并发可能到 6。这是 v1 限制，
// 后续真要全局 cap 就只能上后端执行器了（option C）。
export function usePipelineRunManager({ agents }: Props) {
  const queryClient = useQueryClient();
  const token = useUserStore((state) => state.token);
  // 当前 tab 正在跑的 run id 集合
  const inflightIdsRef = useRef<Set<string>>(new Set());
  // 取消标记：用户在 detail 页点「停止」时调用 cancel(id) → 该 run 的 runRun 循环检测后退出
  const cancelledIdsRef = useRef<Set<string>>(new Set());
  // 用 ref 而不是 state 暴露 inflightIds 给外面看（用 subscriber 通知组件 rerender）
  const subscribersRef = useRef<Set<() => void>>(new Set());
  // agents 用 ref 跟踪最新引用：runRun / runSingleStep 是异步函数，开始执行时
  // closure 捕获的 agents 可能是 hook 早期 render 的旧引用（agents query 还没回来时 = []）。
  // 在 await 期间 agents 加载完了，但 runRun 内部仍读旧的 agents → 报「角色不存在或已被删除」。
  // 用 agentsRef 让所有读取永远拿到最新一帧的 agents。
  const agentsRef = useRef<Agent[]>(agents);
  useEffect(() => {
    agentsRef.current = agents;
  }, [agents]);

  // resolveAgentWithRetry 找 agent；如果当前 agents 数组里没有，等 1.2s 再试一次（防 agents 刚 mount 的 race）。
  // 仍找不到才算真删了 / 真不属于本用户。500ms × 3 留余量给慢网络。
  const resolveAgentWithRetry = async (agentId: string): Promise<Agent | null> => {
    const direct = agentsRef.current.find((item) => item.id === agentId);
    if (direct) return direct;
    for (let i = 0; i < 3; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 400));
      const found = agentsRef.current.find((item) => item.id === agentId);
      if (found) return found;
    }
    return null;
  };

  const notifySubscribers = () => {
    subscribersRef.current.forEach((fn) => fn());
  };

  // 取最新 cache 里的 runs；订阅 cache 变化触发调度
  useEffect(() => {
    const cache = queryClient.getQueryCache();
    const tick = () => scheduleFromCache();
    const unsubscribe = cache.subscribe((event) => {
      // 性能：只关心 RUNS_QUERY_KEY 的变化
      if (event.query?.queryKey?.[0] === RUNS_QUERY_KEY[0]) tick();
    });
    // 首次 mount 主动跑一次
    tick();
    return () => unsubscribe();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [queryClient, token, agents]);

  // 从缓存里挑可启动的 queued run
  const scheduleFromCache = () => {
    if (!token) return;
    const data = queryClient.getQueryData<PipelineRunListResponse>(RUNS_QUERY_KEY);
    const items = data?.items || [];
    // 先清理已经跑完的 inflight 标记
    for (const id of inflightIdsRef.current) {
      const found = items.find((item) => item.id === id);
      if (!found || found.status === "success" || found.status === "failed" || found.status === "partial") {
        inflightIdsRef.current.delete(id);
      }
    }

    // ⚠️ 孤儿 run 恢复：status === "running" 但本 tab 没在跑 →
    //   - 本 tab 之前 own 过它（sessionStorage 有标记）→ 用户刷新后回来，必接管恢复；
    //   - 没 own 但 updatedAt 老于 5 分钟 → 兜底救活（防别 tab crash 留下死锁）。
    //   - 其余情况认为是别 tab 在正常跑，不动。
    const now = Date.now();
    for (const run of items) {
      if (run.status !== "running") continue;
      if (inflightIdsRef.current.has(run.id)) continue;
      const owned = isOwnedByThisTab(run.id);
      const updatedAt = run.updatedAt ? new Date(run.updatedAt).getTime() : 0;
      const stale = updatedAt > 0 && now - updatedAt > ORPHAN_THRESHOLD_MS;
      if (!owned && !stale) continue;

      // ★ 假 running 修复：如果这条 run 其实没有任何「没干完的活」（所有步骤都已 success / failed，
      // 没有 idle / running 的步骤），说明它上次已经跑完了，只是最后一次 persist 终态的 PUT 没落库，
      // run.status 卡在 running。这种**不要重跑**（重跑会把已完成的产物重新跑一遍、还可能因为
      // 上游抖动失败），直接按步骤结果收敛成正确终态（全 success → success / 有失败 → partial / 全失败 → failed）。
      if (!runHasPendingWork(run)) {
        const finalized: PipelineRun = { ...run, status: computeRunFinalStatus(run) };
        queryClient.setQueryData<PipelineRunListResponse>(RUNS_QUERY_KEY, (old) => {
          if (!old) return old;
          return { ...old, items: old.items.map((item) => (item.id === run.id ? finalized : item)) };
        });
        unmarkRunOwned(run.id);
        // PUT 回后端（顺带触发 batch 状态机收敛）；失败也无所谓，UI 已经显示终态。
        void saveMyPipelineRun(token, finalized).catch(() => {});
        continue;
      }

      // 真孤儿：有 idle / running 步骤 → 重置 step.status="running" 为 idle，runner 拉起来从这些步骤继续跑。
      const recovered = recoverStaleRun(run);
      // 同步本地 cache 让 UI 立刻反应（pill 从「运行中」变「排队中」），avoid 闪烁
      queryClient.setQueryData<PipelineRunListResponse>(RUNS_QUERY_KEY, (old) => {
        if (!old) return old;
        return { ...old, items: old.items.map((item) => (item.id === run.id ? recovered : item)) };
      });
      inflightIdsRef.current.add(run.id);
      // 把恢复结果 PUT 回服务器，然后 runRun 自己会接着把 status 改回 running
      void saveMyPipelineRun(token, recovered).catch(() => {
        // PUT 失败不致命：runRun 内部第一步还会再 persist running 一次
      }).finally(() => runRun(run.id));
    }

    // 然后挑可启动的 queued run
    for (const run of items) {
      if (run.status !== "queued") continue;
      if (inflightIdsRef.current.size >= CONCURRENCY_CAP) break;
      if (inflightIdsRef.current.has(run.id)) continue;

      // post run gate：同 batch 内所有 main run 必须 done 才能起跑。
      // 后端会在 main 全 done 时主动把 post run 从 paused 改 queued，这里是本 tab 的兜底防御：
      // 别 tab 推 cache 还没同步、看到老 main = running 时不要错跑 post。
      if (run.kind === "post") {
        const batchMains = items.filter((r) => r.batchId === run.batchId && r.kind === "main");
        if (batchMains.length === 0) continue; // 异常：post 找不到对应 main，跳过让后端处理
        const allMainDone = batchMains.every(
          (r) => r.status === "success" || r.status === "partial" || r.status === "failed",
        );
        if (!allMainDone) continue;
      }

      inflightIdsRef.current.add(run.id);
      void runRun(run.id);
    }
    notifySubscribers();
  };

  // 主执行循环：拉最新 run → for 每个 idle / failed step → 调上游 → PUT 写回后端
  const runRun = async (runId: string) => {
    // 标记 sessionStorage：本 tab 在跑这条 run。
    // 用户刷新页面后 scheduleFromCache 会读到这个标记，把孤儿 run 接管恢复。
    markRunOwned(runId);
    try {
      // 第一次：把 status 标为 running 推回后端
      const initial = (queryClient.getQueryData<PipelineRunListResponse>(RUNS_QUERY_KEY)?.items || []).find((item) => item.id === runId);
      if (!initial) {
        inflightIdsRef.current.delete(runId);
        unmarkRunOwned(runId);
        return;
      }
      const startedRun: PipelineRun = { ...initial, status: "running" };
      await persistRun(startedRun);

      // 逐步跑
      let current = startedRun;
      for (let i = 0; i < current.steps.length; i += 1) {
        if (cancelledIdsRef.current.has(runId)) {
          cancelledIdsRef.current.delete(runId);
          // 标记 paused 让用户后续可以续跑
          await persistRun({ ...current, status: "paused" });
          break;
        }
        const step = current.steps[i];
        if (step.status === "success") continue; // 已成功的跳过（续跑场景）
        // 用 ref + retry 拿 agent，避免 agents query 还没回来时调度器误判「角色不存在」。
        const agent = await resolveAgentWithRetry(step.agentId);
        if (!agent) {
          current = patchStep(current, i, {
            status: "failed",
            errorMessage: "角色不存在或已被删除，请到详情页替换为其它角色",
          });
          await persistRun(current);
          continue;
        }
        // 算这一步的输入：main run 走原来的 computeInputKey 单张；
        // post run 第一步走 sourceRefs 解析多张（post run 后端创建时只有 1 个 step，所以 i===0 时一定命中）
        let inputKeys: string[];
        if (current.kind === "post" && i === 0) {
          const allItems = queryClient.getQueryData<PipelineRunListResponse>(RUNS_QUERY_KEY)?.items || [];
          const batchMains = allItems.filter((r) => r.batchId === current.batchId && r.kind === "main");
          inputKeys = resolvePostSourceKeys(current.sourceRefs || [], batchMains);
          if (inputKeys.length === 0) {
            current = patchStep(current, i, {
              status: "failed",
              errorMessage: "后处理 sources 全部缺失（主条对应步骤未生成产物或主条已被删除）",
            });
            await persistRun(current);
            continue;
          }
        } else {
          const inputKey = computeInputKey(current, i);
          if (!inputKey) {
            current = patchStep(current, i, {
              status: "failed",
              errorMessage: "缺少输入图（上一步还没成功，或没有上传原图）",
            });
            await persistRun(current);
            continue;
          }
          inputKeys = [inputKey];
        }
        // 标记为 running 推一次
        current = patchStep(current, i, { status: "running", errorMessage: undefined });
        await persistRun(current);
        // 跑
        const startedAt = performance.now();
        try {
          const result = await invokeStep(token, agent, step.extraNote, inputKeys, i);
          // lastRunSnapshot.inputKey 字段仍是单值。多张时存 join，便于后续做 stale 判断
          current = patchStep(current, i, {
            status: "success",
            outputKey: result.outputKey,
            errorMessage: undefined,
            durationMs: Math.round(performance.now() - startedAt),
            lastRunSnapshot: { inputKey: inputKeys.join(","), extraNote: step.extraNote },
          });
          await persistRun(current);
        } catch (error) {
          current = patchStep(current, i, {
            status: "failed",
            errorMessage: error instanceof Error ? error.message : "运行失败",
            durationMs: Math.round(performance.now() - startedAt),
          });
          await persistRun(current);
        }
      }

      // 终态判定
      if (!cancelledIdsRef.current.has(runId)) {
        const successCount = current.steps.filter((step) => step.status === "success").length;
        const failedCount = current.steps.filter((step) => step.status === "failed").length;
        const finalStatus = failedCount === 0 ? "success" : successCount === 0 ? "failed" : "partial";
        await persistRun({ ...current, status: finalStatus });
      }
    } finally {
      inflightIdsRef.current.delete(runId);
      // 释放 ownership 标记：跑到终态了，下次刷新不再需要恢复这条 run。
      // 中途 cancel / 抛错走 finally 也都释放，避免标记常驻 sessionStorage。
      unmarkRunOwned(runId);
      notifySubscribers();
      // 触发一次调度，看有没有 queued 等着上
      scheduleFromCache();
    }
  };

  // 在两份 cache 上同时打一个 step 级别的乐观补丁。
  //   - 列表 cache（RUNS_QUERY_KEY）：列表 UI / runner 自己后续读取用
  //   - detail cache（[...RUNS_QUERY_KEY, runId]）：详情页 useQuery 用，这样
  //     点「重做」立刻能看到 loader（不用等 PUT 往返）
  const applyStepPatchOptimistically = (runId: string, stepIndex: number, patch: Partial<PipelineRunStep>) => {
    queryClient.setQueryData<PipelineRunListResponse>(RUNS_QUERY_KEY, (old) => {
      if (!old) return old;
      return {
        ...old,
        items: old.items.map((item) => (item.id !== runId ? item : patchStep(item, stepIndex, patch))),
      };
    });
    queryClient.setQueryData<PipelineRun>([...RUNS_QUERY_KEY, runId], (old) => {
      if (!old) return old;
      return patchStep(old, stepIndex, patch);
    });
  };

  // 跑步骤过程中用户可能在 detail 页编辑 step 的「附加说明 / 手动覆盖图 / 角色」等字段。
  // runner 自己拿到的 `next` 是事先读 cache 的快照，PUT 时会把这些字段覆盖回旧值。
  // 这里在写库前 merge 一次：从最新的 detail cache 里取出用户可编辑字段，保留覆盖给 PUT 用。
  const mergeUserEditableFields = (runnerSnapshot: PipelineRun): PipelineRun => {
    const latestDetail = queryClient.getQueryData<PipelineRun>([...RUNS_QUERY_KEY, runnerSnapshot.id]);
    const latestList = queryClient.getQueryData<PipelineRunListResponse>(RUNS_QUERY_KEY)?.items.find((item) => item.id === runnerSnapshot.id);
    const latest = latestDetail || latestList;
    if (!latest) return runnerSnapshot;
    return {
      ...runnerSnapshot,
      steps: runnerSnapshot.steps.map((step) => {
        const latestStep = latest.steps.find((item) => item.stepId === step.stepId);
        if (!latestStep) return step;
        return {
          ...step,
          // 用户可编辑字段：以最新缓存为准（避免被 runner 的旧 snapshot 覆盖）
          extraNote: latestStep.extraNote,
          manualOverrideKey: latestStep.manualOverrideKey,
          agentId: latestStep.agentId,
          agentName: latestStep.agentName,
          avatarUrl: latestStep.avatarUrl,
        };
      }),
    };
  };

  // 写回后端 + 把两份 cache 都更新，让列表 UI 和 detail 页都实时反映。
  // 在 PUT 之前先 merge 一次用户可编辑字段，避免 runner 旧 snapshot 覆盖用户最近的编辑。
  const persistRun = async (next: PipelineRun) => {
    const merged = mergeUserEditableFields(next);
    // 乐观：先把合并后的状态写入两份 cache，PUT 还没回来前 UI 已经更新
    queryClient.setQueryData<PipelineRunListResponse>(RUNS_QUERY_KEY, (old) => {
      if (!old) return { items: [merged], total: 1 };
      return { ...old, items: old.items.map((item) => (item.id === merged.id ? merged : item)) };
    });
    queryClient.setQueryData<PipelineRun>([...RUNS_QUERY_KEY, merged.id], merged);
    try {
      const saved = await saveMyPipelineRun(token, merged);
      // 服务端响应也走一次 merge，防止 PUT 期间用户又改了字段（典型：用户在 invokeStep awaiting 时改了下一步的附加说明）
      const remerged = mergeUserEditableFields(saved);
      queryClient.setQueryData<PipelineRunListResponse>(RUNS_QUERY_KEY, (old) => {
        if (!old) return { items: [remerged], total: 1 };
        return { ...old, items: old.items.map((item) => (item.id === remerged.id ? remerged : item)) };
      });
      queryClient.setQueryData<PipelineRun>([...RUNS_QUERY_KEY, remerged.id], remerged);
    } catch {
      // PUT 失败：本地 cache 已经乐观更新过，不强行回滚（用户可能在等结果，回滚反而更不自然）
    }
  };

  // 手动取消：把 runId 标记到 cancelledIdsRef，runRun 循环到下一步前会跳出
  const cancel = (runId: string) => {
    if (inflightIdsRef.current.has(runId)) {
      cancelledIdsRef.current.add(runId);
    }
  };

  // 让外面（如顶部状态条）能看到当前在跑的 run id 集合 + 在跑数量
  const subscribe = (fn: () => void) => {
    subscribersRef.current.add(fn);
    return () => subscribersRef.current.delete(fn);
  };
  const getInflightIds = () => Array.from(inflightIdsRef.current);

  // 详情页用：单步重做。不走 queued / cap 限制 —— 用户在详情页主动触发的微调
  // 应该立即响应，且只跑这一步不影响其它步。下游 stale 状态由用户后续手动点重做来推进。
  //
  // UX 关键点：
  //   1. 点按钮 → 立刻乐观把 step.status 标 "running" 写入两份 cache，loader 立刻出现，
  //      不用等服务器 PUT 往返。
  //   2. invokeStep 成功后 → 立刻乐观把 outputKey 写入缓存，产物图立刻替换旧的。
  //   3. 调用 invokeStep 时用「detail cache 里最新的 extraNote」，所以用户刚改的附加说明
  //      会被一起发上游；persistRun 也 merge 用户可编辑字段保留下来。
  //   4. 「迭代微调」语义：本步已有 outputKey + 用户改了附加说明 + 上游没变 → 把本步自己的
  //      outputKey 当输入再跑一次（典型场景：「将衣服改成红色」这种基于已有产物的微调）。
  //      其它情形都按「上游 / seed / 手动覆盖」的常规输入跑（vanilla 重做 / 上游变了重跑）。
  const runSingleStep = async (runId: string, stepIndex: number) => {
    // detail cache 比 list cache 更可能包含用户最新编辑，优先读 detail
    const latestDetail = queryClient.getQueryData<PipelineRun>([...RUNS_QUERY_KEY, runId]);
    const latestList = queryClient.getQueryData<PipelineRunListResponse>(RUNS_QUERY_KEY)?.items.find((item) => item.id === runId);
    const run = latestDetail || latestList;
    if (!run) return;
    const step = run.steps[stepIndex];
    if (!step) return;
    const agent = await resolveAgentWithRetry(step.agentId);
    if (!agent) {
      applyStepPatchOptimistically(runId, stepIndex, { status: "failed", errorMessage: "角色不存在或已被删除" });
      void persistRun(patchStep(run, stepIndex, { status: "failed", errorMessage: "角色不存在或已被删除" }));
      return;
    }

    // 选输入：
    //   - post run 第一步（post 永远只有 1 步）→ 走 sourceRefs 解析多张
    //   - 其它情况 → 「上游产物 / seed / 手动覆盖」(restart 路径) + 可能的迭代微调
    let inputKeys: string[];
    let inputSource: "upstream" | "iterate" = "upstream";
    if (run.kind === "post" && stepIndex === 0) {
      const allItems = queryClient.getQueryData<PipelineRunListResponse>(RUNS_QUERY_KEY)?.items || [];
      const batchMains = allItems.filter((r) => r.batchId === run.batchId && r.kind === "main");
      inputKeys = resolvePostSourceKeys(run.sourceRefs || [], batchMains);
      if (inputKeys.length === 0) {
        applyStepPatchOptimistically(runId, stepIndex, { status: "failed", errorMessage: "后处理 sources 全部缺失" });
        void persistRun(patchStep(run, stepIndex, { status: "failed", errorMessage: "后处理 sources 全部缺失" }));
        return;
      }
    } else {
      const upstreamInputKey = computeInputKey(run, stepIndex);
      const lastSnap = step.lastRunSnapshot;
      const lastWasIterate = lastSnap?.inputSource === "iterate";
      const extraNoteChanged = Boolean(lastSnap) && lastSnap!.extraNote !== step.extraNote;
      // 迭代微调触发条件：
      //   - 本步已有 outputKey（必须有「上一次的产物」可以做底）
      //   - 用户填了附加说明（trim 后非空）
      //   - 附加说明跟上次跑时的 snapshot 不一样（否则没必要再跑）
      //   - 「上次本身就是 iterate」或「上次是 upstream 模式但 upstream 至今没变」
      //     （后者意味着用户没换覆盖图 / 上游没动 → 是典型「我想在产物上加点料」场景）
      const iterateOnOwnOutput = Boolean(step.outputKey)
        && step.extraNote.trim() !== ""
        && extraNoteChanged
        && Boolean(lastSnap)
        && (lastWasIterate || lastSnap!.inputKey === upstreamInputKey);
      const inputKey: string = iterateOnOwnOutput ? (step.outputKey as string) : upstreamInputKey;
      inputSource = iterateOnOwnOutput ? "iterate" : "upstream";

      if (!inputKey) {
        applyStepPatchOptimistically(runId, stepIndex, { status: "failed", errorMessage: "缺少输入图（上一步没成功，或没有原图）" });
        void persistRun(patchStep(run, stepIndex, { status: "failed", errorMessage: "缺少输入图（上一步没成功，或没有原图）" }));
        return;
      }
      inputKeys = [inputKey];
    }

    // 1. 乐观标 running：detail / list 两份 cache 一起改，UI 立刻出 loader
    applyStepPatchOptimistically(runId, stepIndex, { status: "running", errorMessage: undefined });
    // 后台 PUT，服务器知道一下；persistRun 内部会 merge 用户可编辑字段
    void persistRun(patchStep(run, stepIndex, { status: "running", errorMessage: undefined }));

    const startedAt = performance.now();
    try {
      const result = await invokeStep(token, agent, step.extraNote, inputKeys, stepIndex);
      // 2. 立刻把产物替换上（用户立刻能看到新图，不用等 PUT 回来）
      const successPatch: Partial<PipelineRunStep> = {
        status: "success",
        outputKey: result.outputKey,
        errorMessage: undefined,
        durationMs: Math.round(performance.now() - startedAt),
        lastRunSnapshot: { inputKey: inputKeys.join(","), extraNote: step.extraNote, inputSource },
      };
      applyStepPatchOptimistically(runId, stepIndex, successPatch);
      // 拉最新缓存（已含用户可能在 invokeStep 期间改的附加说明 / 角色 / 覆盖图）PUT 回库
      const latestForPersist = queryClient.getQueryData<PipelineRun>([...RUNS_QUERY_KEY, runId])
        || queryClient.getQueryData<PipelineRunListResponse>(RUNS_QUERY_KEY)?.items.find((item) => item.id === runId);
      if (latestForPersist) void persistRun(latestForPersist);
    } catch (error) {
      const failedPatch: Partial<PipelineRunStep> = {
        status: "failed",
        errorMessage: error instanceof Error ? error.message : "运行失败",
        durationMs: Math.round(performance.now() - startedAt),
      };
      applyStepPatchOptimistically(runId, stepIndex, failedPatch);
      const latestForPersist = queryClient.getQueryData<PipelineRun>([...RUNS_QUERY_KEY, runId])
        || queryClient.getQueryData<PipelineRunListResponse>(RUNS_QUERY_KEY)?.items.find((item) => item.id === runId);
      if (latestForPersist) void persistRun(latestForPersist);
    }
  };

  // 详情页用：把 run.status 重置为 queued 让调度器接管，但调度器只重跑 idle/failed 步骤。
  // 调用前外部已经把要重跑的步骤的 status 改为 idle 并 persist。
  const restartFromQueued = async (runId: string) => {
    const data = queryClient.getQueryData<PipelineRunListResponse>(RUNS_QUERY_KEY);
    const run = (data?.items || []).find((item) => item.id === runId);
    if (!run) return;
    await persistRun({ ...run, status: "queued" });
  };

  return {
    cap: CONCURRENCY_CAP,
    cancel,
    getInflightIds,
    subscribe,
    runSingleStep,
    restartFromQueued,
  };
}

// 内部执行一次图生图 → 上传产物，返回新 storageKey。封装来给 runRun / runSingleStep 共用。
// inputKeys 是这一步要喂给上游的产物 storageKey 数组：main run 永远只传 1 张；
// post run 第一步可能传多张（同 batch 各 main run 的指定步产物）。
async function invokeStep(token: string, agent: Agent, extraNote: string, inputKeys: string[], index: number): Promise<{ outputKey: string }> {
  const composedPrompt = extraNote.trim()
    ? `${agent.systemPrompt.trim()}\n\n补充说明：${extraNote.trim()}`
    : agent.systemPrompt.trim();
  const references: ReferenceImage[] = [];
  for (const key of agent.referenceImageKeys || []) {
    if (!key) continue;
    references.push({
      id: `agent-ref-${agent.id}-${key}`,
      name: `${agent.name}-参考图`,
      type: "image/*",
      dataUrl: imageUrl(key),
      storageKey: key,
    });
  }
  for (let i = 0; i < inputKeys.length; i += 1) {
    const key = inputKeys[i];
    if (!key) continue;
    references.push({
      id: `pipeline-step-input-${index}-${i}`,
      name: `输入 ${i + 1}`,
      type: "image/*",
      dataUrl: imageUrl(key),
      storageKey: key,
    });
  }
  const config = {
    size: agent.defaultSize || defaultConfig.size,
    quality: agent.defaultQuality || defaultConfig.quality,
    count: "1",
  };
  const res = references.length
    ? await requestEdit(token, config, composedPrompt, references)
    : await requestGeneration(token, config, composedPrompt);
  const first = res.images[0];
  if (!first) throw new Error("接口没有返回图片");
  const stored = await uploadImage(first.dataUrl);
  return { outputKey: stored.storageKey };
}

// 解析 post run 的 sourceRefs：把每个 ref 指向的「主条 runId + stepIndex」翻译成实际的 storageKey 数组。
//   - stepIndex === -1 → 用那条 main run 的 seedKey
//   - stepIndex >= 0  → 用那条 main run.steps[stepIndex].outputKey（必须是 success 且非空）
// 找不到对应主条 / 步骤未成功 / outputKey 为空 → 该 ref 静默忽略；调用方根据剩余 keys 数量判断是否报错。
function resolvePostSourceKeys(sourceRefs: PipelineRunSourceRef[], mainRuns: PipelineRun[]): string[] {
  const keys: string[] = [];
  for (const ref of sourceRefs) {
    const mainRun = mainRuns.find((r) => r.id === ref.runId);
    if (!mainRun) continue;
    if (ref.stepIndex === -1) {
      if (mainRun.seedKey) keys.push(mainRun.seedKey);
    } else if (ref.stepIndex >= 0 && ref.stepIndex < mainRun.steps.length) {
      const step = mainRun.steps[ref.stepIndex];
      if (step.status === "success" && step.outputKey) keys.push(step.outputKey);
    }
  }
  return keys;
}

// 算某步当前应该用的输入 key：手动覆盖 > 上一步 outputKey（必须 success） > seed（第一步）
function computeInputKey(run: PipelineRun, index: number): string {
  const step = run.steps[index];
  if (step?.manualOverrideKey) return step.manualOverrideKey;
  if (index === 0) return run.seedKey;
  const upstream = run.steps[index - 1];
  if (upstream?.status === "success" && upstream.outputKey) return upstream.outputKey;
  return "";
}

// 不可变地 patch 某步，返回新 run
function patchStep(run: PipelineRun, index: number, patch: Partial<PipelineRunStep>): PipelineRun {
  return {
    ...run,
    steps: run.steps.map((step, idx) => (idx === index ? { ...step, ...patch } : step)),
  };
}
