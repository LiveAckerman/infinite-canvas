"use client";

import { ClipboardPaste, Image as ImageIcon, Plus, Trash2, Upload } from "lucide-react";
import { App, Button, Image } from "antd";
import { useRef, useState, type ClipboardEvent as ReactClipboardEvent, type DragEvent as ReactDragEvent, type ReactNode } from "react";

import { COMPRESS_HINT_TEXT } from "@/lib/compress-image";
import { useImageUploader } from "@/lib/use-image-uploader";
import { imageUrl } from "@/services/image-storage";

type ReferenceImagesFieldProps = {
  // 当前参考图 storageKey 列表（受控）。
  value: string[];
  // 列表变化（添加 / 替换 / 删除）时回调，给出新的完整数组。
  onChange: (keys: string[]) => void;
  // 最多几张，默认 9（gpt-image 系列模型 /v1/images/edits 的上限）。
  max?: number;
  // 禁用全部交互（生成中等）。
  disabled?: boolean;
  // 上传时 toast 用的名字，默认「参考图」（卡片里可传「原图」）。
  label?: string;
  // 右上角是否显示「读取剪切板」按钮，默认显示。
  showClipboardButton?: boolean;
  // 头部左侧标题；不传则头部只剩右侧按钮，标题与按钮都没有时整行不渲染。
  title?: ReactNode;
  // 一张图都没有时，挨着「添加」块显示的占位文案。
  emptyText?: string;
  // 缩略图边长（px），默认 104。
  thumbSize?: number;
  // 是否在底部显示「会自动压缩」常驻提示，默认显示。Form.Item 已经有 extra 写了说明时可关掉避免重复。
  showCompressHint?: boolean;
  className?: string;
};

