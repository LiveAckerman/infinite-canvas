"use client";

import { BookOpen, CheckSquare, ClipboardPaste, Download, FolderPlus, History, ImagePlus, ImageOff, LoaderCircle, PanelLeftClose, PanelLeftOpen, PenLine, Plus, SlidersHorizontal, Sparkles, Trash2, Upload } from "lucide-react";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useRef, useState, type ClipboardEvent as ReactClipboardEvent, type DragEvent as ReactDragEvent } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { App, AutoComplete, Button, Checkbox, Drawer, Empty, Image, Input, InputNumber, Modal, Select, Tag, Typography } from "antd";
import {
  DndContext,
  PointerSensor,
  closestCenter,
  useSensor,
  useSensors,
  type DragEndEvent,
} from "@dnd-kit/core";
import { SortableContext, arrayMove, horizontalListSortingStrategy, useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";

import { PromptSelectDialog } from "@/components/prompts/prompt-select-dialog";
import { SubmitPromptModal } from "@/components/prompts/submit-prompt-modal";
import { PromptImproveBar } from "@/components/prompt-improve-panel";
import { AssetPickerModal, type InsertAssetPayload } from "@/app/(user)/canvas/components/asset-picker-modal";
import type { AiConfig } from "@/lib/ai-config";
import { createId } from "@/lib/id";
import { formatBytes, formatDuration, readImageMeta } from "@/lib/image-utils";
import { resolveImageUrl } from "@/services/image-storage";
import { useImageUploader } from "@/lib/use-image-uploader";
import { deleteGeneration, fetchGenerations, retryGeneration, runGeneration, saveGeneration, type GenerationListResponse, type GenerationRecord } from "@/services/api/generations";
import { saveMyAsset } from "@/services/api/my-assets";
import { useAiConfigStore } from "@/stores/use-ai-config-store";
import { fetchCurrentUser } from "@/services/api/auth";
import { useUserStore } from "@/stores/use-user-store";
import type { ReferenceImage } from "@/types/image";

type GeneratedImage = {
  id: string;
  dataUrl: string;
  storageKey?: string;
  durationMs: number;
  width: number;
  height: number;
  bytes: number;
};

type GenerationResultStatus = "pending" | "success" | "failed" | "missing";

type GenerationResult = {
  id: string;
  status: GenerationResultStatus;
  image?: GeneratedImage;
  error?: string;
  // 该结果对应的图床 storageKey（success 用 image.storageKey；missing 没有 image 但仍有 key）。
  // 删除生成结果时按它从 generation.thumbnails 里剔除。
  storageKey?: string;
};

type UpdateAiConfig = <K extends keyof AiConfig>(key: K, value: AiConfig[K]) => void;

const sizeOptions = ["auto", "1:1", "3:2", "2:3", "4:3", "3:4", "16:9", "9:16"].map((value) => ({ label: value, value }));
const qualityOptions = ["auto", "low", "medium", "high"].map((value) => ({ label: value, value }));

export type ImageWorkspaceProps = {
  initialLogId?: string;
};

export function ImageWorkspace({ initialLogId }: ImageWorkspaceProps) {
  const { message, modal } = App.useApp();
  const queryClient = useQueryClient();
  const router = useRouter();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const config = useAiConfigStore((state) => state.config);
  const updateConfig = useAiConfigStore((state) => state.updateConfig);
  const token = useUserStore((state) => state.token);
  const setCredits = useUserStore((state) => state.setCredits);
  const uploadWithToast = useImageUploader();
  const [prompt, setPrompt] = useState("");
  const [references, setReferences] = useState<ReferenceImage[]>([]);
  const [results, setResults] = useState<GenerationResult[]>([]);
  // submitting = 正在发起 /run 请求（很短）；真正的「生成中」由记录 status 决定（见下面派生的 running）。
  const [submitting, setSubmitting] = useState(false);
  const [logsOpen, setLogsOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [promptDialogOpen, setPromptDialogOpen] = useState(false);
  const [assetPickerOpen, setAssetPickerOpen] = useState(false);
  const [startedAt, setStartedAt] = useState(0);
  const [elapsedMs, setElapsedMs] = useState(0);
  const [selectedLogIds, setSelectedLogIds] = useState<string[]>([]);
  const [previewLog, setPreviewLog] = useState<GenerationRecord | null>(null);
  // 「生成进行中」= 正在发起请求，或当前预览记录处于后端 running 状态（后端任务化后，状态以记录为准，
  // 刷新 / 切回来都能恢复）。统一用它 gate「开始生成」按钮 / 删除入口 / 微调。
  const running = submitting || previewLog?.status === "running";
  const [deleteConfirmOpen, setDeleteConfirmOpen] = useState(false);
  // 串行删多条生成记录时锁住按钮 + 转 loading；deleteLogMutation.isPending 在循环里会
  // 短暂 true/false 交替导致按钮闪烁，所以用这个稳定 boolean 包住整个 for 循环。
  const [deletingLogs, setDeletingLogs] = useState(false);
  // 生成结果（产物图）的删除：多选模式开关 + 已选结果 id。仅 success / missing 这种带图床 key 的结果可删。
  const [resultSelectMode, setResultSelectMode] = useState(false);
  const [selectedResultIds, setSelectedResultIds] = useState<string[]>([]);
  // 拖拽图片到提示词 / 参考图区域时的视觉高亮，松手或离开时复位
  const [dragHighlight, setDragHighlight] = useState(false);
  // 「加入提示词库」Modal 开关
  const [submitPromptOpen, setSubmitPromptOpen] = useState(false);
  // 左侧"生成记录"面板折叠状态。localStorage 持久化（轻量偏好不上云），
  // 初始 false（展开）；移动端走 Drawer 不受这个 state 影响。
  const LEFT_PANEL_COLLAPSED_KEY = "infinite-canvas:image-log-panel-collapsed";
  const [leftPanelCollapsed, setLeftPanelCollapsed] = useState(() => {
    if (typeof window === "undefined") return false;
    return window.localStorage.getItem(LEFT_PANEL_COLLAPSED_KEY) === "1";
  });
  useEffect(() => {
    if (typeof window === "undefined") return;
    window.localStorage.setItem(LEFT_PANEL_COLLAPSED_KEY, leftPanelCollapsed ? "1" : "0");
  }, [leftPanelCollapsed]);
  const autoPreviewedIdRef = useRef<string | null>(null);
  // 当前选中的记录 id，在「选择记录」的那一刻同步写入。用来给异步的 setResults / setReferences 把关：
  // 切换很快时，慢 resolve 的旧记录 promise resolve 后若发现已不是当前选中，就丢弃，避免覆盖串台。
  const currentPreviewIdRef = useRef<string | null>(null);
  // 记录上一轮是否有 running 记录，用于「全部 running 都收敛」的下降沿刷新顶栏积分（无论当前看哪条）。
  const prevAnyRunningRef = useRef(false);
  // isGeneratingRef：发起 /run 请求那一小段置 true，挡住 auto-preview effect 在 URL / 列表缓存
  // 还没同步好的中间态里误把表单回填成别的记录。activeGenerationIdRef：本会话刚发起的记录 id，
  // previewGenerationLog 用它识别「这条 running 是我自己发的」，切回来时不重置表单（结果由轮询刷新）。
  const isGeneratingRef = useRef(false);
  const activeGenerationIdRef = useRef<string | null>(null);
  // 用户点了某张图的「微调」按钮后，把当时的 previewLog.id 暂存在这里，
  // 下一次 generate() 写库时把它作为 parentId 串到新记录上。用完即焚。
  const pendingParentIdRef = useRef<string | null>(null);

  const canGenerate = Boolean(prompt.trim());
  const generationCount = Math.max(1, Math.min(10, Number(config.count) || 1));

  // 参考图水平拖动重排：activationConstraint 让按钮 click 不会被识别成 drag。
  // 顺序对 /v1/images/edits 是有语义的（第一张通常被模型当主要构图参考），
  // 用户调整顺序后下一次 generate / 写库的 references 数组都会跟着变。
  const referenceSensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 6 } }));
  const handleReferenceReorder = (event: DragEndEvent) => {
    const { active, over } = event;
    if (!over || active.id === over.id) return;
    setReferences((value) => {
      const oldIndex = value.findIndex((ref) => ref.id === active.id);
      const newIndex = value.findIndex((ref) => ref.id === over.id);
      if (oldIndex < 0 || newIndex < 0) return value;
      return arrayMove(value, oldIndex, newIndex);
    });
  };

  const logsQuery = useQuery({
    // queryKey 带 "exclude-agent" 标记跟 /agents Drawer 的同名 query 区分缓存，
    // 避免某一边的 react-query setQueryData 误入侵另一边。
    queryKey: ["my-generations", "exclude-agent", token],
    // /image 左侧只展示「非角色工作台」发起的记录；agent 工作台的图走 /agents 的 Drawer。
    queryFn: () => fetchGenerations(token, { page: 1, pageSize: 100, excludeAgent: "1" }),
    enabled: Boolean(token),
    retry: false,
    // 有 running 记录时 2s 轮询，让后端任务的进度（新出的图 / 完成）实时刷到列表 + 右侧结果；
    // 全部终态后停止轮询。running 记录都在列表最前（按 created_at desc），不会被 100 条窗口漏掉。
    refetchInterval: (query) => {
      const data = query.state.data as GenerationListResponse | undefined;
      return data?.items.some((item) => item.status === "running") ? 2000 : false;
    },
  });

  useEffect(() => {
    if (logsQuery.isError) {
      message.error(logsQuery.error instanceof Error ? logsQuery.error.message : "读取生成记录失败");
    }
  }, [logsQuery.error, logsQuery.isError, message]);

  const saveLogMutation = useMutation({
    mutationFn: (payload: Parameters<typeof saveGeneration>[1]) => saveGeneration(token, payload),
    onSuccess: (saved) => {
      // 立刻把新记录推到 react-query 缓存最前，避免随后 router.replace 到 /image/{id}
      // 后，新挂载的页面读到旧缓存找不到这条记录而误报"记录不存在"。
      // 用新的 queryKey（带 exclude-agent 标记）跟 fetchGenerations 的 query 对齐，
      // 否则乐观写入会落到旧 key 不再被订阅的缓存里、UI 看不到。
      queryClient.setQueryData<GenerationListResponse>(["my-generations", "exclude-agent", token], (old) => {
        if (!old) return { items: [saved], total: 1 };
        const exists = old.items.some((item) => item.id === saved.id);
        if (exists) return { ...old, items: old.items.map((item) => (item.id === saved.id ? saved : item)) };
        return { ...old, items: [saved, ...old.items], total: old.total + 1 };
      });
      void queryClient.invalidateQueries({ queryKey: ["my-generations"] });
    },
    onError: (error) => {
      message.error(error instanceof Error ? error.message : "记录保存失败");
    },
  });

  const deleteLogMutation = useMutation({
    mutationFn: (id: string) => deleteGeneration(token, id),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["my-generations"] });
    },
    onError: (error) => {
      message.error(error instanceof Error ? error.message : "删除失败");
    },
  });

  // 把一条记录乐观写进左侧列表缓存（发起 / 重试后立即可见，并触发轮询）。跟 saveLogMutation.onSuccess 同款。
  const upsertLogCache = (record: GenerationRecord) => {
    queryClient.setQueryData<GenerationListResponse>(["my-generations", "exclude-agent", token], (old) => {
      if (!old) return { items: [record], total: 1 };
      const exists = old.items.some((item) => item.id === record.id);
      if (exists) return { ...old, items: old.items.map((item) => (item.id === record.id ? record : item)) };
      return { ...old, items: [record, ...old.items], total: old.total + 1 };
    });
  };

  const logs = logsQuery.data?.items || [];

  // 轮询拉到新数据后，把「当前正在生成的预览记录」同步到最新，并刷新右侧结果区
  // （成功图 / 还在生成中的占位 / 失败）。这样无论切页面、刷新、还是切到别的记录再切回，
  // 后端任务的进度都能恢复并继续显示，直到终态。
  useEffect(() => {
    if (!previewLog || previewLog.status !== "running") return;
    const fresh = logs.find((item) => item.id === previewLog.id);
    if (!fresh) return;
    // 状态 / 产物数 / 失败数都没变就不重复 re-derive（轮询会频繁触发本 effect）。
    if (
      fresh.status === previewLog.status &&
      fresh.thumbnails.length === previewLog.thumbnails.length &&
      (fresh.errors?.length || 0) === (previewLog.errors?.length || 0)
    ) {
      return;
    }
    setPreviewLog(fresh);
    currentPreviewIdRef.current = fresh.id;
    // 异步派生完成后复核仍是当前选中的记录才落地，避免轮询慢 resolve 覆盖用户已切走的记录。
    void deriveResultsFromRecord(fresh).then((next) => {
      if (currentPreviewIdRef.current === fresh.id) setResults(next);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [logs]);

  // 顶栏积分刷新：只要用户名下「还有 running 的生图」这件事从 true 变 false（任意任务收敛），
  // 就拉一次最新余额。这样即便用户已经切走 / 没盯着那条记录，积分也能及时更新。
  useEffect(() => {
    const anyRunning = logs.some((item) => item.status === "running");
    if (prevAnyRunningRef.current && !anyRunning && token) {
      void fetchCurrentUser(token).then((u) => { if (typeof u?.credits === "number") setCredits(u.credits); }).catch(() => {});
    }
    prevAnyRunningRef.current = anyRunning;
  }, [logs, token, setCredits]);

  // 兜底：previewLog 变化后同步 currentPreviewIdRef（覆盖删除 / 新建等没显式更新它的路径）。
  // 快速切换的竞态窗口已由 previewGenerationLog / generate / 轮询里的同步赋值处理，这里只是补漏。
  useEffect(() => {
    currentPreviewIdRef.current = previewLog?.id ?? null;
  }, [previewLog]);

  // 直接访问 /image/{id} 或在记录列表里点击某条记录后，自动把对应记录展开到右侧。
  // ⚠️ 正在生成（isGeneratingRef）时不能跑这条 effect：generate() 自己会改 URL / logs cache / autoPreviewedIdRef，
  // 三个状态不是同一次 render 提交的；中间会出现一个 race window —— logs.length 已经 +1、initialLogId
  // 还是上一条记录的 id，effect 误以为"用户点击了旧记录"，调 previewGenerationLog 把 refs / prompt 全部
  // 回填成旧记录的内容，刚改完的参考图就被覆盖回去了。生成全过程都受 isGeneratingRef 保护。
  useEffect(() => {
    if (isGeneratingRef.current) return;
    if (!initialLogId) return;
    if (autoPreviewedIdRef.current === initialLogId) return;
    if (!logs.length) return;
    const target = logs.find((log) => log.id === initialLogId);
    if (!target) {
      // 找不到这条记录，回 /image 不要让 URL 一直挂着无效 id。
      autoPreviewedIdRef.current = initialLogId;
      message.error("生成记录不存在或已被删除");
      router.replace("/image");
      return;
    }
    autoPreviewedIdRef.current = initialLogId;
    void previewGenerationLog(target, { skipNavigate: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialLogId, logs.length]);

  useEffect(() => {
    if (!running || !startedAt) return;
    const timer = window.setInterval(() => setElapsedMs(performance.now() - startedAt), 1000);
    return () => window.clearInterval(timer);
  }, [running, startedAt]);

  // 统一的"把若干 blob 上传成参考图"入口，供按钮上传 / 剪贴板 / 提示词 paste / 拖拽四种触发方式共用。
  // 单张失败只跳过那一张，其余继续，避免一张图挂了全员失败。
  const addReferencesFromBlobs = async (blobs: Blob[], hintPrefix = "ref") => {
    if (!blobs.length) return 0;
    const successes = await Promise.all(blobs.map(async (blob, index) => {
      try {
        const image = await uploadWithToast(blob, { label: "参考图" });
        const fallbackName = `${hintPrefix}-${Date.now()}-${index + 1}.png`;
        const name = blob instanceof File && blob.name ? blob.name : fallbackName;
        return { id: createId(), name, type: image.mimeType, dataUrl: image.url, storageKey: image.storageKey } as ReferenceImage;
      } catch {
        return null;
      }
    }));
    const next = successes.filter((item): item is ReferenceImage => item !== null);
    if (next.length) setReferences((value) => [...value, ...next]);
    return next.length;
  };

  const addReferences = async (files?: FileList | null) => {
    const imageFiles = Array.from(files || []).filter((file) => file.type.startsWith("image/"));
    await addReferencesFromBlobs(imageFiles, "upload");
  };

  const addReferencesFromClipboard = async () => {
    try {
      const items = await navigator.clipboard.read();
      const blobs = await Promise.all(items.flatMap((item) => item.types.filter((type) => type.startsWith("image/")).map((type) => item.getType(type))));
      if (!blobs.length) {
        message.error("剪切板里没有可读取的图片");
        return;
      }
      const count = await addReferencesFromBlobs(blobs, "clipboard");
      if (count) message.success(`已读取 ${count} 张参考图`);
      else message.error("剪切板里的图片上传失败");
    } catch {
      message.error("剪切板里没有可读取的图片");
    }
  };

  // textarea 原生 paste 事件：拦截 clipboardData 里的图片项（一张或多张），
  // 不阻止文字 paste，只在出现图片时 preventDefault 阻止 base64 文本被塞进 prompt。
  const handlePromptPaste = (event: ReactClipboardEvent<HTMLTextAreaElement>) => {
    const items = Array.from(event.clipboardData?.items || []);
    const files = items
      .filter((item) => item.kind === "file" && item.type.startsWith("image/"))
      .map((item) => item.getAsFile())
      .filter((file): file is File => file !== null);
    if (!files.length) return;
    event.preventDefault();
    void addReferencesFromBlobs(files, "paste");
  };

  // 拖拽进入：只有 dataTransfer.types 含 "Files" 才高亮，避免文本拖动也变蓝。
  const handleDragOver = (event: ReactDragEvent<HTMLElement>) => {
    if (!Array.from(event.dataTransfer.types).includes("Files")) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = "copy";
    setDragHighlight(true);
  };
  const handleDragLeave = (event: ReactDragEvent<HTMLElement>) => {
    // relatedTarget 在容器内移动时是子元素，不算真离开
    if (event.currentTarget.contains(event.relatedTarget as Node | null)) return;
    setDragHighlight(false);
  };
  const handleDropFiles = (event: ReactDragEvent<HTMLElement>) => {
    event.preventDefault();
    setDragHighlight(false);
    const files = Array.from(event.dataTransfer.files || []).filter((file) => file.type.startsWith("image/"));
    if (!files.length) {
      if (event.dataTransfer.files?.length) message.error("拖入的不是图片，已忽略");
      return;
    }
    void addReferencesFromBlobs(files, "drop");
  };

  const generate = async () => {
    const text = prompt.trim();
    if (!text) {
      message.error("请输入生图提示词");
      return;
    }
    if (!token) {
      message.error("请先登录");
      return;
    }

    const snapshot = buildRequestSnapshot();
    if (!snapshot) return;

    const referenceKeys = snapshot.references.map((ref) => ref.storageKey || "").filter(Boolean);
    // /image 的参考图都走 useImageUploader 落盘（有 storageKey）。万一有还没传完的，挡一下。
    if (snapshot.references.length && referenceKeys.length !== snapshot.references.length) {
      message.error("参考图还没上传完成，请稍候再试");
      return;
    }
    const mode: GenerationRecord["mode"] = referenceKeys.length ? "edit" : "image";

    // 抓取并清空「微调来源」标记：有 parentId → 新建一条记录（parent 指向源记录）。
    const parentId = pendingParentIdRef.current || undefined;
    pendingParentIdRef.current = null;
    // 没有 parentId 且当前已有 previewLog → 在这条记录上「二次生成累加」；否则新建一条。
    // 想强制开新记录走左侧「新建」按钮（清掉 previewLog）。
    const appendId = !parentId && previewLog ? previewLog.id : undefined;

    setSubmitting(true);
    setStartedAt(performance.now());
    setElapsedMs(0);
    isGeneratingRef.current = true;
    try {
      // 后端建（或追加）一条 running 记录 + 起后台任务，立即返回。生成本身在服务端跑，
      // 刷新 / 切走 / 换设备都不影响——回来轮询这条记录继续看进度。
      const record = await runGeneration(token, {
        id: appendId,
        prompt: text,
        mode,
        size: snapshot.config.size || "",
        quality: snapshot.config.quality || "",
        count: generationCount,
        references: referenceKeys,
        parentId,
      });
      upsertLogCache(record);
      setPreviewLog(record);
      currentPreviewIdRef.current = record.id;
      activeGenerationIdRef.current = record.id;
      autoPreviewedIdRef.current = record.id;
      // 立即渲染「生成中」占位（count - 已成功 - 已失败 张转圈）；之后由轮询刷新成实际产物。
      const derived = await deriveResultsFromRecord(record);
      if (currentPreviewIdRef.current === record.id) setResults(derived);
      if (!appendId) router.replace(`/image/${record.id}`);
      // 触发列表刷新 → refetchInterval 看到 running 记录后开始 2s 轮询。
      void queryClient.invalidateQueries({ queryKey: ["my-generations"] });
    } catch (error) {
      message.error(error instanceof Error ? error.message : "发起生成失败");
    } finally {
      setSubmitting(false);
      isGeneratingRef.current = false;
    }
  };

  const downloadImage = (image: GeneratedImage, index: number) => {
    const link = document.createElement("a");
    link.href = image.dataUrl;
    link.download = `image-${index + 1}.png`;
    link.click();
  };

  const addResultToReferences = async (image: GeneratedImage, index: number) => {
    const stored = await uploadWithToast(image.dataUrl, { label: "参考图" });
    setReferences((value) => [...value, { id: createId(), name: `result-${index + 1}.png`, type: stored.mimeType, dataUrl: stored.url, storageKey: stored.storageKey }]);
    message.success("已加入参考图");
  };

  // 用户点某张结果图的「微调」：把它加入参考图，并预置提示词前缀；
  // 同时把当前记录 id 暂存到 pendingParentIdRef，generate() 写库时会带 parentId。
  // 微调本质是「在这条记录基础上发起新一次图生图」，新记录通过 parentId 串回父记录。
  const refineResult = (image: GeneratedImage) => {
    if (running) {
      message.error("当前正在生成，请稍后再操作");
      return;
    }
    if (!image.storageKey) {
      message.error("这张图还没保存到服务器，无法微调");
      return;
    }
    setReferences((value) => {
      if (value.some((ref) => ref.storageKey === image.storageKey)) return value;
      return [
        ...value,
        {
          id: createId(),
          name: `refine-${Date.now()}.png`,
          type: "image/png",
          dataUrl: image.dataUrl,
          storageKey: image.storageKey,
        },
      ];
    });
    setPrompt((current) => {
      const prefix = "在这张图基础上：";
      if (current.trim()) return current;
      return prefix;
    });
    pendingParentIdRef.current = previewLog?.id || null;
    message.info("已加入参考图，请描述修改方向后点开始生成");
  };

  const saveResultToAssets = async (image: GeneratedImage, index: number) => {
    if (!token) {
      message.error("请先登录");
      return;
    }
    try {
      const url = image.dataUrl || (await uploadWithToast(image.dataUrl, { label: "素材图片" })).url;
      await saveMyAsset(token, {
        title: `生成结果 ${index + 1}`,
        type: "image",
        coverUrl: url,
        tags: [],
        category: "生图工作台",
        description: prompt,
        url,
      });
      message.success("已加入我的素材");
    } catch (error) {
      message.error(error instanceof Error ? error.message : "保存失败");
    }
  };

  const insertPickedAsset = async (payload: InsertAssetPayload) => {
    if (payload.kind === "text") {
      setPrompt(payload.content);
    } else {
      const stored = await uploadWithToast(payload.dataUrl, { label: "参考图" });
      setReferences((value) => [...value, { id: createId(), name: payload.title, type: stored.mimeType, dataUrl: stored.url, storageKey: stored.storageKey }]);
    }
    setAssetPickerOpen(false);
  };

  const createSession = () => {
    setPrompt("");
    setReferences([]);
    setResults([]);
    setElapsedMs(0);
    setStartedAt(0);
    setSelectedLogIds([]);
    setResultSelectMode(false);
    setSelectedResultIds([]);
    setPreviewLog(null);
    autoPreviewedIdRef.current = null;
    activeGenerationIdRef.current = null;
    // 点「新建」明确语义是「开始新的一次」，把生成次数回归默认 1，
    // 避免上一次跑了 N 张的偏好继续生效。同步推到服务器是预期行为。
    updateConfig("count", "1");
    router.replace("/image");
  };

  const deleteSelectedLogs = async () => {
    setDeletingLogs(true);
    try {
      for (const id of selectedLogIds) {
        try {
          await deleteLogMutation.mutateAsync(id);
        } catch {
          // mutation onError handles message
        }
      }
      if (previewLog && selectedLogIds.includes(previewLog.id)) {
        setPreviewLog(null);
        setResults([]);
        autoPreviewedIdRef.current = null;
        router.replace("/image");
      }
      setSelectedLogIds([]);
      setDeleteConfirmOpen(false);
    } finally {
      setDeletingLogs(false);
    }
  };

  // ===== 生成结果（产物图）删除：单张 / 多选 / 全部 =====
  // 只有带图床 key 的结果（success / missing）能删；pending / failed（没有真实图）不参与。
  const resultStorageKey = (result: GenerationResult) => result.image?.storageKey || result.storageKey || "";
  const isDeletableResult = (result: GenerationResult) =>
    (result.status === "success" || result.status === "missing") && Boolean(resultStorageKey(result));
  const deletableResults = useMemo(() => results.filter(isDeletableResult), [results]);
  const allResultsSelected = deletableResults.length > 0 && selectedResultIds.length === deletableResults.length;

  const toggleResultSelected = (id: string) => {
    setSelectedResultIds((prev) => (prev.includes(id) ? prev.filter((item) => item !== id) : [...prev, id]));
  };
  const toggleSelectAllResults = () => {
    setSelectedResultIds(allResultsSelected ? [] : deletableResults.map((result) => result.id));
  };
  const exitResultSelectMode = () => {
    setResultSelectMode(false);
    setSelectedResultIds([]);
  };

  // 真正执行删除：把选中结果对应的 storageKey 从当前记录的 thumbnails 里剔除，重算 count/success/status 后整条 upsert。
  // 后端 SaveGeneration 会对被移除且无人引用的图片做孤儿清理。删空（无产物也无失败槽）则直接删整条记录。
  const performDeleteResults = async (ids: string[]) => {
    if (!previewLog || running) return;
    const idSet = new Set(ids);
    const removedKeys = results.filter((result) => idSet.has(result.id)).map(resultStorageKey).filter(Boolean);
    if (!removedKeys.length) return;
    const remaining = results.filter((result) => !idSet.has(result.id));
    const newThumbnails = previewLog.thumbnails.filter((key) => !removedKeys.includes(key));
    const failCount = previewLog.failCount || 0;
    const newSuccessCount = newThumbnails.length;
    const newCount = newSuccessCount + failCount;
    try {
      if (newCount === 0) {
        // 没有任何产物 / 失败槽了 → 整条记录已无意义，直接删掉回到空白工作台。
        await deleteLogMutation.mutateAsync(previewLog.id);
        setPreviewLog(null);
        setResults([]);
        autoPreviewedIdRef.current = null;
        router.replace("/image");
      } else {
        const newStatus: GenerationRecord["status"] = newSuccessCount === 0 ? "failed" : failCount === 0 ? "success" : "partial";
        const saved = await saveLogMutation.mutateAsync({
          ...previewLog,
          thumbnails: newThumbnails,
          successCount: newSuccessCount,
          failCount,
          count: newCount,
          status: newStatus,
        });
        setPreviewLog(saved);
        setResults(remaining);
      }
      exitResultSelectMode();
      message.success(removedKeys.length > 1 ? `已删除 ${removedKeys.length} 张` : "已删除");
    } catch {
      // saveLogMutation / deleteLogMutation 自带错误提示
    }
  };

  const confirmDeleteSingleResult = (result: GenerationResult) => {
    modal.confirm({
      title: "删除这张生成结果",
      content: "确定删除这张图片吗？图片资源会一并删除（仍被别处引用的，比如已加入素材库 / 画布的，会保留）。",
      okText: "删除",
      okButtonProps: { danger: true },
      cancelText: "取消",
      onOk: () => performDeleteResults([result.id]),
    });
  };
  const confirmDeleteSelectedResults = () => {
    if (!selectedResultIds.length) return;
    modal.confirm({
      title: `删除选中的 ${selectedResultIds.length} 张生成结果`,
      content: "确定删除选中的图片吗？图片资源会一并删除（仍被别处引用的会保留）。",
      okText: "删除",
      okButtonProps: { danger: true },
      cancelText: "取消",
      onOk: () => performDeleteResults(selectedResultIds),
    });
  };
  const confirmDeleteAllResults = () => {
    const ids = deletableResults.map((result) => result.id);
    if (!ids.length) return;
    modal.confirm({
      title: "删除全部生成结果",
      content: `确定删除当前记录的全部 ${ids.length} 张生成结果吗？图片资源会一并删除（仍被别处引用的会保留）。`,
      okText: "全部删除",
      okButtonProps: { danger: true },
      cancelText: "取消",
      onOk: () => performDeleteResults(ids),
    });
  };

  // 把一条记录映射成右侧「生成结果」卡片数组：
  //  - thumbnails 逐张解析 → 成功卡（本地缓存找不到也能用 /api/images 直链；极端情况显示「缓存丢失」）
  //  - errors 每条 → 失败卡（带后端给的中文错误）
  //  - 还差的张数 = count - 成功 - 失败：running 时显示「生成中」转圈占位；非 running 兜底当失败。
  const deriveResultsFromRecord = async (log: GenerationRecord): Promise<GenerationResult[]> => {
    const resolved = await Promise.all((log.thumbnails || []).map(async (storageKey, index) => {
      const url = await resolveImageUrl(storageKey, "");
      if (!url) return { kind: "missing" as const, storageKey, index };
      try {
        const meta = await readImageMeta(url);
        return { kind: "success" as const, image: { id: `${log.id}-${index}`, dataUrl: url, storageKey, durationMs: log.durationMs, width: meta.width, height: meta.height, bytes: 0 }, index };
      } catch {
        return { kind: "success" as const, image: { id: `${log.id}-${index}`, dataUrl: url, storageKey, durationMs: log.durationMs, width: 0, height: 0, bytes: 0 }, index };
      }
    }));
    const successResults: GenerationResult[] = resolved
      .filter((item): item is Extract<typeof item, { kind: "success" }> => item.kind === "success")
      .map((item) => ({ id: item.image.id, status: "success", image: item.image, storageKey: item.image.storageKey }));
    const missingResults: GenerationResult[] = resolved
      .filter((item): item is Extract<typeof item, { kind: "missing" }> => item.kind === "missing")
      .map((item) => ({ id: `${log.id}-missing-${item.index}`, status: "missing", error: "本地图片缓存丢失", storageKey: item.storageKey }));
    const failedResults: GenerationResult[] = (log.errors || []).map((err, index) => ({
      id: `${log.id}-fail-${index}`,
      status: "failed",
      error: err || "生成失败",
    }));
    const accounted = successResults.length + missingResults.length + failedResults.length;
    const pendingCount = Math.max(0, (log.count || 0) - accounted);
    const pendingResults: GenerationResult[] = Array.from({ length: pendingCount }, (_, index) => (
      log.status === "running"
        ? { id: `${log.id}-pending-${index}`, status: "pending" }
        : { id: `${log.id}-fail-extra-${index}`, status: "failed", error: "生成失败" }
    ));
    return [...successResults, ...missingResults, ...failedResults, ...pendingResults];
  };

  const previewGenerationLog = async (log: GenerationRecord, options: { skipNavigate?: boolean } = {}) => {
    setPreviewLog(log);
    // 同步标记「现在选中的是这条」——后面异步写入前用它把关，防止快切串台。
    currentPreviewIdRef.current = log.id;
    setLogsOpen(false);
    // 切换查看的记录时退出产物多选态，避免选中项跨记录串台。
    setResultSelectMode(false);
    setSelectedResultIds([]);

    // 仅在「正在发起 /run 请求」的极短窗口里跳过回填，避免和 generate() 的状态写入打架。
    // 后端任务化后，记录本身就是真相——即便切回正在生成的记录，也应照常按记录回填表单 + 派生结果
    // （所以不再用旧的 isOwnActiveLog 守卫把整段跳过，否则切回去右侧结果就不刷新了）。
    if (isGeneratingRef.current) {
      if (!options.skipNavigate) {
        autoPreviewedIdRef.current = log.id;
        router.replace(`/image/${log.id}`);
      }
      return;
    }

    // 回填这条记录的工作台参数（同步，始终用最后一次选择的，不会被异步覆盖）。
    setPrompt(log.prompt);
    updateConfig("count", String(log.count || 1));
    if (log.size) updateConfig("size", log.size);
    if (log.quality) updateConfig("quality", log.quality);

    // 异步部分：参考图 + 结果都要等图片 resolve；完成后必须复核「现在选中的还是这条」才落地。
    const restored = log.references?.length
      ? (await Promise.all(log.references.map(async (storageKey, index) => ({
          id: `${log.id}-ref-${index}`,
          name: `ref-${index + 1}`,
          type: "image/*",
          dataUrl: await resolveImageUrl(storageKey, ""),
          storageKey,
        } as ReferenceImage)))).filter((ref) => ref.dataUrl)
      : [];
    const derived = await deriveResultsFromRecord(log);
    if (currentPreviewIdRef.current === log.id) {
      setReferences(restored);
      setResults(derived);
    }

    if (!options.skipNavigate) {
      autoPreviewedIdRef.current = log.id;
      router.replace(`/image/${log.id}`);
    }
  };

  const buildRequestSnapshot = () => {
    const text = prompt.trim();
    if (!text) {
      message.error("请输入生图提示词");
      return null;
    }
    if (!token) {
      message.error("请先登录");
      return null;
    }
    return { text, config: { ...config, count: "1" }, references: [...references] };
  };

  // 重试：让后端删一条失败 error、置 running、后台补跑一张。前端拿回更新后的记录 + 开始轮询。
  const retryResult = async () => {
    if (!previewLog || !token) return;
    try {
      const record = await retryGeneration(token, previewLog.id);
      upsertLogCache(record);
      setPreviewLog(record);
      setResults(await deriveResultsFromRecord(record));
      void queryClient.invalidateQueries({ queryKey: ["my-generations"] });
    } catch (error) {
      message.error(error instanceof Error ? error.message : "重试失败");
    }
  };

  return (
    <div className="flex h-full flex-col overflow-hidden bg-stone-50 text-stone-900 dark:bg-stone-950 dark:text-stone-100">
      <main className={`grid min-h-0 flex-1 grid-cols-1 gap-3 overflow-y-auto p-3 transition-[grid-template-columns] duration-300 ease-in-out lg:overflow-hidden ${leftPanelCollapsed ? "lg:grid-cols-[44px_minmax(0,1fr)]" : "lg:grid-cols-[300px_minmax(0,1fr)] xl:grid-cols-[320px_minmax(0,1fr)]"}`}>
        <aside className={`thin-scrollbar hidden min-h-0 overflow-y-auto rounded-lg border border-stone-200 bg-card shadow-sm transition-[padding] duration-300 ease-in-out dark:border-stone-800 lg:flex lg:flex-col ${leftPanelCollapsed ? "items-center p-2" : "p-4"}`}>
          {leftPanelCollapsed ? (
            <button
              type="button"
              className="grid size-8 place-items-center rounded-md text-stone-500 transition hover:bg-stone-100 hover:text-stone-900 dark:hover:bg-stone-800 dark:hover:text-stone-100"
              onClick={() => setLeftPanelCollapsed(false)}
              title="展开生成记录"
              aria-label="展开生成记录"
            >
              <PanelLeftOpen className="size-4" />
            </button>
          ) : (
            <LogPanel
              logs={logs}
              selectedLogIds={selectedLogIds}
              activeLogId={previewLog?.id}
              onSelectedLogIdsChange={setSelectedLogIds}
              onCreateSession={createSession}
              onDeleteSelected={() => setDeleteConfirmOpen(true)}
              onPreviewLog={(log) => void previewGenerationLog(log)}
              onCollapse={() => setLeftPanelCollapsed(true)}
            />
          )}
        </aside>

        <section className="grid gap-3 lg:min-h-0 lg:overflow-hidden xl:grid-cols-[420px_minmax(0,1fr)]">
          <div className="thin-scrollbar flex flex-col rounded-lg border border-stone-200 bg-card p-4 shadow-sm dark:border-stone-800 lg:min-h-0 lg:overflow-y-auto">
              <div>
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <h1 className="text-2xl font-semibold text-stone-950 dark:text-stone-100">生图工作台</h1>
                  </div>
                  <div className="flex shrink-0 gap-2 lg:hidden">
                    <Button icon={<History className="size-4" />} onClick={() => setLogsOpen(true)}>记录</Button>
                    <Button icon={<SlidersHorizontal className="size-4" />} onClick={() => setSettingsOpen(true)}>参数</Button>
                  </div>
                </div>
              </div>

              <div className="mt-6 space-y-5">
                <div>
                  <div className="mb-2 flex items-center justify-between gap-3">
                    <span className="text-base font-semibold">提示词</span>
                    <div className="flex gap-2">
                      <Button size="small" icon={<BookOpen className="size-3.5" />} onClick={() => setPromptDialogOpen(true)}>查看提示词库</Button>
                      <Button size="small" icon={<FolderPlus className="size-3.5" />} onClick={() => setAssetPickerOpen(true)}>查看我的素材</Button>
                    </div>
                  </div>
                  <Input.TextArea
                    value={prompt}
                    onChange={(event) => setPrompt(event.target.value)}
                    onPaste={handlePromptPaste}
                    onKeyDown={(event) => {
                      // 回车直接触发「开始生成」，Shift+Enter 走默认换行。
                      // 注意：中文输入法候选阶段也会触发 keydown，nativeEvent.isComposing
                      // 为 true 时必须放行，否则会把"敲回车确认候选词"误判成提交。
                      // Ctrl/Meta/Alt 组合也跳过，避免覆盖系统级快捷键。
                      if (event.key !== "Enter" || event.shiftKey) return;
                      if (event.nativeEvent.isComposing || event.ctrlKey || event.metaKey || event.altKey) return;
                      event.preventDefault();
                      if (!canGenerate || running) return;
                      void generate();
                    }}
                    onDragOver={handleDragOver}
                    onDragLeave={handleDragLeave}
                    onDrop={handleDropFiles}
                    rows={7}
                    placeholder="描述画面主体、风格、构图、光线和用途；也可在这里粘贴或拖入图片直接作为参考图。Enter 直接生成，Shift+Enter 换行"
                  />
                  <div className="mt-1 text-xs text-stone-500 dark:text-stone-400">
                    按 Enter 直接开始生成，Shift + Enter 换行
                  </div>
                  <PromptImproveBar
                    className="mt-2"
                    getPrompt={() => prompt}
                    onAccept={setPrompt}
                    disabled={running}
                  />
                </div>

                <div className="min-w-0">
                  <div className="mb-2 flex items-center justify-between gap-3">
                    <span className="text-base font-semibold">参考图</span>
                    <div className="flex gap-2">
                      <Button size="small" icon={<ClipboardPaste className="size-3.5" />} onClick={() => void addReferencesFromClipboard()}>剪切板</Button>
                      <Button size="small" icon={<Upload className="size-3.5" />} onClick={() => fileInputRef.current?.click()}>上传</Button>
                    </div>
                  </div>
                  <div
                    className={`hover-scrollbar hover-scrollbar-hint relative flex min-h-24 w-full min-w-0 max-w-full gap-2 overflow-x-scroll overflow-y-hidden rounded-lg border border-dashed p-2 pb-3 overscroll-x-contain transition-colors ${dragHighlight ? "border-blue-500 bg-blue-50/40 dark:border-blue-400 dark:bg-blue-500/10" : "border-stone-300 dark:border-stone-700"}`}
                    onDragOver={handleDragOver}
                    onDragLeave={handleDragLeave}
                    onDrop={handleDropFiles}
                    onWheel={(event) => {
                      if (event.currentTarget.scrollWidth <= event.currentTarget.clientWidth) return;
                      event.preventDefault();
                      event.currentTarget.scrollLeft += event.deltaY;
                    }}
                  >
                    {references.length ? (
                      <DndContext sensors={referenceSensors} collisionDetection={closestCenter} onDragEnd={handleReferenceReorder}>
                        <SortableContext items={references.map((ref) => ref.id)} strategy={horizontalListSortingStrategy}>
                          {/* 包一层 PreviewGroup，参考图打开预览后可左右切换浏览全部 */}
                          <Image.PreviewGroup>
                            {references.map((item) => (
                              <SortableReferenceThumb
                                key={item.id}
                                item={item}
                                onRemove={() => setReferences((value) => value.filter((ref) => ref.id !== item.id))}
                              />
                            ))}
                          </Image.PreviewGroup>
                        </SortableContext>
                      </DndContext>
                    ) : (
                      <div className="flex min-w-full items-center justify-center text-sm text-stone-500">{dragHighlight ? "松开以添加参考图" : "暂无参考图，可粘贴 / 拖入 / 点击上方按钮添加"}</div>
                    )}
                    {dragHighlight && references.length ? (
                      <div className="pointer-events-none absolute inset-0 flex items-center justify-center rounded-lg bg-blue-500/5 text-sm font-medium text-blue-600 dark:text-blue-300">松开以添加参考图</div>
                    ) : null}
                  </div>
                </div>

                <div className="flex items-center justify-between rounded-lg border border-stone-200 bg-stone-50 px-3 py-2 text-sm dark:border-stone-800 dark:bg-stone-900 sm:hidden">
                  <span className="truncate text-stone-500 dark:text-stone-400">{config.size} · {config.quality}</span>
                  <Button size="small" type="text" icon={<SlidersHorizontal className="size-4" />} onClick={() => setSettingsOpen(true)}>调整</Button>
                </div>

                <div className="hidden gap-4 sm:grid sm:grid-cols-2">
                  <GenerationSettings config={config} updateConfig={updateConfig} />
                </div>
              </div>

              <div className="mt-auto pt-6">
                <Button type="primary" size="large" block icon={<Sparkles className="size-4" />} loading={running} disabled={!canGenerate || running} onClick={() => void generate()}>
                  开始生成
                </Button>
              </div>
            </div>

          <div className="thin-scrollbar rounded-lg border border-stone-200 bg-card p-4 shadow-sm dark:border-stone-800 lg:min-h-0 lg:overflow-y-auto lg:p-5">
              <div className="mb-4 flex items-center justify-between gap-3">
                <div className="flex items-center gap-3">
                  <h2 className="text-xl font-semibold">生成结果</h2>
                  {previewLog?.parentId ? (
                    <Button size="small" type="link" className="!h-7 !px-2" onClick={() => router.push(`/image/${previewLog.parentId}`)} icon={<Sparkles className="size-3.5" />}>来自微调</Button>
                  ) : null}
                </div>
                <div className="flex flex-wrap items-center justify-end gap-2">
                  {resultSelectMode ? (
                    <>
                      <span className="text-xs text-stone-500 dark:text-stone-400">已选 {selectedResultIds.length} / {deletableResults.length}</span>
                      <Button size="small" onClick={toggleSelectAllResults}>{allResultsSelected ? "取消全选" : "全选"}</Button>
                      <Button size="small" danger icon={<Trash2 className="size-3.5" />} disabled={!selectedResultIds.length} onClick={confirmDeleteSelectedResults}>删除选中</Button>
                      <Button size="small" danger onClick={confirmDeleteAllResults}>删除全部</Button>
                      <Button size="small" type="text" onClick={exitResultSelectMode}>完成</Button>
                    </>
                  ) : (
                    <>
                      {previewLog && previewLog.thumbnails.length > 0 ? (
                        <Button size="small" icon={<BookOpen className="size-3.5" />} onClick={() => setSubmitPromptOpen(true)}>加入提示词库</Button>
                      ) : null}
                      {!running && deletableResults.length > 0 ? (
                        <Button size="small" icon={<CheckSquare className="size-3.5" />} onClick={() => setResultSelectMode(true)}>选择删除</Button>
                      ) : null}
                      {running ? <Tag color="blue" className="m-0 px-2 py-1">生成中{elapsedMs ? ` ${formatDuration(elapsedMs)}` : "…"}</Tag> : null}
                    </>
                  )}
                </div>
              </div>
              {results.length ? (
                <div className="grid gap-4 sm:grid-cols-2 2xl:grid-cols-3">
                  {results.map((result, index) => (
                    result.status === "success" && result.image ? (
                      <ResultImageCard key={result.id} image={result.image} index={index} onEdit={addResultToReferences} onDownload={downloadImage} onSaveAsset={saveResultToAssets} onRefine={previewLog ? refineResult : undefined} selectMode={resultSelectMode} selected={selectedResultIds.includes(result.id)} onToggleSelect={() => toggleResultSelected(result.id)} onDelete={running ? undefined : () => confirmDeleteSingleResult(result)} />
                    ) : result.status === "missing" ? (
                      <MissingImageCard key={result.id} selectMode={resultSelectMode} selected={selectedResultIds.includes(result.id)} onToggleSelect={() => toggleResultSelected(result.id)} onDelete={running ? undefined : () => confirmDeleteSingleResult(result)} />
                    ) : result.status === "failed" ? (
                      <FailedImageCard key={result.id} error={result.error || "生成失败"} onRetry={running ? undefined : () => void retryResult()} />
                    ) : (
                      <PendingImageCard key={result.id} />
                    )
                  ))}
                </div>
              ) : (
                <div className="flex min-h-[320px] flex-col items-center justify-center rounded-lg border border-dashed border-stone-300 text-center dark:border-stone-700 lg:min-h-[560px]">
                  <ImagePlus className="mb-4 size-11 text-stone-400" />
                  <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="还没有生成图片" />
                </div>
              )}
          </div>
        </section>
      </main>
      <input ref={fileInputRef} type="file" accept="image/*" multiple className="hidden" onChange={(event) => {
        void addReferences(event.target.files);
        event.target.value = "";
      }} />
      <Drawer title="生成记录" placement="bottom" size="large" open={logsOpen} onClose={() => setLogsOpen(false)}>
        <LogPanel logs={logs} selectedLogIds={selectedLogIds} activeLogId={previewLog?.id} onSelectedLogIdsChange={setSelectedLogIds} onCreateSession={createSession} onDeleteSelected={() => setDeleteConfirmOpen(true)} onPreviewLog={(log) => void previewGenerationLog(log)} />
      </Drawer>
      <Drawer title="参数" placement="bottom" size="default" open={settingsOpen} onClose={() => setSettingsOpen(false)}>
        <div className="grid grid-cols-2 gap-3">
          <GenerationSettings config={config} updateConfig={updateConfig} />
        </div>
      </Drawer>
      <PromptSelectDialog open={promptDialogOpen} onOpenChange={setPromptDialogOpen} onSelect={setPrompt} />
      <SubmitPromptModal
        open={submitPromptOpen}
        onClose={() => setSubmitPromptOpen(false)}
        defaultPrompt={previewLog?.prompt || prompt}
        imageOptions={previewLog?.thumbnails || []}
      />
      <AssetPickerModal open={assetPickerOpen} defaultTab="my-assets" onInsert={(payload) => void insertPickedAsset(payload)} onClose={() => setAssetPickerOpen(false)} />
      <Modal title="删除生成记录" open={deleteConfirmOpen} onCancel={() => !deletingLogs && setDeleteConfirmOpen(false)} onOk={() => void deleteSelectedLogs()} okText="删除" okButtonProps={{ danger: true, loading: deletingLogs }} cancelText="取消" cancelButtonProps={{ disabled: deletingLogs }} maskClosable={!deletingLogs} closable={!deletingLogs}>
        确定删除选中的 {selectedLogIds.length} 条生成记录吗？关联的图片资源也会一并删除（仍被别处引用的会保留）。
      </Modal>
    </div>
  );
}

// SortableReferenceThumb 一张参考图缩略图，整张可拖动重排（dnd-kit），
// 同时**点击图片**会打开 antd 预览浮层（外层 Image.PreviewGroup 提供左右切换）。
//   - 触发距离 6px 才识别为拖动，避免点 × 删除 / 点图预览时误触；
//   - X 按钮的 pointerdown / click 都 stopPropagation，drag 不抢手势、也不会触发预览；
//   - <Image draggable={false}> 阻止浏览器原生「把图片拖到地址栏 / 另存为」的副作用，
//     否则会和 dnd-kit 的 pointer 拖动起冲突，鼠标按下立刻变成"拖图标"。
function SortableReferenceThumb({ item, onRemove }: { item: ReferenceImage; onRemove: () => void }) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: item.id });
  const style: React.CSSProperties = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.5 : 1,
    zIndex: isDragging ? 10 : undefined,
  };
  return (
    <div
      ref={setNodeRef}
      style={style}
      {...attributes}
      {...listeners}
      className="group relative size-20 shrink-0 cursor-grab touch-none select-none overflow-hidden rounded-md border border-stone-200 active:cursor-grabbing dark:border-stone-800"
      title="点击放大查看，按住拖动调整顺序"
    >
      <Image
        src={item.dataUrl}
        alt={item.name}
        width={80}
        height={80}
        className="!size-20 object-cover"
        rootClassName="!block !size-20"
        preview={{ mask: "放大查看" }}
        draggable={false}
      />
      <button
        type="button"
        className="absolute right-1 top-1 z-10 hidden size-6 items-center justify-center rounded bg-black/60 text-white group-hover:flex"
        onPointerDown={(event) => event.stopPropagation()}
        onClick={(event) => {
          event.stopPropagation();
          onRemove();
        }}
        aria-label="移除参考图"
      >
        <Trash2 className="size-3.5" />
      </button>
    </div>
  );
}

