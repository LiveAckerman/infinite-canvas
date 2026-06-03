"use client";

import { Copy, Pencil, Plus, Trash2 } from "lucide-react";
import { App, Button, Empty, Modal, Tag, Typography } from "antd";
import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import type { Agent } from "@/services/api/agents";
import type { Pipeline } from "@/services/api/pipelines";
import {
  type PipelineBatchTemplate,
  type PipelineBatchTemplateListResponse,
  deleteMyPipelineBatchTemplate,
  fetchMyPipelineBatchTemplates,
  saveMyPipelineBatchTemplate,
} from "@/services/api/pipeline-batch-templates";
import { useUserStore } from "@/stores/use-user-store";

import { BatchTemplateEditorModal } from "./batch-template-editor-modal";

type Props = {
  open: boolean;
  onClose: () => void;
  agents: Agent[];
  pipelines: Pipeline[];
};

// 与外部共享的列表 queryKey，方便父层（如选模板创建批次的 Modal）也读到同一份缓存。
export const BATCH_TEMPLATES_QUERY_KEY = ["pipeline-batch-templates", "me"] as const;

export function BatchTemplateManagerModal({ open, onClose, agents, pipelines }: Props) {
  const { message, modal } = App.useApp();
  const token = useUserStore((state) => state.token);
  const queryClient = useQueryClient();

  const [editorOpen, setEditorOpen] = useState(false);
  const [editing, setEditing] = useState<PipelineBatchTemplate | null>(null);

  const { data, isLoading } = useQuery({
    queryKey: BATCH_TEMPLATES_QUERY_KEY,
    queryFn: () => fetchMyPipelineBatchTemplates(token),
    enabled: open && !!token,
  });
  const templates = data?.items ?? [];

  const deleteMutation = useMutation({
    mutationFn: (id: string) => deleteMyPipelineBatchTemplate(token, id),
    onSuccess: (_, id) => {
      queryClient.setQueryData<PipelineBatchTemplateListResponse>(BATCH_TEMPLATES_QUERY_KEY, (old) => {
        if (!old) return old;
        return { ...old, items: old.items.filter((item) => item.id !== id), total: Math.max(0, old.total - 1) };
      });
      message.success("已删除");
    },
    onError: (error) => {
      message.error(error instanceof Error ? error.message : "删除失败");
    },
  });

  // 复制模板：直接调 save 接口，id 留空相当于新建一份
  const duplicateMutation = useMutation({
    mutationFn: (template: PipelineBatchTemplate) =>
      saveMyPipelineBatchTemplate(token, {
        name: `${template.name} 副本`,
        description: template.description,
        itemCount: template.itemCount,
        items: template.items.map((entry) => ({ ...entry })),
        post: template.post
          ? {
              name: template.post.name,
              sources: template.post.sources.map((entry) => ({ ...entry })),
              agentIds: [...template.post.agentIds],
            }
          : undefined,
      }),
    onSuccess: (saved) => {
      queryClient.setQueryData<PipelineBatchTemplateListResponse>(BATCH_TEMPLATES_QUERY_KEY, (old) => {
        if (!old) return { items: [saved], total: 1 };
        return { ...old, items: [saved, ...old.items], total: old.total + 1 };
      });
      message.success("已复制一份");
    },
    onError: (error) => {
      message.error(error instanceof Error ? error.message : "复制失败");
    },
  });

  const confirmDelete = (template: PipelineBatchTemplate) => {
    modal.confirm({
      title: "删除批处理模板",
      content: `确定删除「${template.name}」吗？已经基于该模板创建的批量任务不会受影响。`,
      okText: "删除",
      okButtonProps: { danger: true },
      cancelText: "取消",
      onOk: () => deleteMutation.mutateAsync(template.id).catch(() => undefined),
    });
  };

  const handleSaved = (saved: PipelineBatchTemplate) => {
    queryClient.setQueryData<PipelineBatchTemplateListResponse>(BATCH_TEMPLATES_QUERY_KEY, (old) => {
      if (!old) return { items: [saved], total: 1 };
      const exists = old.items.some((item) => item.id === saved.id);
      if (exists) {
        return { ...old, items: old.items.map((item) => (item.id === saved.id ? saved : item)) };
      }
      return { items: [saved, ...old.items], total: old.total + 1 };
    });
    setEditing(null);
  };

  return (
    <>
      <Modal
        title="批处理模板"
        open={open}
        width={680}
        onCancel={onClose}
        footer={(
          <div className="flex justify-between">
            <Button
              type="primary"
              icon={<Plus className="size-4" />}
              onClick={() => {
                setEditing(null);
                setEditorOpen(true);
              }}
            >
              新建模板
            </Button>
            <Button onClick={onClose}>关闭</Button>
          </div>
        )}
        destroyOnHidden
      >
        {isLoading ? (
          <div className="flex h-32 items-center justify-center text-sm text-stone-500">加载中…</div>
        ) : templates.length === 0 ? (
          <Empty description="还没有任何批处理模板" image={Empty.PRESENTED_IMAGE_SIMPLE} />
        ) : (
          <div className="flex flex-col gap-2">
            {templates.map((template) => {
              const postEnabled = !!template.post;
              const postAgentMissing = postEnabled
                ? template.post!.agentIds.filter((agentId) => !agents.some((agent) => agent.id === agentId)).length
                : 0;
              const itemPipelineMissing = template.items.filter(
                (entry) => !pipelines.some((pipeline) => pipeline.id === entry.pipelineId),
              ).length;
              return (
                <div
                  key={template.id}
                  className="flex items-start gap-3 rounded-lg border border-stone-200 p-3 transition hover:bg-stone-50 dark:border-stone-800 dark:hover:bg-stone-900"
                >
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <Typography.Text strong className="!text-sm">{template.name}</Typography.Text>
                      <Tag color="blue" className="m-0">{template.itemCount} 条主条</Tag>
                      <Tag color={postEnabled ? "green" : "default"} className="m-0">
                        后处理: {postEnabled ? "启用" : "未启用"}
                      </Tag>
                      {itemPipelineMissing > 0 ? (
                        <Tag color="red" className="m-0">{itemPipelineMissing} 条流水线已删</Tag>
                      ) : null}
                      {postAgentMissing > 0 ? (
                        <Tag color="red" className="m-0">{postAgentMissing} 个角色已删</Tag>
                      ) : null}
                    </div>
                    {template.description ? (
                      <Typography.Text type="secondary" className="!text-xs">{template.description}</Typography.Text>
                    ) : null}
                  </div>
                  <div className="flex shrink-0 items-center gap-1">
                    <Button
                      size="small"
                      type="text"
                      icon={<Pencil className="size-3.5" />}
                      onClick={() => {
                        setEditing(template);
                        setEditorOpen(true);
                      }}
                    >
                      编辑
                    </Button>
                    <Button
                      size="small"
                      type="text"
                      icon={<Copy className="size-3.5" />}
                      onClick={() => duplicateMutation.mutate(template)}
                      loading={duplicateMutation.isPending && duplicateMutation.variables?.id === template.id}
                    >
                      复制
                    </Button>
                    <Button
                      size="small"
                      type="text"
                      danger
                      icon={<Trash2 className="size-3.5" />}
                      onClick={() => confirmDelete(template)}
                    >
                      删除
                    </Button>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </Modal>

      <BatchTemplateEditorModal
        open={editorOpen}
        template={editing}
        onClose={() => {
          setEditorOpen(false);
          setEditing(null);
        }}
        onSaved={handleSaved}
        agents={agents}
        pipelines={pipelines}
      />
    </>
  );
}
