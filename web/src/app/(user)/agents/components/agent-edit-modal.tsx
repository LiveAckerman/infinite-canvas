"use client";

import { ClipboardPaste, Image as ImageIcon, Plus, Trash2, Upload } from "lucide-react";
import { App, AutoComplete, Button, Form, Image, Input, Modal, Select } from "antd";
import { useEffect, useRef, useState, type ClipboardEvent as ReactClipboardEvent, type DragEvent as ReactDragEvent } from "react";

import { useImageUploader } from "@/lib/use-image-uploader";
import { imageUrl } from "@/services/image-storage";
import { PromptImproveBar } from "@/components/prompt-improve-panel";
import type { Agent } from "@/services/api/agents";

import { AgentAvatar } from "./agent-avatar";

const MAX_REFERENCE_IMAGES = 3;

type AgentFormValues = {
  name: string;
  description?: string;
  systemPrompt: string;
  defaultSize?: string;
  defaultQuality?: string;
  avatarUrl?: string;
  referenceImageKeys?: string[];
};

type AgentEditModalProps = {
  open: boolean;
  editing: Agent | null;
  onClose: () => void;
  onSubmit: (values: AgentFormValues) => Promise<void> | void;
  submitting?: boolean;
};

// 跟 /image 工作台保持一致的选项，避免心智割裂。
const sizeOptions = ["auto", "1:1", "3:2", "2:3", "4:3", "3:4", "16:9", "9:16"].map((value) => ({ label: value, value }));
const qualityOptions = ["auto", "low", "medium", "high"].map((value) => ({ label: value, value }));