function GenerationSettings({ config, updateConfig }: { config: AiConfig; updateConfig: UpdateAiConfig }) {
  return (
    <>
      <label className="block">
        <span className="mb-1.5 block text-sm font-semibold sm:mb-2 sm:text-base">生成次数</span>
        <InputNumber className="canvas-control-number !w-full" min={1} max={10} value={Number(config.count) || 1} onChange={(value) => updateConfig("count", String(value || 1))} />
      </label>
      <label className="block">
        <span className="mb-1.5 block text-sm font-semibold sm:mb-2 sm:text-base">尺寸</span>
        <AutoComplete className="canvas-control-select w-full" value={config.size} options={sizeOptions} placeholder="例如 1:1、3:2" onChange={(value) => updateConfig("size", value)} />
      </label>
      <label className="block">
        <span className="mb-1.5 block text-sm font-semibold sm:mb-2 sm:text-base">质量</span>
        <Select className="canvas-control-select w-full" value={config.quality} options={qualityOptions} onChange={(value) => updateConfig("quality", value)} />
      </label>
    </>
  );
}

function ResultImageCard({ image, index, onEdit, onDownload, onSaveAsset, onRefine, selectMode, selected, onToggleSelect, onDelete }: { image: GeneratedImage; index: number; onEdit: (image: GeneratedImage, index: number) => void; onDownload: (image: GeneratedImage, index: number) => void; onSaveAsset: (image: GeneratedImage, index: number) => void; onRefine?: (image: GeneratedImage) => void; selectMode?: boolean; selected?: boolean; onToggleSelect?: () => void; onDelete?: () => void }) {
  return (
    <div className={`overflow-hidden rounded-lg border bg-background transition-colors dark:bg-background ${selected ? "border-blue-500 ring-1 ring-blue-500 dark:border-blue-400" : "border-stone-200 dark:border-stone-800"}`}>
      {/* 桌面端：图片 hover 才显示按钮浮层；移动端：始终显示（lg:opacity-0 控制只让 lg+ 默认隐藏） */}
      <div className="group relative">
        <Image src={image.dataUrl} alt={`生成结果 ${index + 1}`} className="aspect-square object-cover" preview={selectMode ? false : undefined} />
        {/* 多选模式：整张图盖一层点击切换选中 + 左上角勾选框 */}
        {selectMode ? (
          <button type="button" onClick={onToggleSelect} className="absolute inset-0 z-10 cursor-pointer bg-black/0 transition-colors hover:bg-black/10" aria-label={selected ? "取消选中" : "选中"}>
            <span className="absolute left-2 top-2"><Checkbox checked={selected} /></span>
          </button>
        ) : (
          <div className="pointer-events-none absolute inset-x-0 bottom-0 flex flex-wrap items-end justify-end gap-1.5 bg-gradient-to-t from-black/70 via-black/35 to-transparent p-2 opacity-100 transition-opacity duration-150 lg:opacity-0 lg:group-hover:opacity-100">
            <div className="pointer-events-auto flex flex-wrap justify-end gap-1">
              {onRefine ? <Button size="small" type="primary" icon={<Sparkles className="size-3.5" />} onClick={() => onRefine(image)}>AI 微调</Button> : null}
              <Button size="small" icon={<FolderPlus className="size-3.5" />} onClick={() => void onSaveAsset(image, index)}>素材</Button>
              <Button size="small" icon={<PenLine className="size-3.5" />} onClick={() => void onEdit(image, index)}>参考图</Button>
              <Button size="small" icon={<Download className="size-3.5" />} onClick={() => onDownload(image, index)}>下载</Button>
              {onDelete ? <Button size="small" danger icon={<Trash2 className="size-3.5" />} onClick={onDelete}>删除</Button> : null}
            </div>
          </div>
        )}
      </div>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 border-t border-stone-200 px-3 py-2 text-xs text-stone-500 dark:border-stone-800 dark:text-stone-400">
        {image.width && image.height ? <span>{image.width}x{image.height}</span> : null}
        {image.bytes ? <span>{formatBytes(image.bytes)}</span> : null}
        {image.durationMs ? <span>{formatDuration(image.durationMs)}</span> : null}
      </div>
    </div>
  );
}

