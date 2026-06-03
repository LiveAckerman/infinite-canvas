"use client";

import { FolderCog, History, Layers, Plus, Search } from "lucide-react";
import { App, Button, Empty, Input, Modal, Tabs, Tag } from "antd";
import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNav } from "@/lib/use-nav";

import { RequireAuth } from "@/components/require-auth";
import { deleteMyAgent, fetchMyAgents, saveMyAgent, type Agent, type AgentListResponse } from "@/services/api/agents";
import {
  deleteMyAgentWorkstationCard,
  fetchMyAgentWorkstationCards,
  saveMyAgentWorkstationCard,
  type AgentWorkstationCard,
  type AgentWorkstationCardListResponse,
} from "@/services/api/agent-workstations";
import {
  deleteMyPipelineBatch,
  downloadPipelineBatchZip,
  fetchMyPipelineBatches,
  type PipelineBatchDetail,
  type PipelineBatchListResponse,
} from "@/services/api/pipeline-batches";
import { fetchMyPipelineBatchTemplates } from "@/services/api/pipeline-batch-templates";
import { fetchMyPipelines, type Pipeline } from "@/services/api/pipelines";
import {
  saveMyPipelineRun,
  type PipelineRun,
} from "@/services/api/pipeline-runs";
import { useUserStore } from "@/stores/use-user-store";

import { AgentEditModal, type AgentFormValues } from "./components/agent-edit-modal";
import { AgentLibraryCard } from "./components/agent-library-card";
import { AgentRecordsDrawer } from "./components/agent-records-drawer";
import { AgentWorkstation, type WorkstationCardPatch } from "./components/agent-workstation";
import { BatchCard } from "./components/batch-card";
import { BatchCreateModal } from "./components/batch-create-modal";
import { BatchFromTemplateModal } from "./components/batch-from-template-modal";
import { BatchTemplateManagerModal, BATCH_TEMPLATES_QUERY_KEY } from "./components/batch-template-manager-modal";
import { PipelineMode } from "./components/pipeline-mode";

// 「并行 / 流水线 / 批量任务」模式偏好，localStorage 持久化（轻量偏好不上云）。
const MODE_STORAGE_KEY = "infinite-canvas:agents:mode";
type WorkbenchMode = "parallel" | "pipeline" | "batch";
function loadMode(): WorkbenchMode {
  if (typeof window === "undefined") return "parallel";
  const v = window.localStorage.getItem(MODE_STORAGE_KEY);
  if (v === "pipeline") return "pipeline";
  if (v === "batch") return "batch";
  return "parallel";
}

const WORKSTATION_CARDS_QUERY_KEY = ["my-workstation-cards"] as const;

const AGENTS_QUERY_KEY = ["my-agents"] as const;
const PIPELINES_QUERY_KEY = ["my-pipelines"] as const;
const BATCHES_QUERY_KEY = ["my-pipeline-batches"] as const;

export default function AgentsPage() {
  return (
    <RequireAuth>
      <AgentsWorkbench />
    </RequireAuth>
  );
}

