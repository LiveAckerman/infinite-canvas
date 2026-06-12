"use client";

import { ChevronDown, ChevronUp, Download, FolderPlus, LoaderCircle, RotateCw, Sparkles, X } from "lucide-react";
import { App, Button, Image, Input, Tag } from "antd";
import { useEffect, useMemo, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";

import { defaultConfig } from "@/lib/ai-config";
import { formatDuration } from "@/lib/image-utils";
import { PromptImproveBar } from "@/components/prompt-improve-panel";
import { ReferenceImagesField } from "@/components/reference-images-field";
import type { AgentWorkstationCard } from "@/services/api/agent-workstations";
import { fetchGeneration, runGeneration } from "@/services/api/generations";
import { saveMyAsset } from "@/services/api/my-assets";
import { imageUrl } from "@/services/image-storage";
import type { Agent } from "@/services/api/agents";
import { useUserStore } from "@/stores/use-user-store";

import { AgentAvatar } from "./agent-avatar";

type WorkstationStatus = "idle" | "running" | "success" | "failed";

type WorkstationResult = {
  id: string;
  url: string;
  storageKey: string;
  width: number;
  height: number;
  durationMs: number;
};

// 父层 PUT 写回数据库的 patch payload。referenceKeys 传空数组显式清空，outputKey / errorMessage 用空串。
// status: "running" 现在入库——指向后端任务化生图的那条 generation（runningGenerationId），
// 刷新 / 切走再回来都能据此续上轮询，不再丢进度。
export type WorkstationCardPatch = {
  referenceKeys?: string[];
  extraNote?: string;
  outputKey?: string;
  status?: "idle" | "running" | "success" | "failed";
  runningGenerationId?: string;
  errorMessage?: string;
  durationMs?: number;
};

type AgentWorkstationProps = {
  agent: Agent;
  onRemove: () => void;
  onEdit: () => void;
  // 调用方接管「这个角色又跑了一次」语义，用于父层刷新 usageCount。
  onUsed: () => void;
  // 生成完成（无论成功失败）通知父层，让 records drawer 刷新列表。
  onGenerationSaved?: () => void;
  // 从服务端拉到的卡片状态，mount 时用来 hydrate 内部 useState（reference / extraNote / status / result）。
  // 不传或 null 表示这是新加入工作区的空卡（理论上应当极少出现，因为加入即建卡）。
  initialCard?: AgentWorkstationCard | null;
  // 关键状态变更时由父层 PUT 回 /api/agent-workstations/me。extraNote 内部 debounce 800ms。
  // 父层基于 (userId, agentId) upsert，前端无需关心是 insert 还是 update。
  onPersistCard?: (patch: WorkstationCardPatch) => void;
};

// 一个角色独占一个工作台卡片：自己的 reference / extra prompt / 状态 / 结果，完全独立。
// 直接复用 /image 工作台的 requestEdit / requestGeneration，区别只在于：
//   - 不让用户写 prompt，由 agent.systemPrompt 替代；
//   - 可选「附加说明」会附加在 systemPrompt 后面（用换行隔开），覆盖角色细节。
export function AgentWorkstation({ agent, onRemove, onEdit, onUsed, onGenerationSaved, initialCard, onPersistCard }: AgentWorkstationProps) {
  const { message } = App.useApp();
  const token = useUserStore((state) => state.token);
  // mount 时从 initialCard hydrate 各内部状态。后续直接走本地 setState + onPersistCard，
  // 不再监听 initialCard 的变化（避免父层缓存刷新触发的 hydrate 把用户当前输入回滚）。
  const [referenceKeys, setReferenceKeys] = useState<string[]>(() => initialCard?.referenceKeys?.filter(Boolean) || []);
  const [extraNote, setExtraNote] = useState(initialCard?.extraNote || "");
  // running 入库了：hydrate 时也保留 running 状态，下面的 useQuery 会按 runningGenerationId 自动续上轮询，
  // 实现「刷新页面 / 切走再回来都能续上进度」。runningGenerationId 缺失的 running 状态视为脏数据，按 idle 兜底。
  const [status, setStatus] = useState<WorkstationStatus>(() => {
    if (initialCard?.status === "running" && initialCard?.runningGenerationId) return "running";
    if (initialCard?.status === "success") return "success";
    if (initialCard?.status === "failed") return "failed";
    return "idle";
  });
  // 后端任务化生图：status=running 时关联的那条 generation id，前端按它轮询拿进度。
  const [runningGenerationId, setRunningGenerationId] = useState<string>(
    initialCard?.status === "running" ? (initialCard?.runningGenerationId || "") : "",
  );
  const [errorMessage, setErrorMessage] = useState(initialCard?.errorMessage || "");
  const [result, setResult] = useState<WorkstationResult | null>(() => {
    if (!initialCard?.outputKey) return null;
    return {
      id: `restored-output-${initialCard.outputKey}`,
      url: imageUrl(initialCard.outputKey),
      storageKey: initialCard.outputKey,
      width: 0,
      height: 0,
      durationMs: initialCard.durationMs || 0,
    };
  });
  const [elapsedMs, setElapsedMs] = useState(0);
  const startedAtRef = useRef(0);
  // extraNote 防抖 PUT 计时器
  const extraNotePersistTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // 卡片折叠状态：纯 UI 偏好，按角色 id 存 localStorage（不上云）。
  // 折叠后只留头部（头像 + 名字 + 状态 + 产物缩略图），把上传区 / 附加说明 / 结果都收起来，
  // 工作区里挂很多角色时省垂直空间、方便扫一眼各卡状态。
  const collapseStorageKey = `infinite-canvas:agents:card-collapsed:${agent.id}`;
  const [collapsed, setCollapsed] = useState(() => {
    if (typeof window === "undefined") return false;
    return window.localStorage.getItem(collapseStorageKey) === "1";
  });
  const toggleCollapsed = () => {
    setCollapsed((prev) => {
      const next = !prev;
      if (typeof window !== "undefined") {
        window.localStorage.setItem(collapseStorageKey, next ? "1" : "0");
      }
      return next;
    });
  };

  // 计时器：hydrate 出来的 running 状态 startedAtRef 还是 0，effect 启动时若为 0 就用「现在」做起点，
  // 至少能看到从打开页面到完成的耗时（真正起点要查 generation.createdAt 才能拿到，太啰嗦不值得）。
  useEffect(() => {
    if (status !== "running") return;
    if (!startedAtRef.current) startedAtRef.current = performance.now();
    const timer = window.setInterval(() => setElapsedMs(performance.now() - startedAtRef.current), 500);
    return () => window.clearInterval(timer);
  }, [status]);

  // 后端任务化生图轮询：status=running 且 runningGenerationId 非空时，2s 拉一次 generation 看进度。
  // 拿到终态 → 把结果同步到本地 + PUT 回卡片；上游 worker 跑完会把 generation.status 收敛成 success/failed/partial。
  const generationQuery = useQuery({
    queryKey: ["my-generation", runningGenerationId],
    queryFn: () => fetchGeneration(token, runningGenerationId),
    enabled: Boolean(token) && status === "running" && Boolean(runningGenerationId),
    refetchInterval: (query) => {
      const data = query.state.data;
      return data && data.status !== "running" ? false : 2000;
    },
    refetchOnWindowFocus: true,
    retry: false,
    staleTime: 0,
  });

  useEffect(() => {
    const gen = generationQuery.data;
    if (!gen) return;
    if (status !== "running") return;
    if (gen.status === "running") return;
    // 终态收敛：success / partial（角色工作台 n=1 不会出 partial 但兜一下）/ failed
    if (gen.status === "success" || gen.status === "partial") {
      const outputKey = gen.thumbnails && gen.thumbnails[0] ? gen.thumbnails[0] : "";
      if (!outputKey) {
        // 后端说成功了但没产物 —— 当 failed 兜底处理，不让卡片永远卡 running
        setStatus("failed");
        setErrorMessage("生成完成但没拿到产物图");
        onPersistCard?.({ status: "failed", errorMessage: "生成完成但没拿到产物图", outputKey: "", runningGenerationId: "" });
        setRunningGenerationId("");
        return;
      }
      const durationMs = gen.durationMs || (startedAtRef.current ? performance.now() - startedAtRef.current : 0);
      setResult({
        id: `gen-${gen.id}-0`,
        url: imageUrl(outputKey),
        storageKey: outputKey,
        width: 0,
        height: 0,
        durationMs,
      });
      setStatus("success");
      setErrorMessage("");
      onUsed();
      onPersistCard?.({
        status: "success",
        outputKey,
        errorMessage: "",
        durationMs: Math.round(durationMs),
        runningGenerationId: "",
      });
      setRunningGenerationId("");
      onGenerationSaved?.();
      return;
    }
    // failed
    const msg = (gen.errors && gen.errors[0]) || "生成失败";
    setStatus("failed");
    setErrorMessage(msg);
    onPersistCard?.({
      status: "failed",
      errorMessage: msg,
      outputKey: "",
      durationMs: gen.durationMs || Math.round(startedAtRef.current ? performance.now() - startedAtRef.current : 0),
      runningGenerationId: "",
    });
    setRunningGenerationId("");
    onGenerationSaved?.();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [generationQuery.data]);

  // 卸载时清理 extraNote 防抖计时器，避免组件销毁后还 PUT 一次。
  useEffect(() => () => {
    if (extraNotePersistTimerRef.current) clearTimeout(extraNotePersistTimerRef.current);
  }, []);

  // 修改附加说明：本地立即更新；800ms 防抖后才 PUT 回库，避免连打字每个字符一次请求。
  const handleExtraNoteChange = (next: string) => {
    setExtraNote(next);
    if (extraNotePersistTimerRef.current) clearTimeout(extraNotePersistTimerRef.current);
    extraNotePersistTimerRef.current = setTimeout(() => {
      onPersistCard?.({ extraNote: next });
    }, 800);
  };

  // 原图列表变化（上传 / 剪切板 / 粘贴 / 拖拽 / 换 / 删都由 ReferenceImagesField 统一处理后回调）：
  // 本地立即更新 + 把整组 storageKey PUT 回卡片，跨设备能恢复。
  const handleReferenceKeysChange = (keys: string[]) => {
    setReferenceKeys(keys);
    onPersistCard?.({ referenceKeys: keys });
  };

  const composedPrompt = useMemo(() => {
    const base = agent.systemPrompt.trim();
    const extra = extraNote.trim();
    if (!extra) return base;
    return `${base}\n\n补充说明：${extra}`;
  }, [agent.systemPrompt, extraNote]);

  // 后端任务化生图：发起一条 running generation 立刻入库，worker 后台跑；本地 status=running、
  // 把 generation.id 持久化到卡片的 runningGenerationId。之后由 generationQuery 轮询拿进度，
  // 终态由 useEffect 收敛。刷新页面 / 切走再回来都能据此续上 —— 不再丢进度。
  const generate = async () => {
    if (!token) {
      message.error("请先登录");
      return;
    }
    if (!composedPrompt) {
      message.error("当前角色的系统提示词为空，请先编辑角色");
      return;
    }
    // 把「角色绑定的固定参考图（最多 3 张）」和「用户在卡片上传的原图（最多 9 张）」拼成 references。
    // 角色参考图按设置顺序排在前（先验风格 / 构图参考），用户原图在后（要被处理的目标）。
    // 上游 /v1/images/edits 最多 9 张，相加超过按「先角色后用户」截断并提示。
    const MAX_EDIT_REFERENCES = 9;
    const agentRefKeys = (agent.referenceImageKeys || []).filter(Boolean);
    let combinedKeys = [...agentRefKeys, ...referenceKeys.filter(Boolean)];
    if (combinedKeys.length > MAX_EDIT_REFERENCES) {
      message.warning(`参考图最多 ${MAX_EDIT_REFERENCES} 张（含角色固定参考图），已自动取前 ${MAX_EDIT_REFERENCES} 张`);
      combinedKeys = combinedKeys.slice(0, MAX_EDIT_REFERENCES);
    }
    const mode = combinedKeys.length ? "edit" : "image";
    const size = agent.defaultSize || defaultConfig.size;
    const quality = agent.defaultQuality || defaultConfig.quality;

    // 先切本地 running + 起本地计时器，再 POST；只有 POST 失败才回退到 failed。
    setStatus("running");
    setErrorMessage("");
    setElapsedMs(0);
    setResult(null);
    startedAtRef.current = performance.now();

    try {
      const record = await runGeneration(token, {
        prompt: composedPrompt,
        mode,
        size,
        quality,
        count: 1,
        references: combinedKeys,
        agentId: agent.id,
      });
      setRunningGenerationId(record.id);
      // 立即 PUT 一次，把 running + runningGenerationId 落库 —— 刷新页面也能据此续上轮询。
      onPersistCard?.({
        status: "running",
        runningGenerationId: record.id,
        outputKey: "",
        errorMessage: "",
        durationMs: 0,
      });
      onUsed();
      onGenerationSaved?.();
    } catch (error) {
      const msg = error instanceof Error ? error.message : "发起生成失败";
      setStatus("failed");
      setErrorMessage(msg);
      onPersistCard?.({
        status: "failed",
        errorMessage: msg,
        outputKey: "",
        runningGenerationId: "",
        durationMs: Math.round(performance.now() - startedAtRef.current),
      });
    }
  };

  const downloadResult = () => {
    if (!result) return;
    const link = document.createElement("a");
    link.href = result.url;
    link.download = `${agent.name}-${Date.now()}.png`;
    link.click();
  };

  const saveResultToAssets = async () => {
    if (!result || !token) return;
    try {
      await saveMyAsset(token, {
        title: `${agent.name} 生成结果`,
        type: "image",
        coverUrl: result.url,
        tags: [],
        category: "角色工作台",
        description: extraNote || agent.description,
        url: result.url,
      });
      message.success("已加入我的素材");
    } catch (error) {
      message.error(error instanceof Error ? error.message : "保存失败");
    }
  };

  const resetForNext = () => {
    setStatus("idle");
    setResult(null);
    setErrorMessage("");
    setElapsedMs(0);
    setRunningGenerationId("");
    // 把 outputKey / errorMessage / durationMs / status / runningGenerationId 都重置回 idle，
    // 下次进卡片就是干净的「待生成」状态。reference / extraNote 保留不动。
    onPersistCard?.({
      status: "idle",
      outputKey: "",
      errorMessage: "",
      durationMs: 0,
      runningGenerationId: "",
    });
  };

  const statusPill = (() => {
    if (status === "running") return <Tag color="blue" className="m-0">生成中 {formatDuration(elapsedMs)}</Tag>;
    if (status === "success") return <Tag color="green" className="m-0">已完成</Tag>;
    if (status === "failed") return <Tag color="red" className="m-0">失败</Tag>;
    return <Tag className="m-0">待上传</Tag>;
  })();

  return (
    <div className="flex w-full min-w-0 flex-col gap-3 rounded-lg border border-stone-200 bg-card p-3 shadow-sm dark:border-stone-800">
      {/* 头部第 1 行：头像 + 角色名（可点编辑） + 折叠按钮 + 右上 X 移出。 */}
      <div className="flex items-center gap-2">
        <AgentAvatar name={agent.name} avatarUrl={agent.avatarUrl} size={32} />
        <button type="button" onClick={onEdit} className="min-w-0 flex-1 text-left">
          <div className="truncate text-sm font-semibold hover:underline">{agent.name}</div>
        </button>
        <button
          type="button"
          className="grid size-7 shrink-0 place-items-center rounded text-stone-400 transition hover:bg-stone-100 hover:text-stone-700 dark:hover:bg-stone-800 dark:hover:text-stone-200"
          onClick={toggleCollapsed}
          aria-label={collapsed ? "展开" : "折叠"}
          title={collapsed ? "展开" : "折叠"}
        >
          {collapsed ? <ChevronDown className="size-4" /> : <ChevronUp className="size-4" />}
        </button>
        <button
          type="button"
          className="grid size-7 shrink-0 place-items-center rounded text-stone-400 transition hover:bg-red-50 hover:text-red-500 dark:hover:bg-red-950/30"
          onClick={onRemove}
          aria-label="移出工作区"
          title="移出工作区"
        >
          <X className="size-3.5" />
        </button>
      </div>
      {/* 状态行：折叠时左侧补一张产物 / 原图小缩略图，让收起后也能一眼看到这张卡的成果。 */}
      <div className="flex items-center justify-between gap-2">
        {collapsed && (result?.url || referenceKeys[0]) ? (
          <img
            src={result?.url || imageUrl(referenceKeys[0])}
            alt=""
            className="size-8 shrink-0 rounded border border-stone-200 object-cover dark:border-stone-800"
          />
        ) : <span />}
        {statusPill}
      </div>

      {/* 折叠后只保留上面的头部 + 状态行；下面的参考图 / 上传 / 附加说明 / 结果 / 生成按钮全收起。 */}
      {collapsed ? null : (
      <>
      {agent.referenceImageKeys?.length ? (
        <div className="flex items-center gap-2 rounded-md bg-stone-50 px-2.5 py-1.5 text-xs text-stone-600 dark:bg-stone-900 dark:text-stone-400">
          <div className="flex shrink-0 -space-x-2">
            {agent.referenceImageKeys.slice(0, 3).map((key) => (
              <img
                key={key}
                src={imageUrl(key)}
                alt="角色参考图"
                className="size-7 rounded border border-white object-cover dark:border-stone-900"
              />
            ))}
          </div>
          <span className="truncate">已带 {agent.referenceImageKeys.length} 张角色参考图，会和你的原图一起作为参考</span>
        </div>
      ) : null}

      {/* 原图上传：复用公共 ReferenceImagesField，支持上传 / 剪切板 / 粘贴 / 拖拽，最多 9 张。
          一张不传也行——有角色固定参考图时按参考图生图，否则纯文生图。 */}
      <ReferenceImagesField
        value={referenceKeys}
        onChange={handleReferenceKeysChange}
        max={9}
        label="原图"
        disabled={status === "running"}
        thumbSize={84}
        title="原图（最多 9 张，可不传）"
        emptyText={agent.referenceImageKeys?.length ? "未上传时按角色参考图生图" : "拖入 / 粘贴 / 点击上传，未上传也可纯生图"}
      />

      <Input.TextArea
        value={extraNote}
        onChange={(event) => handleExtraNoteChange(event.target.value)}
        placeholder="附加说明（可选）—— 会拼到角色的系统提示词后面，例如：保留原始光影、背景换成纯白"
        rows={2}
        disabled={status === "running"}
      />

      {/* 跟 /image 工作台 / 画布节点 prompt 面板 / 画布助手输入框一样，提供「提示词优化」按钮 */}
      <PromptImproveBar
        getPrompt={() => extraNote}
        onAccept={(improved) => handleExtraNoteChange(improved)}
        disabled={status === "running"}
      />

      {status === "running" ? (
        <div className="flex items-center justify-center gap-2 rounded-md bg-stone-50 p-3 text-sm text-stone-500 dark:bg-stone-900 dark:text-stone-400">
          <LoaderCircle className="size-4 animate-spin" />
          正在生成…
        </div>
      ) : null}

      {status === "failed" ? (
        <div className="flex items-center justify-between gap-2 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-600 dark:border-red-900 dark:bg-red-950/30 dark:text-red-300">
          <span className="line-clamp-2">{errorMessage || "生成失败"}</span>
          <Button size="small" danger icon={<RotateCw className="size-3.5" />} onClick={() => void generate()}>重试</Button>
        </div>
      ) : null}

      {status === "success" && result ? (
        <div className="space-y-2">
          <Image src={result.url} alt={`${agent.name} 结果`} className="!w-full rounded-md object-contain" preview={{ mask: "查看大图" }} />
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-stone-500 dark:text-stone-400">
            {result.width && result.height ? <span>{result.width}×{result.height}</span> : null}
            {result.durationMs ? <span>{formatDuration(result.durationMs)}</span> : null}
          </div>
          <div className="flex flex-wrap gap-1.5">
            <Button size="small" icon={<Download className="size-3.5" />} onClick={downloadResult}>下载</Button>
            <Button size="small" icon={<FolderPlus className="size-3.5" />} onClick={() => void saveResultToAssets()}>加入素材</Button>
            {/* 「重做」：用当前的原图 + 附加说明（用户可能改过）直接跑一次。
                generate() 自己会把 status 切到 running、新结果回来后 setResult 覆盖旧的产物，
                不用先 reset。想真的清回 idle 走「清空」按钮。 */}
            <Button size="small" type="primary" icon={<RotateCw className="size-3.5" />} onClick={() => void generate()} title="用当前的原图和附加说明直接重做">重做</Button>
            <Button size="small" type="text" onClick={resetForNext} title="清空当前产物回到待生成状态">清空</Button>
          </div>
        </div>
      ) : null}

      {status !== "success" ? (
        <Button
          type="primary"
          icon={<Sparkles className="size-4" />}
          loading={status === "running"}
          disabled={status === "running"}
          onClick={() => void generate()}
          block
        >
          开始生成
        </Button>
      ) : null}
      </>
      )}
    </div>
  );
}