function PendingImageCard() {
  return (
    <div className="relative aspect-square overflow-hidden rounded-lg border border-dashed border-stone-300 bg-stone-50 dark:border-stone-700 dark:bg-stone-900">
      <div
        className="absolute inset-0 opacity-60"
        style={{
          backgroundImage: "radial-gradient(circle, rgba(120,113,108,0.35) 1.4px, transparent 1.6px)",
          backgroundSize: "16px 16px",
        }}
      />
      <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 text-sm text-stone-500 dark:text-stone-400">
        <LoaderCircle className="size-6 animate-spin" />
        <span>生成中</span>
      </div>
    </div>
  );
}

function FailedImageCard({ error, onRetry }: { error: string; onRetry?: () => void }) {
  return (
    <div className="overflow-hidden rounded-lg border border-red-200 bg-red-50 dark:border-red-950 dark:bg-red-950/20">
      <div className="flex aspect-square flex-col items-center justify-center gap-3 p-5 text-center">
        <div className="text-sm font-medium text-red-600 dark:text-red-300">生成失败</div>
        <Typography.Paragraph ellipsis={{ rows: 4 }} className="!mb-0 !text-xs !text-red-500 dark:!text-red-300">
          {error}
        </Typography.Paragraph>
      </div>
      {/* 生成进行中时不给「重试」入口（onRetry 为空），避免和正在跑的后台任务打架 */}
      {onRetry ? (
        <div className="flex justify-end border-t border-red-200 p-3 dark:border-red-950">
          <Button size="small" danger onClick={onRetry}>重试</Button>
        </div>
      ) : null}
    </div>
  );
}