function AgentsWorkbench() {
  const { message, modal } = App.useApp();
  const queryClient = useQueryClient();
  const nav = useNav();
  const token = useUserStore((state) => state.token);
  const userId = useUserStore((state) => state.user?.id || "");
  const [keyword, setKeyword] = useState("");
  const [editing, setEditing] = useState<Agent | null>(null);
  const [editorOpen, setEditorOpen] = useState(false);
  const [deletingAgent, setDeletingAgent] = useState<Agent | null>(null);
  // 「生成记录」Drawer：开关 + 角色筛选 + 分页页码 + refreshKey（workstation 跑完一次 bump）。
  const [recordsOpen, setRecordsOpen] = useState(false);
  const [recordsAgentFilter, setRecordsAgentFilter] = useState<string>("");
  const [recordsPage, setRecordsPage] = useState(1);
  const [recordsRefreshKey, setRecordsRefreshKey] = useState(0);
  // 顶部模式：并行 / 流水线 / 批量任务。localStorage 持久化。
  const [mode, setMode] = useState<WorkbenchMode>(() => loadMode());
  useEffect(() => {
    if (typeof window === "undefined") return;
    window.localStorage.setItem(MODE_STORAGE_KEY, mode);
  }, [mode]);

  // 批量任务相关：3 个 Modal 开关 + 「全部启动」单条 loading 标识（用 batchId 标定）
  const [batchCreateOpen, setBatchCreateOpen] = useState(false);
  const [batchTemplateManagerOpen, setBatchTemplateManagerOpen] = useState(false);
  const [batchFromTemplateOpen, setBatchFromTemplateOpen] = useState(false);
  const [startingBatchId, setStartingBatchId] = useState<string>("");
  // 「下载 zip」按钮的 loading 锁定：记下正在下载的 batchId，避免用户连点重复打包
  const [downloadingBatchId, setDownloadingBatchId] = useState<string>("");

  const agentsQuery = useQuery({
    queryKey: AGENTS_QUERY_KEY,
    queryFn: () => fetchMyAgents(token),
    enabled: Boolean(token),
  });

  // 批处理模板列表：从模板创建 Modal 用，跟「批处理模板」管理 Modal 共享 cache。
  // 仅在 batch tab 激活时启用，减少 list 请求。
  const batchTemplatesQuery = useQuery({
    queryKey: BATCH_TEMPLATES_QUERY_KEY,
    queryFn: () => fetchMyPipelineBatchTemplates(token),
    enabled: Boolean(token) && mode === "batch",
  });
  const batchTemplates = batchTemplatesQuery.data?.items || [];

  const saveMutation = useMutation({
    mutationFn: (payload: Partial<Agent>) => saveMyAgent(token, payload),
    onSuccess: (saved) => {
      queryClient.setQueryData<AgentListResponse>(AGENTS_QUERY_KEY, (old) => {
        if (!old) return { items: [saved], total: 1 };
        const exists = old.items.some((item) => item.id === saved.id);
        if (exists) return { ...old, items: old.items.map((item) => (item.id === saved.id ? saved : item)) };
        return { ...old, items: [saved, ...old.items], total: old.total + 1 };
      });
    },
    onError: (error) => {
      message.error(error instanceof Error ? error.message : "保存失败");
    },
  });

  const deleteMutation = useMutation({
    mutationFn: (id: string) => deleteMyAgent(token, id),
    onSuccess: (_, id) => {
      queryClient.setQueryData<AgentListResponse>(AGENTS_QUERY_KEY, (old) => {
        if (!old) return old;
        return { ...old, items: old.items.filter((item) => item.id !== id), total: Math.max(0, old.total - 1) };
      });
      // 角色被删的时候顺手把工作区里引用它的卡也清掉（前端缓存层面）。
      // 后端那条记录会变成「孤儿卡」，但 list 接口里因为角色不存在 UI 显示不出名字，
      // 用户体验上等价于消失。后续重启 backend 时可以加个清理任务，但项目期不做。
      queryClient.setQueryData<AgentWorkstationCardListResponse>(WORKSTATION_CARDS_QUERY_KEY, (old) => {
        if (!old) return old;
        const items = old.items.filter((card) => card.agentId !== id);
        return { items, total: items.length };
      });
    },
    onError: (error) => {
      message.error(error instanceof Error ? error.message : "删除失败");
    },
  });

  // 工作区卡片 query：跨设备同步的来源。token 切换（登录 / 切账号）会自动 refetch 新账号的卡片。
  const cardsQuery = useQuery({
    queryKey: WORKSTATION_CARDS_QUERY_KEY,
    queryFn: () => fetchMyAgentWorkstationCards(token),
    enabled: Boolean(token),
  });

  // upsert：「加入工作区」「上传 reference」「写附加说明」「跑完成功 / 失败」「重置」都走这一个 POST。
  // 父层根据返回结果把新数据写进 query cache，AgentWorkstation 不重新 mount（不会丢内部正在跑的 state）。
  const persistCardMutation = useMutation({
    mutationFn: (card: Partial<AgentWorkstationCard>) => saveMyAgentWorkstationCard(token, card),
    onSuccess: (saved) => {
      queryClient.setQueryData<AgentWorkstationCardListResponse>(WORKSTATION_CARDS_QUERY_KEY, (old) => {
        if (!old) return { items: [saved], total: 1 };
        const exists = old.items.some((item) => item.id === saved.id || (item.agentId === saved.agentId && item.userId === saved.userId));
        if (exists) {
          return { ...old, items: old.items.map((item) => (item.id === saved.id || (item.agentId === saved.agentId && item.userId === saved.userId) ? saved : item)) };
        }
        return { ...old, items: [...old.items, saved], total: old.total + 1 };
      });
    },
    onError: (error) => {
      message.error(error instanceof Error ? error.message : "工作区状态保存失败");
    },
  });

  const deleteCardMutation = useMutation({
    mutationFn: (cardId: string) => deleteMyAgentWorkstationCard(token, cardId),
    onSuccess: (_, cardId) => {
      queryClient.setQueryData<AgentWorkstationCardListResponse>(WORKSTATION_CARDS_QUERY_KEY, (old) => {
        if (!old) return old;
        return { ...old, items: old.items.filter((item) => item.id !== cardId), total: Math.max(0, old.total - 1) };
      });
    },
    onError: (error) => {
      message.error(error instanceof Error ? error.message : "移出工作区失败");
    },
  });

  const agents = agentsQuery.data?.items || [];
  const filteredAgents = useMemo(() => {
    const key = keyword.trim().toLowerCase();
    if (!key) return agents;
    return agents.filter((agent) => (
      agent.name.toLowerCase().includes(key) ||
      agent.description.toLowerCase().includes(key) ||
      agent.systemPrompt.toLowerCase().includes(key)
    ));
  }, [agents, keyword]);

  const cards = cardsQuery.data?.items || [];
  const cardsByAgentId = useMemo(() => {
    const map = new Map<string, AgentWorkstationCard>();
    for (const card of cards) map.set(card.agentId, card);
    return map;
  }, [cards]);
  // 工作区角色列表 = 有 card 且角色仍存在的；按 position asc 排（跟后端 list 顺序对齐）。
  const workspaceAgents = useMemo(() => {
    return [...cards]
      .sort((a, b) => (a.position || 0) - (b.position || 0))
      .map((card) => agents.find((agent) => agent.id === card.agentId))
      .filter((agent): agent is Agent => Boolean(agent));
  }, [agents, cards]);
  const workspaceIds = useMemo(() => new Set(cards.map((card) => card.agentId)), [cards]);

  // 「加入工作区」：POST 一条新的卡片，position 取当前最大值 +1。
  const addToWorkspace = (agent: Agent) => {
    if (workspaceIds.has(agent.id)) return; // 已在工作区
    const maxPosition = cards.reduce((max, card) => Math.max(max, card.position || 0), 0);
    persistCardMutation.mutate({ agentId: agent.id, position: maxPosition + 1, status: "idle" });
  };

  // 「移出工作区」：按 agent.id 找到 card 删掉。
  const removeFromWorkspace = (agentId: string) => {
    const card = cardsByAgentId.get(agentId);
    if (!card) return;
    deleteCardMutation.mutate(card.id);
  };

  // AgentWorkstation 内部状态变更时由它调过来，父层 PUT 回数据库。
  // patch 里只有变化的字段；agentId / position 由父层补齐。
  const persistCardPatch = (agentId: string, patch: WorkstationCardPatch) => {
    const existing = cardsByAgentId.get(agentId);
    if (!existing) return; // 理论上不该到这里（卡都没有就不该有 onPersistCard 触发）
    persistCardMutation.mutate({
      ...existing,
      ...patch,
    });
  };

  const handleEdit = (agent: Agent | null) => {
    setEditing(agent);
    setEditorOpen(true);
  };

  const handleDuplicate = async (agent: Agent) => {
    try {
      await saveMutation.mutateAsync({
        name: `${agent.name} 副本`,
        description: agent.description,
        systemPrompt: agent.systemPrompt,
        defaultSize: agent.defaultSize,
        defaultQuality: agent.defaultQuality,
        avatarUrl: agent.avatarUrl,
        referenceImageKeys: agent.referenceImageKeys,
      });
      message.success("已复制一份");
    } catch {
      // mutation onError 已弹错误
    }
  };

  const handleSubmit = async (values: AgentFormValues) => {
    try {
      await saveMutation.mutateAsync({
        id: editing?.id,
        name: values.name,
        description: values.description,
        systemPrompt: values.systemPrompt,
        defaultSize: values.defaultSize,
        defaultQuality: values.defaultQuality,
        avatarUrl: values.avatarUrl,
        referenceImageKeys: values.referenceImageKeys,
      });
      setEditorOpen(false);
      setEditing(null);
      message.success(editing ? "已保存" : "已新建角色");
    } catch {
      // mutation onError 已弹错误
    }
  };

  const confirmDelete = async () => {
    if (!deletingAgent) return;
    try {
      await deleteMutation.mutateAsync(deletingAgent.id);
      message.success("已删除");
    } catch {
      // mutation onError 已弹错误
    } finally {
      setDeletingAgent(null);
    }
  };

  // 「我的角色」侧栏 —— 抽成一个 JSX 片段，桌面侧边 + 移动端在 Tab 之上各用一份
  const agentLibrarySidebar = (
    <aside className="flex max-h-[45vh] w-full shrink-0 flex-col rounded-lg border border-stone-200 bg-card shadow-sm dark:border-stone-800 lg:max-h-none lg:h-full lg:w-72 xl:w-80">
      <div className="flex items-center justify-between gap-2 border-b border-stone-200 px-3 py-2.5 dark:border-stone-800">
        <div className="flex items-center gap-2">
          <h2 className="text-sm font-semibold">我的角色</h2>
          <Tag className="m-0">{agents.length}</Tag>
        </div>
        <Button size="small" type="primary" icon={<Plus className="size-3.5" />} onClick={() => handleEdit(null)}>新建</Button>
      </div>
      <div className="px-3 py-2">
        <Input
          allowClear
          size="small"
          prefix={<Search className="size-3.5 text-stone-400" />}
          placeholder="搜索角色名 / 描述 / 提示词"
          value={keyword}
          onChange={(event) => setKeyword(event.target.value)}
        />
      </div>
      <div className="thin-scrollbar flex-1 space-y-2 overflow-y-auto px-3 pb-3 lg:min-h-0">
        {agentsQuery.isLoading ? (
          <div className="flex h-32 items-center justify-center text-sm text-stone-500">正在加载…</div>
        ) : agents.length === 0 ? (
          <Empty description="还没有角色，点上方「新建」开始" image={Empty.PRESENTED_IMAGE_SIMPLE} />
        ) : filteredAgents.length === 0 ? (
          <div className="flex h-24 items-center justify-center text-sm text-stone-500">没有匹配的角色</div>
        ) : (
          filteredAgents.map((agent) => (
            <AgentLibraryCard
              key={agent.id}
              agent={agent}
              inWorkspace={workspaceIds.has(agent.id)}
              onAddToWorkspace={() => addToWorkspace(agent)}
              onEdit={() => handleEdit(agent)}
              onDuplicate={() => void handleDuplicate(agent)}
              onDelete={() => setDeletingAgent(agent)}
              showAddToWorkspace={mode === "parallel"}
            />
          ))
        )}
      </div>
    </aside>
  );

  // ====== 批量任务 Tab 数据 ======

  // pipelines：BatchCreateModal / BatchTemplateManagerModal 都要传 pipelines（让用户从模板中挑）
  const pipelinesQuery = useQuery({
    queryKey: PIPELINES_QUERY_KEY,
    queryFn: () => fetchMyPipelines(token),
    enabled: Boolean(token),
  });
  const pipelinesForBatch: Pipeline[] = pipelinesQuery.data?.items || [];

  // 列表 query：mode === "batch" 时启用；仅在列表里至少一条 batch 处于活跃状态时 polling
  const batchesQuery = useQuery({
    queryKey: BATCHES_QUERY_KEY,
    queryFn: () => fetchMyPipelineBatches(token),
    enabled: Boolean(token) && mode === "batch",
    refetchInterval: (query) => {
      const data = query.state.data as PipelineBatchListResponse | undefined;
      const hasActive = (data?.items || []).some((item) => (
        item.status === "queued" || item.status === "running" || item.status === "post_waiting"
      ));
      return hasActive ? 3000 : false;
    },
  });
  const batchesList = batchesQuery.data?.items || [];

  const deleteBatchMutation = useMutation({
    mutationFn: (id: string) => deleteMyPipelineBatch(token, id),
    onSuccess: (_, id) => {
      queryClient.setQueryData<PipelineBatchListResponse>(BATCHES_QUERY_KEY, (old) => {
        if (!old) return old;
        return { ...old, items: old.items.filter((item) => item.id !== id), total: Math.max(0, old.total - 1) };
      });
      message.success("已删除批量任务");
    },
    onError: (error) => {
      message.error(error instanceof Error ? error.message : "删除失败");
    },
  });

  // 「全部启动」：把目标 batch 的所有 main run 从 paused → queued（清旧产物，与 pipeline-mode 重置语义一致）
  // 列表卡片不直接持有 mainRuns，需先 fetch detail 拿到 main runs 列表再批量 PUT。
  const handleStartAllForBatch = async (batchId: string) => {
    setStartingBatchId(batchId);
    try {
      const detail = await queryClient.fetchQuery({
        queryKey: ["my-pipeline-batch", batchId],
        queryFn: () => import("@/services/api/pipeline-batches").then((m) => m.fetchMyPipelineBatch(token, batchId)),
      });
      const mains = detail.mainRuns;
      let started = 0;
      for (const run of mains) {
        const next: PipelineRun = {
          ...run,
          status: "queued",
          steps: run.steps.map((step) => ({
            ...step,
            status: "idle",
            outputKey: undefined,
            errorMessage: undefined,
            durationMs: undefined,
            lastRunSnapshot: undefined,
          })),
        };
        try {
          await saveMyPipelineRun(token, next);
          started += 1;
        } catch {
          // 单条失败不阻断
        }
      }
      queryClient.invalidateQueries({ queryKey: BATCHES_QUERY_KEY });
      queryClient.invalidateQueries({ queryKey: ["my-pipeline-batch", batchId] });
      queryClient.invalidateQueries({ queryKey: ["my-pipeline-runs"] });
      if (started > 0) {
        message.success(`已启动 ${started} 条主条`);
      } else {
        message.error("启动失败");
      }
    } catch (error) {
      message.error(error instanceof Error ? error.message : "启动失败");
    } finally {
      setStartingBatchId("");
    }
  };

  const handleDeleteBatch = (id: string, name: string) => {
    modal.confirm({
      title: "删除批量任务",
      content: `确定删除「${name || "未命名批次"}」吗？该批次下所有 main / post run 以及关联的图片资源（原图、各步产物）都会一并删除（仍被别处引用的图片会保留）。`,
      okText: "删除",
      okButtonProps: { danger: true },
      cancelText: "取消",
      // mutateAsync 让 antd Modal 自动转 loading；.catch 让失败时 modal 也能关掉
      onOk: () => deleteBatchMutation.mutateAsync(id).catch(() => undefined),
    });
  };

  const handleDownloadBatchZip = async (id: string, name: string) => {
    if (downloadingBatchId) return; // 同一时间只让一个下载在跑，防连点
    setDownloadingBatchId(id);
    try {
      await downloadPipelineBatchZip(id, name || `pipeline-batch-${id.slice(-6)}`);
    } catch (error) {
      message.error(error instanceof Error ? error.message : "下载失败");
    } finally {
      setDownloadingBatchId("");
    }
  };

  const handleBatchCreated = (detail: PipelineBatchDetail) => {
    queryClient.invalidateQueries({ queryKey: BATCHES_QUERY_KEY });
    setBatchCreateOpen(false);
    setBatchFromTemplateOpen(false);
    message.success("已创建批量任务");
    // 直接跳到新建批次详情页
    nav.push(`/agents/batches/${detail.batch.id}`);
  };

  // 批量任务 Tab 内容
  const batchTabContent = (
    <div className="flex flex-col gap-3">
      {/* 顶部工具栏 */}
      <div className="flex flex-wrap items-center gap-2 rounded-lg border border-stone-200 bg-card p-3 shadow-sm dark:border-stone-800">
        <Button
          type="primary"
          icon={<Plus className="size-4" />}
          onClick={() => setBatchCreateOpen(true)}
        >
          新建批量任务
        </Button>
        <Button
          icon={<Layers className="size-4" />}
          onClick={() => setBatchFromTemplateOpen(true)}
          title="从已保存的批处理模板快速创建一个批次"
        >
          从模板创建
        </Button>
        <Button
          icon={<FolderCog className="size-4" />}
          onClick={() => setBatchTemplateManagerOpen(true)}
        >
          批处理模板
        </Button>
      </div>

      {/* 列表 */}
      {batchesQuery.isLoading ? (
        <div className="flex h-32 items-center justify-center rounded-lg border border-dashed border-stone-300 text-sm text-stone-500 dark:border-stone-700">加载中…</div>
      ) : batchesList.length === 0 ? (
        <div className="flex flex-col items-center justify-center gap-3 rounded-lg border border-dashed border-stone-300 p-10 text-center dark:border-stone-700">
          <Empty
            image={Empty.PRESENTED_IMAGE_SIMPLE}
            description={<div className="text-sm text-stone-500 dark:text-stone-400">还没有批量任务，点上方按钮创建</div>}
          />
        </div>
      ) : (
        <div className="flex flex-col gap-3">
          {batchesList.map((item) => (
            <BatchCard
              key={item.id}
              item={item}
              onOpen={() => nav.push(`/agents/batches/${item.id}`)}
              onDelete={() => handleDeleteBatch(item.id, item.name)}
              onStartAll={() => void handleStartAllForBatch(item.id)}
              onDownloadZip={() => void handleDownloadBatchZip(item.id, item.name)}
              starting={startingBatchId === item.id}
              downloading={downloadingBatchId === item.id}
            />
          ))}
        </div>
      )}
    </div>
  );

  // 并行模式工作区 —— 抽成一个 JSX 片段，作为右侧 Tab 之一
  const parallelTabContent = (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex min-w-0 items-center gap-2">
          <Tag className="m-0 shrink-0">{workspaceAgents.length} 个角色</Tag>
          <span className="hidden truncate text-xs text-stone-500 dark:text-stone-400 sm:inline">每个角色独立处理自己的图片，互不影响</span>
        </div>
        <Button
          size="small"
          icon={<History className="size-3.5" />}
          onClick={() => {
            setRecordsAgentFilter("");
            setRecordsPage(1);
            setRecordsOpen(true);
          }}
          aria-label="生成记录"
          title="生成记录"
        >
          <span className="hidden sm:inline">生成记录</span>
        </Button>
      </div>
      {workspaceAgents.length === 0 ? (
        <div className="flex min-h-[280px] flex-col items-center justify-center rounded-lg border border-dashed border-stone-300 text-center text-sm text-stone-500 dark:border-stone-700">
          <p className="mb-1 font-medium">工作区是空的</p>
          <p className="text-xs text-stone-400">在左侧「我的角色」点「加入工作区」把角色加进来，同页并行处理图片</p>
        </div>
      ) : (
        <div className="grid grid-cols-1 items-start gap-3 md:grid-cols-2 2xl:grid-cols-3">
          {workspaceAgents.map((agent) => (
            <AgentWorkstation
              key={agent.id}
              agent={agent}
              initialCard={cardsByAgentId.get(agent.id) || null}
              onPersistCard={(patch) => persistCardPatch(agent.id, patch)}
              onRemove={() => removeFromWorkspace(agent.id)}
              onEdit={() => handleEdit(agent)}
              onUsed={() => {
                queryClient.setQueryData<AgentListResponse>(AGENTS_QUERY_KEY, (old) => {
                  if (!old) return old;
                  return {
                    ...old,
                    items: old.items.map((item) => (item.id === agent.id ? { ...item, usageCount: (item.usageCount || 0) + 1 } : item)),
                  };
                });
              }}
              onGenerationSaved={() => {
                setRecordsRefreshKey((value) => value + 1);
              }}
            />
          ))}
        </div>
      )}
    </div>
  );

  return (
    <main className="thin-scrollbar mx-auto flex h-full w-full max-w-[1600px] flex-col gap-3 overflow-hidden p-3 lg:gap-4 lg:p-4">
      <header className="shrink-0">
        <h1 className="text-xl font-semibold leading-tight lg:text-2xl">角色工作台</h1>
        <p className="mt-0.5 hidden text-sm text-stone-500 dark:text-stone-400 sm:block">
          {mode === "parallel"
            ? "给常用流程预设角色，加入工作区后多个角色可以同页并行各自处理图片，互不影响。"
            : mode === "pipeline"
              ? "把多个角色串成流水线：上一步的产物自动喂给下一步，每一步都可以单独重做、替换输入、调附加说明。"
              : "一次性扔多张原图各自跑一套流水线，跑完后可统一对接后处理角色（如统一调色）打包下载。"}
        </p>
      </header>

      {/* 桌面 lg+：左右双列 + 各自独立滚动；移动端：上下堆叠 */}
      <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-hidden lg:flex-row lg:gap-4">
        {agentLibrarySidebar}

        <section className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-lg border border-stone-200 bg-card shadow-sm dark:border-stone-800">
          <Tabs
            activeKey={mode}
            onChange={(key) => setMode(key as WorkbenchMode)}
            className="flex min-h-0 flex-1 flex-col [&_.ant-tabs-content-holder]:thin-scrollbar [&_.ant-tabs-content-holder]:min-h-0 [&_.ant-tabs-content-holder]:flex-1 [&_.ant-tabs-content-holder]:overflow-y-auto [&_.ant-tabs-content-holder]:px-3 [&_.ant-tabs-content-holder]:pb-3 lg:[&_.ant-tabs-content-holder]:px-4 lg:[&_.ant-tabs-content-holder]:pb-4 [&_.ant-tabs-nav]:!mb-0 [&_.ant-tabs-nav]:!px-3 lg:[&_.ant-tabs-nav]:!px-4"
            items={[
              { key: "parallel", label: "并行模式", children: parallelTabContent },
              { key: "pipeline", label: "流水线模式", children: <PipelineMode agents={agents} /> },
              { key: "batch", label: "批量任务", children: batchTabContent },
            ]}
          />
        </section>
      </div>

      <AgentEditModal
        open={editorOpen}
        editing={editing}
        onClose={() => {
          setEditorOpen(false);
          setEditing(null);
        }}
        onSubmit={(values) => handleSubmit(values)}
        submitting={saveMutation.isPending}
      />

      <Modal
        title="删除角色"
        open={Boolean(deletingAgent)}
        onCancel={() => setDeletingAgent(null)}
        onOk={() => void confirmDelete()}
        okText="删除"
        okButtonProps={{ danger: true, loading: deleteMutation.isPending }}
        cancelText="取消"
      >
        确定删除「{deletingAgent?.name}」吗？删除后历史调用记录里仍能看到这个名字，但角色卡片和工作区里不再展示；角色头像、参考图等关联图片资源也会一并删除（仍被别处引用的会保留）。
      </Modal>

      <AgentRecordsDrawer
        open={recordsOpen}
        onClose={() => setRecordsOpen(false)}
        agents={agents}
        agentFilter={recordsAgentFilter}
        onAgentFilterChange={setRecordsAgentFilter}
        page={recordsPage}
        onPageChange={setRecordsPage}
        refreshKey={recordsRefreshKey}
      />

      {/* 批量任务 3 个 Modal */}
      <BatchCreateModal
        open={batchCreateOpen}
        onClose={() => setBatchCreateOpen(false)}
        onCreated={handleBatchCreated}
        agents={agents}
        pipelines={pipelinesForBatch}
      />
      <BatchTemplateManagerModal
        open={batchTemplateManagerOpen}
        onClose={() => setBatchTemplateManagerOpen(false)}
        agents={agents}
        pipelines={pipelinesForBatch}
      />
      <BatchFromTemplateModal
        open={batchFromTemplateOpen}
        onClose={() => setBatchFromTemplateOpen(false)}
        onCreated={handleBatchCreated}
        templates={batchTemplates}
      />
    </main>
  );
}
