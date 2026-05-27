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
  type PipelineRunStep,
} from "@/services/api/pipeline-runs";
import { useUserStore } from "@/stores/use-user-store";
import type { ReferenceImage } from "@/types/image";

export const RUNS_QUERY_KEY = ["my-pipeline-runs"] as const;

// 单 tab 客户端最多并发跑几条 run。超出的 run 保持 queued 状态，
// 前面的跑完才会被 pickQueued 选中。设 3 是为了不让单 tab 一次性把上游打挂。
const CONCURRENCY_CAP = 3;

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
    // 看 queued / running（running 但不在 inflight 的可能是别 tab 启的；本 tab 不接管）
    for (const run of items) {
      if (run.status !== "queued") continue;
      if (inflightIdsRef.current.size >= CONCURRENCY_CAP) break;
      if (inflightIdsRef.current.has(run.id)) continue;
      inflightIdsRef.current.add(run.id);
      void runRun(run.id);
    }
    notifySubscribers();
  };

  // 主执行循环：拉最新 run → for 每个 idle / failed step → 调上游 → PUT 写回后端
  const runRun = async (runId: string) => {
    try {
      // 第一次：把 status 标为 running 推回后端
      const initial = (queryClient.getQueryData<PipelineRunListResponse>(RUNS_QUERY_KEY)?.items || []).find((item) => item.id === runId);
      if (!initial) {
        inflightIdsRef.current.delete(runId);
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
        const agent = agents.find((item) => item.id === step.agentId);
        if (!agent) {
          current = patchStep(current, i, {
            status: "failed",
            errorMessage: "角色不存在或已被删除，请到详情页替换为其它角色",
          });
          await persistRun(current);
          continue;
        }
        // 算输入：手动覆盖 > 上一步成功的 outputKey > seed
        const inputKey = computeInputKey(current, i);
        if (!inputKey) {
          current = patchStep(current, i, {
            status: "failed",
            errorMessage: "缺少输入图（上一步还没成功，或没有上传原图）",
          });
          await persistRun(current);
          continue;
        }
        // 标记为 running 推一次
        current = patchStep(current, i, { status: "running", errorMessage: undefined });
        await persistRun(current);
        // 跑
        const startedAt = performance.now();
        try {
          const composedPrompt = step.extraNote.trim()
            ? `${agent.systemPrompt.trim()}\n\n补充说明：${step.extraNote.trim()}`
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
          references.push({
            id: `pipeline-step-input-${step.stepId}`,
            name: `步骤 ${i + 1} 输入`,
            type: "image/*",
            dataUrl: imageUrl(inputKey),
            storageKey: inputKey,
          });
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
          current = patchStep(current, i, {
            status: "success",
            outputKey: stored.storageKey,
            errorMessage: undefined,
            durationMs: Math.round(performance.now() - startedAt),
            lastRunSnapshot: { inputKey, extraNote: step.extraNote },
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
    const agent = agents.find((item) => item.id === step.agentId);
    if (!agent) {
      applyStepPatchOptimistically(runId, stepIndex, { status: "failed", errorMessage: "角色不存在或已被删除" });
      void persistRun(patchStep(run, stepIndex, { status: "failed", errorMessage: "角色不存在或已被删除" }));
      return;
    }

    // 选输入：默认走「上游产物 / seed / 手动覆盖」(restart 路径)
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
    const inputSource: "upstream" | "iterate" = iterateOnOwnOutput ? "iterate" : "upstream";

    if (!inputKey) {
      applyStepPatchOptimistically(runId, stepIndex, { status: "failed", errorMessage: "缺少输入图（上一步没成功，或没有原图）" });
      void persistRun(patchStep(run, stepIndex, { status: "failed", errorMessage: "缺少输入图（上一步没成功，或没有原图）" }));
      return;
    }

    // 1. 乐观标 running：detail / list 两份 cache 一起改，UI 立刻出 loader
    applyStepPatchOptimistically(runId, stepIndex, { status: "running", errorMessage: undefined });
    // 后台 PUT，服务器知道一下；persistRun 内部会 merge 用户可编辑字段
    void persistRun(patchStep(run, stepIndex, { status: "running", errorMessage: undefined }));

    const startedAt = performance.now();
    try {
      const result = await invokeStep(token, agent, step.extraNote, inputKey, stepIndex);
      // 2. 立刻把产物替换上（用户立刻能看到新图，不用等 PUT 回来）
      const successPatch: Partial<PipelineRunStep> = {
        status: "success",
        outputKey: result.outputKey,
        errorMessage: undefined,
        durationMs: Math.round(performance.now() - startedAt),
        lastRunSnapshot: { inputKey, extraNote: step.extraNote, inputSource },
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
async function invokeStep(token: string, agent: Agent, extraNote: string, inputKey: string, index: number): Promise<{ outputKey: string }> {
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
  references.push({
    id: `pipeline-step-input-${index}`,
    name: `步骤 ${index + 1} 输入`,
    type: "image/*",
    dataUrl: imageUrl(inputKey),
    storageKey: inputKey,
  });
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
