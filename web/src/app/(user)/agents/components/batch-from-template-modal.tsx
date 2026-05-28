"use client";

import { ImagePlus, Play, Upload, X } from "lucide-react";
import { App, Button, Input, Modal, Select, Tag, Typography } from "antd";
import { useEffect, useMemo, useRef, useState, type ChangeEvent, type DragEvent as ReactDragEvent } from "react";
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
  const [dragHighlight, setDragHighlight] = useState(false);
  const [bulkUploading, setBulkUploading] = useState(false);

  // 单槽位「替换」用：点 + 时记下来 index，input.click() 后 onChange 拿到 index 改单张
  const slotIndexRef = useRef<number>(-1);
  // 共两个隐藏 input：一个 multiple 全量上传，一个 single 单槽替换
  const singleInputRef = useRef<HTMLInputElement>(null);
  const multiInputRef = useRef<HTMLInputElement>(null);

  const selectedTemplate = useMemo(
    () => templates.find((template) => template.id === templateId) || null,
    [templates, templateId],
  );

  // 切换 / 关闭时重置
  useEffect(() => {
    if (!open) {
      setTemplateId("");
      setSlots([]);
      setBatchName("");
      setBulkUploading(false);
      setDragHighlight(false);
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

  // 单槽替换
  const triggerPickFor = (index: number) => {
    slotIndexRef.current = index;
    singleInputRef.current?.click();
  };

  const handlePickSingle = async (event: ChangeEvent<HTMLInputElement>) => {
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

  // 批量上传 / 拖入：按上传顺序填到空槽位；如果选了 N 张但只有 M 个空槽（N > M），
  // 仍按顺序填前 M 张，多余的 toast 警告。已经有图的槽位不动（用户手动点单槽 × 移除后再来）。
  const assignFilesToEmptySlots = async (files: File[]) => {
    if (!selectedTemplate) {
      message.warning("请先选择批处理模板");
      return;
    }
    const images = files.filter((f) => f.type.startsWith("image/"));
    if (images.length === 0) {
      if (files.length) message.error("没有有效的图片文件");
      return;
    }
    const emptyIndices: number[] = [];
    for (let i = 0; i < slots.length; i += 1) {
      if (!slots[i].seedKey) emptyIndices.push(i);
    }
    if (emptyIndices.length === 0) {
      message.warning("所有槽位都已上传，请先在某个槽位点 × 移除");
      return;
    }
    const toUpload = images.slice(0, emptyIndices.length);
    if (images.length > emptyIndices.length) {
      message.warning(`只填了前 ${emptyIndices.length} 张到空槽位，剩余 ${images.length - emptyIndices.length} 张被忽略`);
    }
    setBulkUploading(true);
    try {
      const uploaded = await Promise.all(
        toUpload.map(async (file) => {
          try {
            const stored = await uploadWithToast(file, { label: "原图" });
            return { stored, file };
          } catch {
            return null;
          }
        }),
      );
      setSlots((prev) => {
        const next = [...prev];
        uploaded.forEach((result, i) => {
          if (!result) return;
          const slotIdx = emptyIndices[i];
          if (slotIdx === undefined) return;
          next[slotIdx] = {
            seedKey: result.stored.storageKey,
            seedUrl: result.stored.url,
            fileName: result.file.name,
          };
        });
        return next;
      });
    } finally {
      setBulkUploading(false);
    }
  };

  const triggerPickAll = () => {
    multiInputRef.current?.click();
  };

  const handlePickMulti = async (event: ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(event.target.files || []);
    event.target.value = "";
    if (files.length === 0) return;
    await assignFilesToEmptySlots(files);
  };

  // 拖拽
  const handleDragOver = (event: ReactDragEvent<HTMLDivElement>) => {
    if (!selectedTemplate) return;
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
    const files = Array.from(event.dataTransfer.files || []);
    void assignFilesToEmptySlots(files);
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

  const clearAll = () => {
    setSlots((prev) => prev.map(() => ({ seedKey: "", seedUrl: "", fileName: "" })));
  };

  const allFilled = !!selectedTemplate && slots.length === selectedTemplate.itemCount && slots.every((slot) => slot.seedKey);
  const filledCount = slots.filter((slot) => slot.seedKey).length;

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
      width={780}
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
                  {selectedTemplate.items.map((entry, index) => (
                    <div key={`${entry.pipelineId}-${index}`} className="flex items-center gap-1">
                      <span className="text-stone-400">主条 {index + 1}：</span>
                      <span className="font-medium text-stone-700 dark:text-stone-200">{entry.name || `主条 ${index + 1}`}</span>
                    </div>
                  ))}
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
                <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
                  <h4 className="text-sm font-semibold text-stone-700 dark:text-stone-200">
                    按顺序上传 {selectedTemplate.itemCount} 张图
                  </h4>
                  <div className="flex items-center gap-2 text-xs text-stone-500">
                    <span>已上传 {filledCount} / {selectedTemplate.itemCount}</span>
                    {filledCount > 0 ? (
                      <Button size="small" type="text" onClick={clearAll}>全部清空</Button>
                    ) : null}
                  </div>
                </div>

                {/* 批量上传 / 拖入区：可一次选多张 / 拖一组进来，按顺序填到空槽。 */}
                <div
                  className={`mb-3 flex flex-col items-center gap-1 rounded-md border-2 border-dashed p-3 text-center transition-colors ${dragHighlight ? "border-blue-500 bg-blue-50/40 dark:border-blue-400 dark:bg-blue-500/10" : "border-stone-300 dark:border-stone-700"}`}
                  onDragOver={handleDragOver}
                  onDragLeave={handleDragLeave}
                  onDrop={handleDrop}
                >
                  <Upload className="size-5 text-stone-400" />
                  <div className="text-xs text-stone-600 dark:text-stone-300">
                    {dragHighlight
                      ? `松开以填充剩余空槽位（最多 ${selectedTemplate.itemCount - filledCount} 张）`
                      : `点「批量上传」或把图拖到这里，按顺序填到剩余空槽位`}
                  </div>
                  <div className="mt-1 flex gap-2">
                    <Button
                      size="small"
                      icon={<Upload className="size-3.5" />}
                      onClick={triggerPickAll}
                      loading={bulkUploading}
                      disabled={filledCount >= selectedTemplate.itemCount}
                    >
                      批量上传
                    </Button>
                  </div>
                </div>

                {/* 各槽位预览 */}
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
                {/* 两个隐藏 input：multiple（批量）+ single（单槽替换） */}
                <input
                  ref={multiInputRef}
                  type="file"
                  accept="image/*"
                  multiple
                  style={{ display: "none" }}
                  tabIndex={-1}
                  aria-hidden
                  onChange={(event) => void handlePickMulti(event)}
                />
                <input
                  ref={singleInputRef}
                  type="file"
                  accept="image/*"
                  style={{ display: "none" }}
                  tabIndex={-1}
                  aria-hidden
                  onChange={(event) => void handlePickSingle(event)}
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