export function AgentEditModal({ open, editing, onClose, onSubmit, submitting }: AgentEditModalProps) {
  const { message } = App.useApp();
  const [form] = Form.useForm<AgentFormValues>();
  const uploadWithToast = useImageUploader();
  const fileInputRef = useRef<HTMLInputElement>(null);
  // 全局共用一个隐藏的参考图 file input：上一次点哪个槽位（添加 / 替换），就把
  // index 存进 refSlotIndexRef，input 的 onChange 拿到 index 写回 form。
  // 这样既避免渲染多份 input 露出原生「选择文件 未选择…」UI，也省得每个槽位重写一遍 ref。
  const refFileInputRef = useRef<HTMLInputElement>(null);
  const refSlotIndexRef = useRef<number>(-1);
  // 拖拽 / 粘贴时给参考图区域加蓝色高亮；离开 / 松手清掉。
  const [refDragHighlight, setRefDragHighlight] = useState(false);

  useEffect(() => {
    if (!open) return;
    form.setFieldsValue({
      name: editing?.name || "",
      description: editing?.description || "",
      systemPrompt: editing?.systemPrompt || "",
      defaultSize: editing?.defaultSize || "auto",
      defaultQuality: editing?.defaultQuality || "auto",
      avatarUrl: editing?.avatarUrl || "",
      referenceImageKeys: editing?.referenceImageKeys || [],
    });
  }, [open, editing, form]);

  const handleAvatarPick = async (file?: File | null) => {
    if (!file) return;
    if (!file.type.startsWith("image/")) {
      message.error("请上传图片格式的头像");
      return;
    }
    try {
      const result = await uploadWithToast(file, { label: "角色头像" });
      // 注意：uploadImage 返回的 result.url 是 ObjectURL，仅当前会话有效，落库后刷新就 404。
      // 这里统一存「/api/images/{storageKey}」的服务端直链，保证跨会话 / 跨浏览器都能加载。
      form.setFieldValue("avatarUrl", imageUrl(result.storageKey));
    } catch {
      // useImageUploader 已经弹错误 toast
    }
  };

  // 打开 file picker：传入 index，添加一张就用 current.length，替换某张就用对应 index。
  const openReferencePicker = (index: number) => {
    refSlotIndexRef.current = index;
    refFileInputRef.current?.click();
  };

  // 设置 / 替换某个 index 上的参考图：
  //   - index 等于现有长度时，等于「新增一张」追加
  //   - index < 长度时，等于「替换那一张」
  const handleReferenceSlot = async (index: number, file?: File | null) => {
    if (!file) return;
    if (!file.type.startsWith("image/")) {
      message.error("请上传图片文件");
      return;
    }
    const current: string[] = form.getFieldValue("referenceImageKeys") || [];
    if (index >= MAX_REFERENCE_IMAGES) return;
    try {
      const result = await uploadWithToast(file, { label: "参考图" });
      const next = [...current];
      next[index] = result.storageKey;
      // 去空 + 截断到上限，避免出现非连续空槽
      form.setFieldValue("referenceImageKeys", next.filter(Boolean).slice(0, MAX_REFERENCE_IMAGES));
    } catch {
      // useImageUploader 已弹错误
    }
  };

  const removeReference = (index: number) => {
    const current: string[] = form.getFieldValue("referenceImageKeys") || [];
    form.setFieldValue("referenceImageKeys", current.filter((_, idx) => idx !== index));
  };

  // 批量追加：拖入 / 粘贴可能同时给多张图，按顺序填到剩余槽位（超过最大数的丢弃 + toast 提示）。
  // 单张失败只跳过那一张，跟 /image 工作台的 addReferencesFromBlobs 一致。
  const appendReferenceFiles = async (files: File[]) => {
    const images = files.filter((file) => file.type.startsWith("image/"));
    if (!images.length) {
      if (files.length) message.error("不是图片，已忽略");
      return;
    }
    const current: string[] = form.getFieldValue("referenceImageKeys") || [];
    const remain = Math.max(0, MAX_REFERENCE_IMAGES - current.length);
    if (remain <= 0) {
      message.error(`参考图最多 ${MAX_REFERENCE_IMAGES} 张`);
      return;
    }
    if (images.length > remain) {
      message.warning(`只追加 ${remain} 张，剩余 ${images.length - remain} 张超过上限被丢弃`);
    }
    const toUpload = images.slice(0, remain);
    const uploaded = await Promise.all(toUpload.map(async (file) => {
      try {
        const result = await uploadWithToast(file, { label: "参考图" });
        return result.storageKey;
      } catch {
        return null;
      }
    }));
    const additions = uploaded.filter((key): key is string => Boolean(key));
    if (additions.length) {
      form.setFieldValue("referenceImageKeys", [...current, ...additions].slice(0, MAX_REFERENCE_IMAGES));
    }
  };

  // 拖入：只有 dataTransfer.types 含 "Files" 才高亮，避免文本拖动也变蓝。
  const handleRefDragOver = (event: ReactDragEvent<HTMLDivElement>) => {
    if (!Array.from(event.dataTransfer.types).includes("Files")) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = "copy";
    setRefDragHighlight(true);
  };
  const handleRefDragLeave = (event: ReactDragEvent<HTMLDivElement>) => {
    if (event.currentTarget.contains(event.relatedTarget as Node | null)) return;
    setRefDragHighlight(false);
  };
  const handleRefDrop = (event: ReactDragEvent<HTMLDivElement>) => {
    event.preventDefault();
    setRefDragHighlight(false);
    const files = Array.from(event.dataTransfer.files || []);
    void appendReferenceFiles(files);
  };

  // 在参考图区域里 Ctrl/Cmd+V 粘贴：拦截 clipboardData.items 里的图片项，
  // 不阻止其它内容的默认粘贴行为，只在出现图片时 preventDefault。
  const handleRefPaste = (event: ReactClipboardEvent<HTMLDivElement>) => {
    const items = Array.from(event.clipboardData?.items || []);
    const files = items
      .filter((item) => item.kind === "file" && item.type.startsWith("image/"))
      .map((item) => item.getAsFile())
      .filter((file): file is File => file !== null);
    if (!files.length) return;
    event.preventDefault();
    void appendReferenceFiles(files);
  };

  // 「读取剪切板」按钮：用 Clipboard API（要 HTTPS / localhost），跟 /image 工作台一致。
  const handleRefClipboardButton = async () => {
    try {
      const items = await navigator.clipboard.read();
      const blobs: File[] = [];
      for (const item of items) {
        for (const type of item.types) {
          if (!type.startsWith("image/")) continue;
          const blob = await item.getType(type);
          blobs.push(new File([blob], `clipboard-${Date.now()}-${blobs.length}.png`, { type }));
        }
      }
      if (!blobs.length) {
        message.error("剪切板里没有可读取的图片");
        return;
      }
      await appendReferenceFiles(blobs);
    } catch {
      message.error("剪切板里没有可读取的图片");
    }
  };

  const submit = async () => {
    const values = await form.validateFields();
    await onSubmit(values);
  };

  const watchedName = Form.useWatch("name", form) || "";
  const watchedAvatar = Form.useWatch("avatarUrl", form) || "";
  const watchedReferenceKeys: string[] = Form.useWatch("referenceImageKeys", form) || [];

  return (
    <Modal
      title={editing ? "编辑角色" : "新建角色"}
      open={open}
      onCancel={onClose}
      onOk={() => void submit()}
      okText="保存"
      cancelText="取消"
      confirmLoading={submitting}
      width={640}
      destroyOnHidden
    >
      <Form form={form} layout="vertical" requiredMark={false} className="mt-3">
        <Form.Item label="头像">
          <div className="flex items-center gap-3">
            <AgentAvatar name={watchedName} avatarUrl={watchedAvatar} size={56} />
            <div className="flex flex-col gap-1">
              <div className="flex gap-2">
                <Button size="small" icon={<Upload className="size-3.5" />} onClick={() => fileInputRef.current?.click()}>上传头像</Button>
                {watchedAvatar ? (
                  <Button size="small" type="text" onClick={() => form.setFieldValue("avatarUrl", "")}>用名字首字</Button>
                ) : null}
              </div>
              <span className="text-xs text-stone-500 dark:text-stone-400">不上传则用名字首字 + 自动配色作为头像</span>
            </div>
            <input
              ref={fileInputRef}
              type="file"
              accept="image/*"
              className="hidden"
              onChange={(event) => {
                void handleAvatarPick(event.target.files?.[0]);
                event.target.value = "";
              }}
            />
          </div>
        </Form.Item>
        <Form.Item name="avatarUrl" hidden><Input /></Form.Item>
        <Form.Item name="name" label="角色名" rules={[{ required: true, message: "请输入角色名" }, { max: 20, message: "角色名最多 20 个字" }]}>
          <Input placeholder="例如：白底图工人" />
        </Form.Item>
        <Form.Item name="description" label="角色描述（一行）" rules={[{ max: 80, message: "描述最多 80 个字" }]}>
          <Input placeholder="可写：能做什么、效果特点、适用场景" />
        </Form.Item>
        <Form.Item
          name="systemPrompt"
          label="系统提示词"
          rules={[{ required: true, message: "请输入系统提示词" }, { max: 4000, message: "最多 4000 字" }]}
          extra="工作台调用这个角色时会自动作为提示词使用，用户每次只需要上传图片，无需重复写提示词。"
        >
          <Input.TextArea rows={6} placeholder="例如：你是一个商品白底图大师，请抠出主体并将背景换成纯白色，保持原始光影与细节。" />
        </Form.Item>
        {/* 跟 /image 工作台一致的「提示词优化」入口；读 form 当前值，接受后 setFieldsValue 写回 */}
        <PromptImproveBar
          className="-mt-2 mb-4"
          getPrompt={() => form.getFieldValue("systemPrompt") || ""}
          onAccept={(improved) => form.setFieldsValue({ systemPrompt: improved })}
          disabled={submitting}
        />
        <Form.Item
          label={(
            <div className="flex w-full items-center justify-between gap-3">
              <span>参考图（可选，最多 {MAX_REFERENCE_IMAGES} 张）</span>
              <Button
                size="small"
                icon={<ClipboardPaste className="size-3.5" />}
                onClick={() => void handleRefClipboardButton()}
                disabled={watchedReferenceKeys.length >= MAX_REFERENCE_IMAGES}
              >
                读取剪切板
              </Button>
            </div>
          )}
          extra="不传也可以；如果加了，每次该角色生图都会和你在工作台上传的图一起作为参考。常用于「按这种风格 / 构图来」类的角色。支持拖入 / 粘贴 / 剪切板 / 点击四种方式，可一次加多张。"
        >
          {/* 整个参考图区域包一层 drop / paste 容器：拖入 / Ctrl-V 都能批量追加 */}
          <div
            tabIndex={0}
            onPaste={handleRefPaste}
            onDragOver={handleRefDragOver}
            onDragLeave={handleRefDragLeave}
            onDrop={handleRefDrop}
            className={`relative flex flex-wrap items-start gap-3 rounded-md p-2 transition-colors ${refDragHighlight ? "bg-blue-50/60 outline outline-2 outline-blue-400 dark:bg-blue-500/10 dark:outline-blue-500" : ""}`}
          >
            {watchedReferenceKeys.map((key, index) => (
              <div key={`${index}-${key}`} className="group relative size-[104px] overflow-hidden rounded-md border border-stone-200 dark:border-stone-800">
                <Image
                  src={imageUrl(key)}
                  alt={`参考图 ${index + 1}`}
                  width={104}
                  height={104}
                  className="!size-[104px] object-cover"
                  preview={{ mask: "查看" }}
                />
                <div className="absolute inset-x-0 bottom-0 hidden items-center justify-end gap-1 bg-gradient-to-t from-black/70 to-transparent p-1.5 group-hover:flex">
                  <Button size="small" icon={<Upload className="size-3" />} onClick={() => openReferencePicker(index)}>换</Button>
                  <Button size="small" type="primary" danger icon={<Trash2 className="size-3" />} onClick={() => removeReference(index)}>删</Button>
                </div>
              </div>
            ))}
            {watchedReferenceKeys.length < MAX_REFERENCE_IMAGES ? (
              <button
                type="button"
                onClick={() => openReferencePicker(watchedReferenceKeys.length)}
                className="grid size-[104px] place-items-center rounded-md border border-dashed border-stone-300 bg-stone-50 text-stone-500 transition hover:border-blue-400 hover:text-blue-500 dark:border-stone-700 dark:bg-stone-900 dark:text-stone-400"
              >
                <div className="flex flex-col items-center gap-1">
                  <Plus className="size-5" />
                  <span className="text-xs">添加参考图</span>
                </div>
              </button>
            ) : null}
            {watchedReferenceKeys.length === 0 ? (
              <div className="flex h-[104px] items-center text-xs text-stone-500 dark:text-stone-400">
                <ImageIcon className="mr-1 size-3.5" />
                <span>{refDragHighlight ? "松开以添加参考图" : "没有参考图也能生成，调用时只走你在工作台上传的图"}</span>
              </div>
            ) : null}
            {refDragHighlight && watchedReferenceKeys.length > 0 ? (
              <div className="pointer-events-none absolute inset-0 flex items-center justify-center rounded-md bg-blue-500/5 text-sm font-medium text-blue-600 dark:text-blue-300">
                松开以添加参考图
              </div>
            ) : null}
          </div>
        </Form.Item>
        <Form.Item name="referenceImageKeys" hidden>
          <Input />
        </Form.Item>
        <input
          ref={refFileInputRef}
          type="file"
          accept="image/*"
          style={{ display: "none" }}
          tabIndex={-1}
          aria-hidden
          onChange={(event) => {
            const index = refSlotIndexRef.current;
            refSlotIndexRef.current = -1;
            if (index >= 0) void handleReferenceSlot(index, event.target.files?.[0]);
            event.target.value = "";
          }}
        />
        <div className="grid grid-cols-2 gap-3">
          <Form.Item name="defaultSize" label="默认尺寸">
            <AutoComplete options={sizeOptions} placeholder="auto" />
          </Form.Item>
          <Form.Item name="defaultQuality" label="默认质量">
            <Select options={qualityOptions} />
          </Form.Item>
        </div>
      </Form>
    </Modal>
  );
}

export type { AgentFormValues };
