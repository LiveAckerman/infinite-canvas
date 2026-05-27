"use client";

import { History, Plus, Search } from "lucide-react";
import { App, Button, Empty, Input, Modal, Tabs, Tag } from "antd";
import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { RequireAuth } from "@/components/require-auth";
import { deleteMyAgent, fetchMyAgents, saveMyAgent, type Agent, type AgentListResponse } from "@/services/api/agents";
import { useUserStore } from "@/stores/use-user-store";

import { AgentEditModal, type AgentFormValues } from "./components/agent-edit-modal";
import { AgentLibraryCard } from "./components/agent-library-card";
import { AgentRecordsDrawer } from "./components/agent-records-drawer";
import { AgentWorkstation } from "./components/agent-workstation";
import { PipelineMode } from "./components/pipeline-mode";

// 「并行 / 流水线」模式偏好，localStorage 持久化（轻量偏好不上云）。
const MODE_STORAGE_KEY = "infinite-canvas:agents:mode";
type WorkbenchMode = "parallel" | "pipeline";
function loadMode(): WorkbenchMode {
  if (typeof window === "undefined") return "parallel";
  return window.localStorage.getItem(MODE_STORAGE_KEY) === "pipeline" ? "pipeline" : "parallel";
}

const AGENTS_QUERY_KEY = ["my-agents"] as const;

// 工作区里加入了哪些角色 id 按用户隔离存 localStorage，刷新 / 重开浏览器都能恢复。
// 不上云：工作区是「当前会话偏好」性质，跨设备同步意义不大；后续要上云再加。
const WORKSPACE_STORAGE_KEY_PREFIX = "infinite-canvas:agents:workspace";
function storageKeyForUser(userId: string) {
  return `${WORKSPACE_STORAGE_KEY_PREFIX}:${userId}`;
}
function loadWorkspaceIds(userId: string): string[] {
  if (typeof window === "undefined" || !userId) return [];
  try {
    const raw = window.localStorage.getItem(storageKeyForUser(userId));
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((id): id is string => typeof id === "string");
  } catch {
    return [];
  }
}

export default function AgentsPage() {
  return (
    <RequireAuth>
      <AgentsWorkbench />
    </RequireAuth>
  );
}

function AgentsWorkbench() {
  const { message } = App.useApp();
  const queryClient = useQueryClient();
  const token = useUserStore((state) => state.token);
  const userId = useUserStore((state) => state.user?.id || "");
  const [keyword, setKeyword] = useState("");
  const [editing, setEditing] = useState<Agent | null>(null);
  const [editorOpen, setEditorOpen] = useState(false);
  const [deletingAgent, setDeletingAgent] = useState<Agent | null>(null);
  // 「生成记录」Drawer：开关 + 角色筛选 + 分页页码 + refreshKey（workstation 跑完一次 bump）。
  // 这些状态放在 page 层，让 Drawer 关掉再打开能恢复用户上次的筛选和翻页位置。
  const [recordsOpen, setRecordsOpen] = useState(false);
  const [recordsAgentFilter, setRecordsAgentFilter] = useState<string>("");
  const [recordsPage, setRecordsPage] = useState(1);
  const [recordsRefreshKey, setRecordsRefreshKey] = useState(0);
  // 工作区是一份独立的 agent.id 列表；list 接口拉到的角色只是「库」，加入工作区才进 grid。
  // 按用户隔离持久化到 localStorage，刷新 / 重开浏览器都能恢复用户上次摆放的工作区。
  const [workspaceIds, setWorkspaceIds] = useState<string[]>(() => loadWorkspaceIds(userId));
  // 顶部模式：并行 vs 流水线。localStorage 持久化，与 workspaceIds 互不影响。
  const [mode, setMode] = useState<WorkbenchMode>(() => loadMode());
  useEffect(() => {
    if (typeof window === "undefined") return;
    window.localStorage.setItem(MODE_STORAGE_KEY, mode);
  }, [mode]);

  // userId 切换（登录 / 切账号）时把工作区切回新账号的快照；
  // 没登录或新账号没保存过就是空数组。
  useEffect(() => {
    setWorkspaceIds(loadWorkspaceIds(userId));
  }, [userId]);

  // workspaceIds 任何变更都写回 localStorage（仅有用户时；guest 不写）。
  useEffect(() => {
    if (typeof window === "undefined" || !userId) return;
    try {
      window.localStorage.setItem(storageKeyForUser(userId), JSON.stringify(workspaceIds));
    } catch {
      // QuotaExceeded 等极端情况直接忽略，不打扰生成流程
    }
  }, [userId, workspaceIds]);

  const agentsQuery = useQuery({
    queryKey: AGENTS_QUERY_KEY,
    queryFn: () => fetchMyAgents(token),
    enabled: Boolean(token),
  });

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
      setWorkspaceIds((value) => value.filter((wid) => wid !== id));
    },
    onError: (error) => {
      message.error(error instanceof Error ? error.message : "删除失败");
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

  const workspaceAgents = useMemo(() => {
    // 工作区按用户加入的顺序展示；列表里被删除的角色也要从工作区里剔掉
    return workspaceIds.map((id) => agents.find((agent) => agent.id === id)).filter((agent): agent is Agent => Boolean(agent));
  }, [agents, workspaceIds]);

  const addToWorkspace = (agent: Agent) => {
    setWorkspaceIds((value) => value.includes(agent.id) ? value : [...value, agent.id]);
  };

  const removeFromWorkspace = (id: string) => {
    setWorkspaceIds((value) => value.filter((wid) => wid !== id));
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
              inWorkspace={workspaceIds.includes(agent.id)}
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
        <div className="grid grid-cols-1 items-stretch gap-3 md:grid-cols-2 2xl:grid-cols-3">
          {workspaceAgents.map((agent) => (
            <AgentWorkstation
              key={agent.id}
              agent={agent}
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
            : "把多个角色串成流水线：上一步的产物自动喂给下一步，每一步都可以单独重做、替换输入、调附加说明。"}
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
        确定删除「{deletingAgent?.name}」吗？删除后历史调用记录里仍能看到这个名字，但角色卡片和工作区里不再展示。
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
    </main>
  );
}
