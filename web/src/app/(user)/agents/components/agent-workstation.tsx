"use client";

import { ClipboardPaste, Download, FolderPlus, ImagePlus, LoaderCircle, RotateCw, Sparkles, Upload, X } from "lucide-react";
import { App, Button, Image, Input, Tag } from "antd";
import { useEffect, useMemo, useRef, useState, type ClipboardEvent as ReactClipboardEvent, type DragEvent as ReactDragEvent } from "react";

import { defaultConfig } from "@/lib/ai-config";
import { createId } from "@/lib/id";
import { formatDuration, readImageMeta } from "@/lib/image-utils";
import { useImageUploader } from "@/lib/use-image-uploader";
import type { AgentWorkstationCard } from "@/services/api/agent-workstations";
import { saveGeneration } from "@/services/api/generations";
import { requestEdit, requestGeneration, type GeneratedImage as GeneratedImagePayload } from "@/services/api/image";
import { saveMyAsset } from "@/services/api/my-assets";
import { imageUrl, uploadImage } from "@/services/image-storage";
import type { Agent } from "@/services/api/agents";
import { useUserStore } from "@/stores/use-user-store";
import type { ReferenceImage } from "@/types/image";

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

// 父层 PUT 写回数据库的 patch payload。referenceKey / outputKey / errorMessage 用空串显式清空。
// status: 'running' 不入库（页面挂掉后没法续跑，恢复时全部按 idle）。
export type WorkstationCardPatch = {
  referenceKey?: string;
  extraNote?: string;
  outputKey?: string;
  status?: "idle" | "success" | "failed";
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
  const uploadWithToast = useImageUploader();
  const fileInputRef = useRef<HTMLInputElement>(null);
  // mount 时从 initialCard hydrate 各内部状态。后续直接走本地 setState + onPersistCard，
  // 不再监听 initialCard 的变化（避免父层缓存刷新触发的 hydrate 把用户当前输入回滚）。
  const [reference, setReference] = useState<ReferenceImage | null>(() => {
    if (!initialCard?.referenceKey) return null;
    return {
      id: `restored-ref-${initialCard.referenceKey}`,
      name: "原图",
      type: "image/*",
      dataUrl: imageUrl(initialCard.referenceKey),
      storageKey: initialCard.referenceKey,
    };
  });
  const [extraNote, setExtraNote] = useState(initialCard?.extraNote || "");
  // server 端的 running 不入库，恢复时全部按 idle 渲染
  const [status, setStatus] = useState<WorkstationStatus>(
    initialCard?.status === "success" ? "success"
    : initialCard?.status === "failed" ? "failed"
    : "idle",
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
  const [dragHighlight, setDragHighlight] = useState(false);
  const [elapsedMs, setElapsedMs] = useState(0);
  const startedAtRef = useRef(0);
  // extraNote 防抖 PUT 计时器
  const extraNotePersistTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (status !== "running") return;
    const timer = window.setInterval(() => setElapsedMs(performance.now() - startedAtRef.current), 500);
    return () => window.clearInterval(timer);
  }, [status]);

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

  const handleFilePick = async (file?: File | null) => {
    if (!file) return;
    if (!file.type.startsWith("image/")) {
      message.error("请选择图片文件");
      return;
    }
    try {
      const stored = await uploadWithToast(file, { label: "原图" });
      setReference({ id: createId(), name: file.name, type: stored.mimeType, dataUrl: stored.url, storageKey: stored.storageKey });
      onPersistCard?.({ referenceKey: stored.storageKey });
    } catch {
      // useImageUploader 已经弹错误
    }
  };

  // 用户点 X 移除当前原图：本地清掉 + 后端把 referenceKey 清空。
  const handleRemoveReference = () => {
    setReference(null);
    onPersistCard?.({ referenceKey: "" });
  };

  const handlePaste = (event: ReactClipboardEvent<HTMLDivElement>) => {
    const items = Array.from(event.clipboardData?.items || []);
    const file = items.find((item) => item.kind === "file" && item.type.startsWith("image/"))?.getAsFile();
    if (!file) return;
    event.preventDefault();
    void handleFilePick(file);
  };

  const handlePasteFromClipboard = async () => {
    try {
      const items = await navigator.clipboard.read();
      for (const item of items) {
        const imageType = item.types.find((type) => type.startsWith("image/"));
        if (!imageType) continue;
        const blob = await item.getType(imageType);
        const file = new File([blob], `clipboard-${Date.now()}.png`, { type: imageType });
        await handleFilePick(file);
        return;
      }
      message.error("剪切板里没有可读取的图片");
    } catch {
      message.error("剪切板里没有可读取的图片");
    }
  };

  const handleDragOver = (event: ReactDragEvent<HTMLDivElement>) => {
    if (!Array.from(event.dataTransfer.types).includes("Files")) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = "copy";
    setDragHighlight(true);
  };
  const handleDragLeave = (event: ReactDragEvent<HTMLDivElement>) => {
    if (event.currentTarget.contains(event.relatedTarget as Node | null)) return;
    setDragHighlight(false);
  };
  const handleDrop = (event: ReactDragEvent<HTMLDivElement>) => {
    event.preventDefault();
    setDragHighlight(false);
    const file = Array.from(event.dataTransfer.files || []).find((item) => item.type.startsWith("image/"));
    if (!file) {
      if (event.dataTransfer.files?.length) message.error("拖入的不是图片，已忽略");
      return;
    }
    void handleFilePick(file);
  };

  const composedPrompt = useMemo(() => {
    const base = agent.systemPrompt.trim();
    const extra = extraNote.trim();
    if (!extra) return base;
    return `${base}\n\n补充说明：${extra}`;
  }, [agent.systemPrompt, extraNote]);

  const generate = async () => {
    if (!token) {
      message.error("请先登录");
      return;
    }
    if (!composedPrompt) {
      message.error("当前角色的系统提示词为空，请先编辑角色");
      return;
    }
    setStatus("running");
    setErrorMessage("");
    setElapsedMs(0);
    startedAtRef.current = performance.now();
    const config = {
      size: agent.defaultSize || defaultConfig.size,
      quality: agent.defaultQuality || defaultConfig.quality,
      count: "1",
    };
    // 把「角色绑定的所有参考图（最多 3 张）」和「用户当前上传的原图」拼成 references 一起发到模型。
    // 角色参考图按设置顺序排在前（先验风格 / 构图参考），用户原图在后（要被处理的目标）。
    // 任一非空就走 /v1/images/edits；两者都空才回落到纯文生图 /generations。
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
    if (reference) references.push(reference);

    const mode = references.length ? "edit" : "image";
    const referenceKeys = references.map((ref) => ref.storageKey || "").filter(Boolean);
    const requestParams: Record<string, unknown> = {
      mode,
      n: 1,
      size: config.size,
      quality: config.quality,
      referenceCount: references.length,
      via: "agent-workstation",
    };
    try {
      const res = references.length
        ? await requestEdit(token, config, composedPrompt, references)
        : await requestGeneration(token, config, composedPrompt);
      const first: GeneratedImagePayload | undefined = res.images[0];
      if (!first) throw new Error("接口没有返回图片");
      const stored = await uploadImage(first.dataUrl);
      let width = 0;
      let height = 0;
      try {
        const meta = await readImageMeta(stored.url);
        width = meta.width;
        height = meta.height;
      } catch {
        // meta 读取失败不致命
      }
      const durationMs = performance.now() - startedAtRef.current;
      setResult({
        id: first.id,
        url: stored.url,
        storageKey: stored.storageKey,
        width,
        height,
        durationMs,
      });
      setStatus("success");
      onUsed();
      // 把结果 PUT 到 workstation_cards，下次进同账号能直接看到这张产物图。
      onPersistCard?.({
        status: "success",
        outputKey: stored.storageKey,
        errorMessage: "",
        durationMs: Math.round(durationMs),
      });
      // 落一条 generations 记录，让「生成记录」Drawer 看得到；带 agentId 方便按角色筛选。
      // 失败不阻断主流程，弹消息即可。
      saveGeneration(token, {
        prompt: composedPrompt,
        mode,
        model: "",
        size: config.size,
        quality: config.quality,
        count: 1,
        successCount: 1,
        failCount: 0,
        durationMs,
        status: "success",
        thumbnails: stored.storageKey ? [stored.storageKey] : [],
        references: referenceKeys,
        errors: [],
        requestParams,
        upstreamMeta: res.upstreamMeta || "",
        agentId: agent.id,
      }).then(() => onGenerationSaved?.()).catch(() => {
        // 写库失败只是没法在 Drawer 里看到这一条，不影响用户拿到图，静默。
      });
    } catch (error) {
      const msg = error instanceof Error ? error.message : "生成失败";
      setErrorMessage(msg);
      setStatus("failed");
      // 同步把 failed 状态 + 错误信息推到 workstation_cards，下次进可以看到上次失败原因，方便重试。
      onPersistCard?.({
        status: "failed",
        errorMessage: msg,
        outputKey: "",
        durationMs: Math.round(performance.now() - startedAtRef.current),
      });
      // 失败也写一条记录，方便 Drawer 里复盘错误。
      saveGeneration(token, {
        prompt: composedPrompt,
        mode,
        model: "",
        size: config.size,
        quality: config.quality,
        count: 1,
        successCount: 0,
        failCount: 1,
        durationMs: performance.now() - startedAtRef.current,
        status: "failed",
        thumbnails: [],
        references: referenceKeys,
        errors: [msg],
        requestParams,
        upstreamMeta: "",
        agentId: agent.id,
      }).then(() => onGenerationSaved?.()).catch(() => {
        // ignore
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
    // 把 outputKey / errorMessage / durationMs / status 都重置回 idle，
    // 下次进卡片就是干净的「待生成」状态。reference / extraNote 保留不动。
    onPersistCard?.({
      status: "idle",
      outputKey: "",
      errorMessage: "",
      durationMs: 0,
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
      {/* 头部第 1 行：头像 + 角色名（可点编辑） + 右上 X 移出。
          状态徽标移到第 2 行单独占位，避免长名 + 长状态 + X 三者抢宽度。 */}
      <div className="flex items-center gap-2">
        <AgentAvatar name={agent.name} avatarUrl={agent.avatarUrl} size={32} />
        <button type="button" onClick={onEdit} className="min-w-0 flex-1 text-left">
          <div className="truncate text-sm font-semibold hover:underline">{agent.name}</div>
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
      <div className="flex justify-end">{statusPill}</div>

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

      <div
        className={`relative flex min-h-32 flex-col items-center justify-center rounded-lg border-2 border-dashed p-3 text-center transition-colors ${dragHighlight ? "border-blue-500 bg-blue-50/40 dark:border-blue-400 dark:bg-blue-500/10" : "border-stone-300 dark:border-stone-700"}`}
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
        onDrop={handleDrop}
        onPaste={handlePaste}
      >
        {reference ? (
          <div className="relative size-full">
            <img src={reference.dataUrl} alt={reference.name} className="mx-auto max-h-40 rounded-md object-contain" />
            <button
              type="button"
              className="absolute right-1 top-1 grid size-6 place-items-center rounded bg-black/60 text-white hover:bg-black/80"
              onClick={handleRemoveReference}
              aria-label="移除原图"
            >
              <X className="size-3.5" />
            </button>
          </div>
        ) : (
          <>
            <ImagePlus className="mb-2 size-8 text-stone-400" />
            <div className="text-xs text-stone-500 dark:text-stone-400">{dragHighlight ? "松开以添加原图" : "拖入 / 粘贴 / 点击上传原图"}</div>
            <div className="mt-2 flex gap-2">
              <Button size="small" icon={<Upload className="size-3.5" />} onClick={() => fileInputRef.current?.click()}>上传</Button>
              <Button size="small" icon={<ClipboardPaste className="size-3.5" />} onClick={() => void handlePasteFromClipboard()}>剪切板</Button>
            </div>
            <span className="mt-2 text-[11px] text-stone-400">{agent.referenceImageKeys?.length ? "未上传时按角色参考图生图" : "未上传也可生成（纯生图）"}</span>
          </>
        )}
        <input
          ref={fileInputRef}
          type="file"
          accept="image/*"
          style={{ display: "none" }}
          tabIndex={-1}
          aria-hidden
          onChange={(event) => {
            void handleFilePick(event.target.files?.[0]);
            event.target.value = "";
          }}
        />
      </div>

      <Input.TextArea
        value={extraNote}
        onChange={(event) => handleExtraNoteChange(event.target.value)}
        placeholder="附加说明（可选）—— 会拼到角色的系统提示词后面，例如：保留原始光影、背景换成纯白"
        rows={2}
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
            <Button size="small" onClick={resetForNext}>再来一张</Button>
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
    </div>
  );
}
