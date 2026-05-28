"use client";

import { Plus, X } from "lucide-react";
import {
  App,
  Button,
  Checkbox,
  Form,
  Input,
  Modal,
  Radio,
  Select,
  Tag,
  Typography,
} from "antd";
import { useEffect, useMemo, useState } from "react";
import { useMutation } from "@tanstack/react-query";

import type { Agent } from "@/services/api/agents";
import type { Pipeline } from "@/services/api/pipelines";
import {
  type PipelineBatchTemplate,
  saveMyPipelineBatchTemplate,
} from "@/services/api/pipeline-batch-templates";
import { useUserStore } from "@/stores/use-user-store";

import { AgentAvatar } from "./agent-avatar";

type Props = {
  open: boolean;
  template: PipelineBatchTemplate | null;
  onClose: () => void;
  onSaved: (saved: PipelineBatchTemplate) => void;
  agents: Agent[];
  pipelines: Pipeline[];
};

type ItemDraft = {
  rowId: string;
  name: string;
  pipelineId: string;
};

type PostSourceDraft = {
  itemRowId: string;
  stepIndex: number;
};

const MAX_ITEMS = 9;
const MIN_ITEMS = 1;
const MAX_POST_SOURCES = 6;
const MIN_POST_SOURCES = 1;
const MAX_POST_AGENTS = 10;
const MIN_POST_AGENTS = 1;

