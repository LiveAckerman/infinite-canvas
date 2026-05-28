"use client";

import { ImagePlus, Play, X } from "lucide-react";
import { App, Button, Input, Modal, Select, Tag, Typography } from "antd";
import { useEffect, useMemo, useRef, useState, type ChangeEvent } from "react";
import { useMutation } from "@tanstack/react-query";

import { useImageUploader } from "@/lib/use-image-uploader";
import {
  type PipelineBatchDetail,
  createMyPipelineBatchFromTemplate,
} from "@/services/api/pipeline-batches";
import type { PipelineBatchTemplate } from "@/services/api/pipeline-batch-templates";
import { useUserStore } from "@/stores/use-user-store";

type Props = {
  open: boolean;
  onClose: () => void;
  onCreated: (detail: PipelineBatchDetail) => void;
  templates: PipelineBatchTemplate[];
};

type Slot = { seedKey: string; seedUrl: string; fileName: string };

export function BatchFromTemplateModal({ open, onClose, onCreated, templates }: Props) {
  const { message } = App.useApp();
  const token = useUserStore((state) => state.token);
  const uploadWithToast = useImageUploader();

  const [templateId, setTemplateId] = useState<string>("");
  const [slots, setSlots] = useState<Slot[]>([]);
  const [batchName, setBatchName] = useState("");

  // 当前操作的槽位下标（点 + 时记下来，再让隐藏 input.click()）
  const slotIndexRef = useRef<number>(-1);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const selectedTemplate = useMemo(
    () => templates.find((template) => template.id === templateId) || null,
    [templates, templateId],
  );

  // 切换 / 关闭时重置：把 slots 调成对应模板的长度
  useEffect(() => {
    if (!open) {
      setTemplateId("");
      setSlots([]);
      setBatchName("");
      slotIndexRef.current = -1;
      return;
    }
    if (templates.length && !templateId) {
      setTemplateId(templates[0].id);
    }
  }, [open, templates, templateId]);

  useEffect(() => {
    if (!selectedTemplate) {
      setSlots([]);
      return;
    }
    setSlots((prev) => {
      const next: Slot[] = [];
      for (let i = 0; i < selectedTemplate.itemCount; i += 1) {
        next.push(prev[i] ?? { seedKey: "", seedUrl: "", fileName: "" });
      }
      return next;
    });
  }, [selectedTemplate]);

  const triggerPickFor = (index: number) => {
    slotIndexRef.current = index;
    fileInputRef.current?.click();
  };

  const handlePickFile = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = "";
    const index = slotIndexRef.current;
    slotIndexRef.current = -1;
    if (!file || index < 0) return;
    if (!file.type.startsWith("image/")) {
      message.error("请选择图片文件");
      return;
    }
    try {
      const stored = await uploadWithToast(file, { label: "原图" });
      setSlots((prev) => {
        const next = [...prev];
        if (index < next.length) {
          next[index] = { seedKey: stored.storageKey, seedUrl: stored.url, fileName: file.name };
        }
        return next;
      });
    } catch {
      // uploader 已弹错
    }
  };

  const clearSlot = (index: number) => {
    setSlots((prev) => {
      const next = [...prev];
      if (index < next.length) {
        next[index] = { seedKey: "", seedUrl: "", fileName: "" };
      }
      return next;
    });
  };

  const allFilled = !!selectedTemplate && slots.length === selectedTemplate.itemCount && slots.every((slot) => slot.seedKey);

  const createMutation = useMutation({
    mutationFn: () =>
      createMyPipelineBatchFromTemplate(token, {
        templateId,
        seedKeys: slots.map((slot) => slot.seedKey),
        name: batchName.trim() || undefined,
      }),
    onSuccess: (detail) => {
      message.success("批量任务已启动");
      onCreated(detail);
      onClose();
    },
    onError: (error) => {
      message.error(error instanceof Error ? error.message : "启动失败");
    },
  });

  const handleStart = () => {
    if (!selectedTemplate) {
      message.warning("请选择批处理模板");
      return;
    }
    if (!allFilled) {
      message.warning(`还有 ${slots.filter((slot) => !slot.seedKey).length} 张图没上传`);
      return;
    }
    createMutation.mutate();
  };

  const templateOptions = templates.map((template) => ({
    label: `${template.name} · ${template.itemCount} 条主条${template.post ? " · 含后处理" : ""}`,
    value: template.id,
  }));

  return (
    <Modal
      title="选择批处理模板"
      open={open}
      width={680}
      maskClosable={false}
      onCancel={onClose}
      footer={(
        <div className="flex justify-end gap-2">
          <Button onClick={onClose} disabled={createMutation.isPending}>取消</Button>
          <Button
            type="primary"
            icon={<Play className="size-4" />}
            loading={createMutation.isPending}
            onClick={handleStart}
            disabled={!allFilled}
          >
            启动批量任务
          </Button>
        </div>
      )}
      destroyOnHidden
    >
      <div className="flex max-h-[70vh] flex-col gap-4 overflow-y-auto pr-1">
        {templates.length === 0 ? (
          <div className="rounded border border-dashed border-stone-300 p-4 text-center text-sm text-stone-500 dark:border-stone-700">
            还没有任何批处理模板。请先在「批处理模板」管理里新建一个。
          </div>
        ) : (
          <>
            <div>
              <label className="mb-1 block text-sm font-semibold text-stone-700 dark:text-stone-200">选择模板</label>
              <Select
                value={templateId || undefined}
                options={templateOptions}
                onChange={setTemplateId}
                placeholder="选择批处理模板"
                className="!w-full"
              />
            </div>

            {selectedTemplate ? (
              <section className="rounded-md border border-stone-200 bg-stone-50 p-3 dark:border-stone-800 dark:bg-stone-900/40">
                <div className="mb-2 text-xs font-semibold text-stone-600 dark:text-stone-300">模板预览</div>
                <div className="flex flex-col gap-1 text-xs text-stone-600 dark:text-stone-300">
                  <div>主条数：{selectedTemplate.itemCount}</div>
                  {selectedTemplate.items.map((entry, index) => {
                    // 这里 templates 是父层传进来的，pipeline 名要让父层查；为简化前端，直接展示 pipelineId
                    // 配合「失效检查由后端处理」的策略，UI 上不强制做命名解析
                    return (
                      <div key={`${entry.pipelineId}-${index}`} className="flex items-center gap-1">
                        <span className="text-stone-400">主条 {index + 1}：</span>
                        <span className="font-medium text-stone-700 dark:text-stone-200">{entry.name || `主条 ${index + 1}`}</span>
                      </div>
                    );
                  })}
                  <div>
                    后处理：
                    {selectedTemplate.post ? (
                      <Tag color="green" className="!ml-1 !mr-0">启用</Tag>
                    ) : (
                      <Tag className="!ml-1 !mr-0">未启用</Tag>
                    )}
                  </div>
                  {selectedTemplate.post ? (
                    <>
                      <div>
                        <span className="text-stone-400">Sources：</span>
                        <span>
                          {selectedTemplate.post.sources
                            .map((entry) =>
                              entry.stepIndex < 0
                                ? `主条 ${entry.itemIndex + 1} · Seed`
                                : `主条 ${entry.itemIndex + 1} · 步 ${entry.stepIndex + 1}`,
                            )
                            .join(" / ")}
                        </span>
                      </div>
                      <div>
                        <span className="text-stone-400">角色数：</span>
                        <span>{selectedTemplate.post.agentIds.length} 个</span>
                      </div>
                    </>
                  ) : null}
                </div>
              </section>
            ) : null}

            {selectedTemplate ? (
              <section>
                <div className="mb-2 flex items-center justify-between">
                  <h4 className="text-sm font-semibold text-stone-700 dark:text-stone-200">
                    按顺序上传 {selectedTemplate.itemCount} 张图
                  </h4>
                  <span className="text-xs text-stone-500">
                    已上传 {slots.filter((slot) => slot.seedKey).length} / {selectedTemplate.itemCount}
                  </span>
                </div>
                <div className="grid grid-cols-3 gap-3 sm:grid-cols-4">
                  {slots.map((slot, index) => {
                    const item = selectedTemplate.items[index];
                    return (
                      <div key={index} className="flex flex-col gap-1">
                        {slot.seedKey ? (
                          <div className="group relative aspect-square overflow-hidden rounded-md border border-stone-200 bg-stone-50 dark:border-stone-800 dark:bg-stone-900">
                            <img src={slot.seedUrl} alt={slot.fileName} className="size-full object-cover" />
                            <button
                              type="button"
                              className="absolute right-1 top-1 grid size-5 place-items-center rounded bg-black/60 text-white opacity-0 transition group-hover:opacity-100 hover:bg-black/80"
                              onClick={() => clearSlot(index)}
                              aria-label="移除图片"
                            >
                              <X className="size-3" />
                            </button>
                          </div>
                        ) : (
                          <button
                            type="button"
                            className="flex aspect-square flex-col items-center justify-center gap-1 rounded-md border-2 border-dashed border-stone-300 text-stone-500 transition hover:border-blue-500 hover:text-blue-600 dark:border-stone-700"
                            onClick={() => triggerPickFor(index)}
                          >
                            <ImagePlus className="size-6" />
                            <span className="text-xs">上传</span>
                          </button>
                        )}
                        <div className="truncate text-[11px] text-stone-500 dark:text-stone-400" title={item?.name}>
                          主条 {index + 1}: {item?.name || `主条 ${index + 1}`}
                        </div>
                      </div>
                    );
                  })}
                </div>
                <input
                  ref={fileInputRef}
                  type="file"
                  accept="image/*"
                  style={{ display: "none" }}
                  tabIndex={-1}
                  aria-hidden
                  onChange={(event) => void handlePickFile(event)}
                />
              </section>
            ) : null}

            <section>
              <label className="mb-1 block text-sm font-semibold text-stone-700 dark:text-stone-200">批量任务名（可选）</label>
              <Input
                placeholder="留空将自动用日期命名"
                value={batchName}
                onChange={(event) => setBatchName(event.target.value)}
                maxLength={30}
              />
            </section>

            <Typography.Text type="secondary" className="!text-xs">
              如果模板里的流水线或角色已经被删除，启动时后端会校验失败，需要回到模板里替换后再来。
            </Typography.Text>
          </>
        )}
      </div>
    </Modal>
  );
}