function MissingImageCard({ selectMode, selected, onToggleSelect, onDelete }: { selectMode?: boolean; selected?: boolean; onToggleSelect?: () => void; onDelete?: () => void } = {}) {
  // 与"生成失败"区分开：这条记录原本生成成功了，只是图片 Blob 没存在当前浏览器里。
  return (
    <div className={`relative overflow-hidden rounded-lg border bg-amber-50 transition-colors dark:bg-amber-950/20 ${selected ? "border-blue-500 ring-1 ring-blue-500 dark:border-blue-400" : "border-amber-200 dark:border-amber-900"}`}>
      <div className="flex aspect-square flex-col items-center justify-center gap-3 p-5 text-center">
        <ImageOff className="size-7 text-amber-500" />
        <div className="text-sm font-medium text-amber-700 dark:text-amber-300">图片缓存丢失</div>
        <Typography.Paragraph ellipsis={{ rows: 4 }} className="!mb-0 !text-xs !text-amber-600 dark:!text-amber-300">
          这张图原本生成成功，但当前浏览器的本地缓存里找不到它（多发生在换浏览器、清缓存、隐身模式时）。原图无法找回，仍可看到提示词和参数。
        </Typography.Paragraph>
      </div>
      {selectMode ? (
        <button type="button" onClick={onToggleSelect} className="absolute inset-0 z-10 cursor-pointer bg-black/0 transition-colors hover:bg-black/5" aria-label={selected ? "取消选中" : "选中"}>
          <span className="absolute left-2 top-2"><Checkbox checked={selected} /></span>
        </button>
      ) : onDelete ? (
        <div className="absolute right-2 top-2">
          <Button size="small" danger icon={<Trash2 className="size-3.5" />} onClick={onDelete}>删除</Button>
        </div>
      ) : null}
    </div>
  );
}