// 参考图上传公共组件：storageKey 数组进出，内部统一处理「上传 / 剪切板 / 粘贴 / 拖拽」四种添加方式，
// 槽位支持换 / 删，按 max 截断。/agents 的角色编辑（固定参考图，max 3）和并行工作台卡片（原图，max 9）共用。
// 设计上只认 storageKey（已落库的图），不掺 ObjectURL / canvas 截图那套，保持简单；/image 工作台另有自己的实现不在此列。
export function ReferenceImagesField({
  value,
  onChange,
  max = 9,
  disabled = false,
  label = "参考图",
  showClipboardButton = true,
  title,
  emptyText,
  thumbSize = 104,
  showCompressHint = true,
  className = "",
}: ReferenceImagesFieldProps) {
  const { message } = App.useApp();
  const uploadWithToast = useImageUploader();
  // 全局共用一个隐藏 file input：点哪个槽位（添加 / 替换）就把 index 存进 slotIndexRef，
  // onChange 时拿出来写回对应位置。避免渲染多份原生「选择文件」UI。
  const fileInputRef = useRef<HTMLInputElement>(null);
  const slotIndexRef = useRef<number>(-1);
  const [dragHighlight, setDragHighlight] = useState(false);

  const reachedMax = value.length >= max;

  const openPicker = (index: number) => {
    if (disabled) return;
    slotIndexRef.current = index;
    fileInputRef.current?.click();
  };

  // 替换 / 追加单张：index === value.length 视为追加，否则替换该槽位。
  const handleSlot = async (index: number, file?: File | null) => {
    if (!file) return;
    if (!file.type.startsWith("image/")) {
      message.error("请选择图片文件");
      return;
    }
    if (index >= max) return;
    try {
      const result = await uploadWithToast(file, { label });
      const next = [...value];
      next[index] = result.storageKey;
      onChange(next.filter(Boolean).slice(0, max));
    } catch {
      // useImageUploader 已经弹错误 toast
    }
  };

  // 批量追加：拖入 / 粘贴 / 剪切板可能同时给多张，按顺序填到剩余槽位，超出 max 的丢弃 + 提示。
  // 单张失败只跳过那一张（Promise.all 不互相阻断）。
  const appendFiles = async (files: File[]) => {
    const images = files.filter((file) => file.type.startsWith("image/"));
    if (!images.length) {
      if (files.length) message.error("不是图片，已忽略");
      return;
    }
    const remain = Math.max(0, max - value.length);
    if (remain <= 0) {
      message.error(`${label}最多 ${max} 张`);
      return;
    }
    if (images.length > remain) {
      message.warning(`只追加 ${remain} 张，剩余 ${images.length - remain} 张超过上限被丢弃`);
    }
    const toUpload = images.slice(0, remain);
    const uploaded = await Promise.all(
      toUpload.map(async (file) => {
        try {
          const result = await uploadWithToast(file, { label });
          return result.storageKey;
        } catch {
          return null;
        }
      }),
    );
    const additions = uploaded.filter((key): key is string => Boolean(key));
    if (additions.length) onChange([...value, ...additions].slice(0, max));
  };

  const removeAt = (index: number) => {
    onChange(value.filter((_, idx) => idx !== index));
  };

  // 拖入：只有 dataTransfer.types 含 "Files" 才高亮，避免拖文本也变蓝。
  const handleDragOver = (event: ReactDragEvent<HTMLDivElement>) => {
    if (disabled) return;
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
    if (disabled) return;
    event.preventDefault();
    setDragHighlight(false);
    void appendFiles(Array.from(event.dataTransfer.files || []));
  };

  // 容器内 Ctrl/Cmd+V：只在出现图片项时 preventDefault，不影响其它内容粘贴。
  const handlePaste = (event: ReactClipboardEvent<HTMLDivElement>) => {
    if (disabled) return;
    const files = Array.from(event.clipboardData?.items || [])
      .filter((item) => item.kind === "file" && item.type.startsWith("image/"))
      .map((item) => item.getAsFile())
      .filter((file): file is File => file !== null);
    if (!files.length) return;
    event.preventDefault();
    void appendFiles(files);
  };

  // 「读取剪切板」按钮：走 Clipboard API（需 HTTPS / localhost）。
  const handleClipboardButton = async () => {
    try {
      const items = await navigator.clipboard.read();
      const blobs: File[] = [];
      for (const item of items) {
        for (const type of item.types) {
          if (!type.startsWith("image/")) continue;
          const blob = await item.getType(type);
          blobs.push(new File([blob], `clipboard-${blobs.length}.png`, { type }));
        }
      }
      if (!blobs.length) {
        message.error("剪切板里没有可读取的图片");
        return;
      }
      await appendFiles(blobs);
    } catch {
      message.error("剪切板里没有可读取的图片");
    }
  };

  const sizeStyle = { width: thumbSize, height: thumbSize };

  return (
    <div className={className}>
      {(title || showClipboardButton) && (
        <div className="mb-2 flex items-center justify-between gap-3">
          <span className="min-w-0 truncate text-sm text-stone-600 dark:text-stone-300">{title}</span>
          {showClipboardButton ? (
            <Button
              size="small"
              icon={<ClipboardPaste className="size-3.5" />}
              onClick={() => void handleClipboardButton()}
              disabled={disabled || reachedMax}
            >
              读取剪切板
            </Button>
          ) : <span />}
        </div>
      )}

      <div
        tabIndex={0}
        onPaste={handlePaste}
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
        onDrop={handleDrop}
        className={`relative flex flex-wrap items-start gap-3 rounded-md p-2 transition-colors ${dragHighlight ? "bg-blue-50/60 outline outline-2 outline-blue-400 dark:bg-blue-500/10 dark:outline-blue-500" : ""}`}
      >
        <Image.PreviewGroup>
          {value.map((key, index) => (
            <div
              key={`${index}-${key}`}
              className="group relative overflow-hidden rounded-md border border-stone-200 dark:border-stone-800"
              style={sizeStyle}
            >
              <Image
                src={imageUrl(key)}
                alt={`${label} ${index + 1}`}
                width={thumbSize}
                height={thumbSize}
                className="object-cover"
                style={sizeStyle}
                preview={{ mask: "查看" }}
              />
              {!disabled ? (
                <div className="absolute inset-x-0 bottom-0 hidden items-center justify-end gap-1 bg-gradient-to-t from-black/70 to-transparent p-1.5 group-hover:flex">
                  <Button size="small" icon={<Upload className="size-3" />} onClick={() => openPicker(index)}>换</Button>
                  <Button size="small" type="primary" danger icon={<Trash2 className="size-3" />} onClick={() => removeAt(index)}>删</Button>
                </div>
              ) : null}
            </div>
          ))}
        </Image.PreviewGroup>

        {!reachedMax && !disabled ? (
          <button
            type="button"
            onClick={() => openPicker(value.length)}
            className="grid place-items-center rounded-md border border-dashed border-stone-300 bg-stone-50 text-stone-500 transition hover:border-blue-400 hover:text-blue-500 dark:border-stone-700 dark:bg-stone-900 dark:text-stone-400"
            style={sizeStyle}
          >
            <div className="flex flex-col items-center gap-1">
              <Plus className="size-5" />
              <span className="text-xs">添加{label}</span>
            </div>
          </button>
        ) : null}

        {value.length === 0 && emptyText ? (
          <div className="flex items-center text-xs text-stone-500 dark:text-stone-400" style={{ height: thumbSize }}>
            <ImageIcon className="mr-1 size-3.5 shrink-0" />
            <span>{dragHighlight ? "松开以添加" : emptyText}</span>
          </div>
        ) : null}

        {dragHighlight && value.length > 0 ? (
          <div className="pointer-events-none absolute inset-0 flex items-center justify-center rounded-md bg-blue-500/5 text-sm font-medium text-blue-600 dark:text-blue-300">
            松开以添加{label}
          </div>
        ) : null}
      </div>

      {showCompressHint ? (
        // 让用户明确知道大图会被自动压缩，放心传清晰度高的原图，不用担心传太大被拒
        <div className="mt-1.5 text-xs text-stone-500 dark:text-stone-400">{COMPRESS_HINT_TEXT}</div>
      ) : null}

      <input
        ref={fileInputRef}
        type="file"
        accept="image/*"
        multiple
        style={{ display: "none" }}
        tabIndex={-1}
        aria-hidden
        onChange={(event) => {
          const index = slotIndexRef.current;
          slotIndexRef.current = -1;
          const files = Array.from(event.target.files || []);
          if (files.length > 1) {
            // 多选：从当前点击的槽位起按追加处理（替换语义只对单选生效）。
            void appendFiles(files);
          } else if (index >= 0) {
            void handleSlot(index, files[0]);
          }
          event.target.value = "";
        }}
      />
    </div>
  );
}

export type { ReferenceImagesFieldProps };