const newRowId = () => `row-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

export function BatchTemplateEditorModal({ open, template, onClose, onSaved, agents, pipelines }: Props) {
  const { message } = App.useApp();
  const token = useUserStore((state) => state.token);

  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [items, setItems] = useState<ItemDraft[]>([]);
  const [postEnabled, setPostEnabled] = useState(false);
  const [postName, setPostName] = useState("");
  // 模板里的 source 用 itemRowId 而不是 itemIndex 存（rowId 跨增删稳定，最后保存时再算 index）
  const [postSources, setPostSources] = useState<PostSourceDraft[]>([]);
  const [postAgentIds, setPostAgentIds] = useState<string[]>([]);

  // 打开时把 template 转 draft；新建则给一条默认空行
  useEffect(() => {
    if (!open) return;
    if (template) {
      const rows = template.items.map((entry) => ({
        rowId: newRowId(),
        name: entry.name,
        pipelineId: entry.pipelineId,
      }));
      setName(template.name);
      setDescription(template.description || "");
      setItems(rows);
      const post = template.post;
      if (post) {
        setPostEnabled(true);
        setPostName(post.name || "");
        setPostSources(
          post.sources
            .filter((entry) => entry.itemIndex >= 0 && entry.itemIndex < rows.length)
            .map((entry) => ({ itemRowId: rows[entry.itemIndex].rowId, stepIndex: entry.stepIndex })),
        );
        setPostAgentIds([...post.agentIds]);
      } else {
        setPostEnabled(false);
        setPostName("");
        setPostSources([]);
        setPostAgentIds([]);
      }
    } else {
      setName("");
      setDescription("");
      setItems([{ rowId: newRowId(), name: "", pipelineId: "" }]);
      setPostEnabled(false);
      setPostName("");
      setPostSources([]);
      setPostAgentIds([]);
    }
  }, [open, template]);

  const addItem = () => {
    if (items.length >= MAX_ITEMS) {
      message.warning(`主条数量最多 ${MAX_ITEMS}`);
      return;
    }
    setItems((prev) => [...prev, { rowId: newRowId(), name: "", pipelineId: "" }]);
  };

  const removeItem = (rowId: string) => {
    if (items.length <= MIN_ITEMS) {
      message.warning(`至少保留 ${MIN_ITEMS} 条主条`);
      return;
    }
    setItems((prev) => prev.filter((row) => row.rowId !== rowId));
    setPostSources((prev) => prev.filter((entry) => entry.itemRowId !== rowId));
  };

  const updateItem = (rowId: string, patch: Partial<ItemDraft>) => {
    setItems((prev) => prev.map((row) => (row.rowId === rowId ? { ...row, ...patch } : row)));
    if (patch.pipelineId !== undefined) {
      // 改流水线后，对应 source 的 stepIndex 可能越界，重置成 seed
      setPostSources((prev) =>
        prev.map((entry) => (entry.itemRowId === rowId ? { ...entry, stepIndex: -1 } : entry)),
      );
    }
  };

  const togglePostSource = (rowId: string, enabled: boolean) => {
    setPostSources((prev) => {
      const existing = prev.find((entry) => entry.itemRowId === rowId);
      if (enabled) {
        if (existing) return prev;
        return [...prev, { itemRowId: rowId, stepIndex: -1 }];
      }
      return prev.filter((entry) => entry.itemRowId !== rowId);
    });
  };

  const updatePostSourceStep = (rowId: string, stepIndex: number) => {
    setPostSources((prev) =>
      prev.map((entry) => (entry.itemRowId === rowId ? { ...entry, stepIndex } : entry)),
    );
  };

  const addPostAgent = (agentId: string) => {
    if (!agentId) return;
    if (postAgentIds.includes(agentId)) return;
    if (postAgentIds.length >= MAX_POST_AGENTS) {
      message.warning(`后处理角色最多 ${MAX_POST_AGENTS} 个`);
      return;
    }
    setPostAgentIds((prev) => [...prev, agentId]);
  };

  const removePostAgent = (agentId: string) => {
    setPostAgentIds((prev) => prev.filter((id) => id !== agentId));
  };

  const availablePostAgents = useMemo(
    () => agents.filter((agent) => !postAgentIds.includes(agent.id)),
    [agents, postAgentIds],
  );

  const pipelineOptions = pipelines.map((item) => ({
    label: `${item.name} · ${item.steps.length} 步`,
    value: item.id,
  }));

  // 保存：把 itemRowId 映射回 itemIndex
  const saveMutation = useMutation({
    mutationFn: (payload: Partial<PipelineBatchTemplate>) => saveMyPipelineBatchTemplate(token, payload),
    onSuccess: (saved) => {
      message.success(template ? "已保存" : "已新建模板");
      onSaved(saved);
      onClose();
    },
    onError: (error) => {
      message.error(error instanceof Error ? error.message : "保存失败");
    },
  });

  const handleSave = () => {
    const trimmedName = name.trim();
    if (!trimmedName) {
      message.warning("请输入模板名");
      return;
    }
    if (trimmedName.length > 30) {
      message.warning("模板名最多 30 个字");
      return;
    }
    if (description.trim().length > 200) {
      message.warning("描述最多 200 个字");
      return;
    }
    if (items.length < MIN_ITEMS || items.length > MAX_ITEMS) {
      message.warning(`主条数量需在 ${MIN_ITEMS}~${MAX_ITEMS} 之间`);
      return;
    }
    for (let i = 0; i < items.length; i += 1) {
      if (!items[i].pipelineId) {
        message.warning(`主条 ${i + 1} 还没选择流水线模板`);
        return;
      }
    }
    let postPayload: PipelineBatchTemplate["post"] | undefined;
    if (postEnabled) {
      if (postSources.length < MIN_POST_SOURCES) {
        message.warning("后处理至少要选 1 个 source");
        return;
      }
      if (postSources.length > MAX_POST_SOURCES) {
        message.warning(`后处理 source 最多 ${MAX_POST_SOURCES} 个`);
        return;
      }
      if (postAgentIds.length < MIN_POST_AGENTS) {
        message.warning("后处理至少要加 1 个角色");
        return;
      }
      if (postAgentIds.length > MAX_POST_AGENTS) {
        message.warning(`后处理角色最多 ${MAX_POST_AGENTS} 个`);
        return;
      }
      if (new Set(postAgentIds).size !== postAgentIds.length) {
        message.warning("后处理角色不能重复");
        return;
      }
      const indexMap = new Map(items.map((row, index) => [row.rowId, index]));
      const sources = postSources
        .map((entry) => ({
          itemIndex: indexMap.get(entry.itemRowId) ?? -1,
          stepIndex: entry.stepIndex,
        }))
        .filter((entry) => entry.itemIndex >= 0)
        // 按 itemIndex 排序，跟主条列表顺序一致
        .sort((a, b) => a.itemIndex - b.itemIndex);
      postPayload = {
        name: postName.trim() || "后处理",
        sources,
        agentIds: [...postAgentIds],
      };
    }
    saveMutation.mutate({
      id: template?.id,
      name: trimmedName,
      description: description.trim(),
      itemCount: items.length,
      items: items.map((row, index) => ({
        pipelineId: row.pipelineId,
        name: row.name.trim() || `主条 ${index + 1}`,
      })),
      post: postPayload,
    });
  };

  return (
    <Modal
      title={template ? "编辑批处理模板" : "新建批处理模板"}
      open={open}
      width={720}
      maskClosable={false}
      onCancel={onClose}
      onOk={handleSave}
      confirmLoading={saveMutation.isPending}
      okText="保存模板"
      cancelText="取消"
      destroyOnHidden
    >
      <div className="flex max-h-[70vh] flex-col gap-5 overflow-y-auto pr-1">
        <Form layout="vertical" requiredMark={false}>
          <Form.Item label="模板名" required>
            <Input
              placeholder="例如：电商三件套批量"
              value={name}
              onChange={(event) => setName(event.target.value)}
              maxLength={30}
              showCount
            />
          </Form.Item>
          <Form.Item label="描述（可选）">
            <Input.TextArea
              placeholder="一句话说明这个模板的用法"
              value={description}
              onChange={(event) => setDescription(event.target.value)}
              maxLength={200}
              showCount
              rows={2}
            />
          </Form.Item>
        </Form>

        {/* 主条配置 */}
        <section>
          <div className="mb-2 flex items-center justify-between">
            <h4 className="text-sm font-semibold text-stone-700 dark:text-stone-200">
              主条配置（{items.length} / {MAX_ITEMS}）
            </h4>
            {items.length < MAX_ITEMS ? (
              <Button size="small" icon={<Plus className="size-3.5" />} onClick={addItem}>添加主条</Button>
            ) : null}
          </div>
          {pipelines.length === 0 ? (
            <div className="rounded border border-dashed border-stone-300 p-3 text-xs text-stone-500 dark:border-stone-700">
              还没有任何流水线模板，请先到「流水线」Tab 新建一条。
            </div>
          ) : (
            <div className="flex flex-col gap-2">
              {items.map((row, index) => (
                <div
                  key={row.rowId}
                  className="flex items-center gap-3 rounded-md border border-stone-200 bg-card p-2 dark:border-stone-800"
                >
                  <span className="grid size-7 shrink-0 place-items-center rounded-full bg-blue-50 text-xs font-semibold text-blue-600 dark:bg-blue-500/10 dark:text-blue-300">
                    {index + 1}
                  </span>
                  <Input
                    size="small"
                    value={row.name}
                    placeholder={`主条 ${index + 1}`}
                    maxLength={30}
                    onChange={(event) => updateItem(row.rowId, { name: event.target.value })}
                    style={{ flex: "0 0 140px" }}
                  />
                  <Select
                    size="small"
                    value={row.pipelineId || undefined}
                    placeholder="选择流水线模板"
                    options={pipelineOptions}
                    onChange={(value) => updateItem(row.rowId, { pipelineId: value })}
                    className="!flex-1"
                  />
                  {items.length > MIN_ITEMS ? (
                    <Button
                      size="small"
                      type="text"
                      danger
                      icon={<X className="size-3.5" />}
                      onClick={() => removeItem(row.rowId)}
                      aria-label="删除"
                    />
                  ) : null}
                </div>
              ))}
            </div>
          )}
        </section>

        {/* 后处理 */}
        <section>
          <Checkbox checked={postEnabled} onChange={(event) => setPostEnabled(event.target.checked)}>
            <span className="text-sm font-semibold">启用后处理</span>
          </Checkbox>
          <div className="ml-6 mt-1 text-xs text-stone-500 dark:text-stone-400">
            主条全跑完后，把多张主条产物当 references 喂给若干角色独立处理
          </div>

          {postEnabled ? (
            <div className="mt-3 flex flex-col gap-4 rounded-md border border-stone-200 bg-stone-50 p-3 dark:border-stone-800 dark:bg-stone-900/40">
              <div>
                <label className="mb-1 block text-xs font-semibold text-stone-600 dark:text-stone-300">后处理名（可选）</label>
                <Input
                  size="small"
                  placeholder="默认「后处理」"
                  value={postName}
                  onChange={(event) => setPostName(event.target.value)}
                  maxLength={30}
                />
              </div>

              <div>
                <div className="mb-1 flex items-center justify-between">
                  <label className="text-xs font-semibold text-stone-600 dark:text-stone-300">
                    Sources（{postSources.length} / {MAX_POST_SOURCES}）
                  </label>
                  <span className="text-[11px] text-stone-400">所有角色共享同一份 sources</span>
                </div>
                {items.length === 0 ? (
                  <div className="rounded border border-dashed border-stone-300 p-2 text-xs text-stone-500 dark:border-stone-700">
                    请先在上方添加主条。
                  </div>
                ) : (
                  <div className="flex flex-col gap-2">
                    {items.map((row, index) => {
                      const pipeline = pipelines.find((item) => item.id === row.pipelineId);
                      const sourceEntry = postSources.find((entry) => entry.itemRowId === row.rowId);
                      const enabled = !!sourceEntry;
                      const stepIndex = sourceEntry?.stepIndex ?? -1;
                      return (
                        <div
                          key={row.rowId}
                          className="rounded border border-stone-200 bg-white p-2 dark:border-stone-800 dark:bg-stone-900"
                        >
                          <div className="flex items-center gap-2">
                            <Checkbox
                              checked={enabled}
                              onChange={(event) => togglePostSource(row.rowId, event.target.checked)}
                            />
                            <span className="text-xs font-medium text-stone-700 dark:text-stone-200">
                              主条 {index + 1}
                            </span>
                            <span className="text-[11px] text-stone-500 dark:text-stone-400">
                              · {pipeline?.name || <span className="text-red-500">未选模板</span>}
                            </span>
                          </div>
                          {enabled && pipeline ? (
                            <div className="ml-6 mt-2">
                              <Radio.Group
                                value={stepIndex}
                                onChange={(event) => updatePostSourceStep(row.rowId, event.target.value)}
                                size="small"
                              >
                                <Radio value={-1}>Seed（原图）</Radio>
                                {pipeline.steps.map((step, stepIdx) => {
                                  const agent = agents.find((item) => item.id === step.agentId);
                                  return (
                                    <Radio key={step.stepId} value={stepIdx}>
                                      步 {stepIdx + 1}: {agent?.name || "已删除角色"}
                                    </Radio>
                                  );
                                })}
                              </Radio.Group>
                            </div>
                          ) : null}
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>

              <div>
                <div className="mb-1 flex items-center justify-between">
                  <label className="text-xs font-semibold text-stone-600 dark:text-stone-300">
                    角色（{postAgentIds.length} / {MAX_POST_AGENTS}）
                  </label>
                  <span className="text-[11px] text-stone-400">每个角色独立用上面 sources 跑一次</span>
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  {postAgentIds.map((agentId) => {
                    const agent = agents.find((item) => item.id === agentId);
                    if (!agent) {
                      return (
                        <Tag
                          key={agentId}
                          color="red"
                          closable
                          onClose={() => removePostAgent(agentId)}
                          className="!m-0"
                        >
                          已删除角色
                        </Tag>
                      );
                    }
                    return (
                      <div
                        key={agentId}
                        className="flex items-center gap-1.5 rounded-full border border-stone-200 bg-white px-2 py-1 text-xs dark:border-stone-700 dark:bg-stone-900"
                      >
                        <AgentAvatar name={agent.name} avatarUrl={agent.avatarUrl} size={20} />
                        <span className="max-w-[120px] truncate">{agent.name}</span>
                        <button
                          type="button"
                          className="grid size-4 place-items-center rounded-full text-stone-400 transition hover:bg-stone-100 hover:text-stone-700 dark:hover:bg-stone-800 dark:hover:text-stone-200"
                          onClick={() => removePostAgent(agentId)}
                          aria-label="移除"
                        >
                          <X className="size-3" />
                        </button>
                      </div>
                    );
                  })}
                  {postAgentIds.length < MAX_POST_AGENTS ? (
                    <Select
                      size="small"
                      placeholder="+ 添加角色"
                      value={undefined}
                      options={availablePostAgents.map((agent) => ({ label: agent.name, value: agent.id }))}
                      onChange={(value) => addPostAgent(value || "")}
                      style={{ minWidth: 140 }}
                      disabled={availablePostAgents.length === 0}
                      suffixIcon={<Plus className="size-3.5" />}
                    />
                  ) : null}
                </div>
              </div>
            </div>
          ) : null}
        </section>

        <Typography.Text type="secondary" className="!text-xs">
          模板只保存配置，不保存图片。使用模板创建批量任务时再上传 {items.length} 张图。
        </Typography.Text>
      </div>
    </Modal>
  );
}