function LogPanel({ logs, selectedLogIds, activeLogId, onSelectedLogIdsChange, onCreateSession, onDeleteSelected, onPreviewLog, onCollapse }: { logs: GenerationRecord[]; selectedLogIds: string[]; activeLogId?: string; onSelectedLogIdsChange: (ids: string[]) => void; onCreateSession: () => void; onDeleteSelected: () => void; onPreviewLog: (log: GenerationRecord) => void; onCollapse?: () => void }) {
  const allSelected = Boolean(logs.length) && selectedLogIds.length === logs.length;
  const toggleAll = () => onSelectedLogIdsChange(allSelected ? [] : logs.map((log) => log.id));

  return (
    <>
      <div className="mb-3 flex items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <h2 className="text-base font-semibold">生成记录</h2>
          <Tag className="m-0">{logs.length}</Tag>
        </div>
        {onCollapse ? (
          <button
            type="button"
            className="grid size-7 place-items-center rounded-md text-stone-500 transition hover:bg-stone-100 hover:text-stone-900 dark:hover:bg-stone-800 dark:hover:text-stone-100"
            onClick={onCollapse}
            title="收起生成记录"
            aria-label="收起生成记录"
          >
            <PanelLeftClose className="size-4" />
          </button>
        ) : null}
      </div>
      <div className="mb-4 flex flex-wrap gap-2">
        <Button size="small" icon={<Plus className="size-3.5" />} onClick={onCreateSession}>新建</Button>
        <Button size="small" icon={<CheckSquare className="size-3.5" />} disabled={!logs.length} onClick={toggleAll}>{allSelected ? "取消" : "全选"}</Button>
        <Button size="small" danger icon={<Trash2 className="size-3.5" />} disabled={!selectedLogIds.length} onClick={onDeleteSelected}>删除</Button>
      </div>
      <div className="space-y-3">
        {logs.map((log) => (
          <LogCard
            key={log.id}
            log={log}
            selected={selectedLogIds.includes(log.id)}
            active={activeLogId === log.id}
            onSelectedChange={(checked) => onSelectedLogIdsChange(checked ? [...selectedLogIds, log.id] : selectedLogIds.filter((id) => id !== log.id))}
            onClick={() => onPreviewLog(log)}
          />
        ))}
        {!logs.length ? (
          <div className="flex min-h-48 items-center justify-center rounded-lg border border-dashed border-stone-300 text-center text-sm text-stone-500 dark:border-stone-700">
            暂无生成记录
          </div>
        ) : null}
      </div>
    </>
  );
}

function LogCard({ log, selected, active, onSelectedChange, onClick }: { log: GenerationRecord; selected: boolean; active: boolean; onSelectedChange: (checked: boolean) => void; onClick: () => void }) {
  const title = log.prompt?.slice(0, 24) || "未命名";
  const time = useMemo(() => log.createdAt ? new Date(log.createdAt).toLocaleString("zh-CN", { hour12: false }) : "", [log.createdAt]);
  const [thumbUrls, setThumbUrls] = useState<string[]>([]);

  useEffect(() => {
    let cancelled = false;
    void Promise.all((log.thumbnails || []).slice(0, 4).map((key) => resolveImageUrl(key, "")))
      .then((urls) => {
        if (!cancelled) setThumbUrls(urls.filter(Boolean));
      });
    return () => {
      cancelled = true;
    };
  }, [log.thumbnails]);

  return (
    <button type="button" className={`block w-full rounded-lg border p-2 text-left transition ${active ? "border-stone-900 bg-blue-50 dark:border-stone-100 dark:bg-blue-950/20" : "border-stone-200 bg-background hover:bg-stone-50 dark:border-stone-800 dark:hover:bg-stone-900"}`} onClick={onClick}>
      <div className="grid grid-cols-[minmax(128px,1fr)_auto] gap-2">
        <div className="grid min-w-0 grid-cols-[auto_minmax(0,1fr)] items-start gap-2">
          <Checkbox className="mt-0.5" checked={selected} onClick={(event) => event.stopPropagation()} onChange={(event) => onSelectedChange(event.target.checked)} />
          <div className="min-w-0">
            <div className="truncate text-sm font-semibold leading-5">{title}</div>
            {thumbUrls.length ? (
              <div className="mt-2 flex gap-1 overflow-hidden">
                {thumbUrls.map((image, index) => <img key={`${log.id}-${index}`} src={image} alt="" className="size-8 shrink-0 rounded-md object-cover" />)}
              </div>
            ) : null}
          </div>
        </div>
        <div className="grid justify-items-end gap-2">
          <div className="flex gap-1">
            {log.status === "running" ? (
              <Tag className="m-0 flex h-6 items-center rounded-md px-1.5 text-xs leading-none" color="gold">进行中</Tag>
            ) : (
              <>
                <Tag className="m-0 flex h-6 items-center rounded-md px-1.5 text-xs leading-none" color="blue">成功 {log.successCount}</Tag>
                {log.failCount ? <Tag className="m-0 flex h-6 items-center rounded-md px-1.5 text-xs leading-none" color="red">失败 {log.failCount}</Tag> : null}
              </>
            )}
          </div>
          <div className="flex flex-wrap justify-end gap-1">
            <Tag className="m-0 flex h-6 items-center rounded-md px-1.5 text-xs leading-none">{log.count} 张</Tag>
            <Tag className="m-0 flex h-6 items-center rounded-md px-1.5 text-xs leading-none" color="green">{formatDuration(log.durationMs)}</Tag>
          </div>
          <div className="flex justify-end">
            <Tag className="m-0 flex h-6 items-center rounded-md px-1.5 text-xs leading-none">{time}</Tag>
          </div>
        </div>
      </div>
    </button>
  );
}
