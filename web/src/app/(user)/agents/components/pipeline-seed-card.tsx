"use client";

import { ClipboardPaste, ImagePlus, Upload, X } from "lucide-react";
import { App, Button, Image } from "antd";
import { useRef, useState, type ClipboardEvent as ReactClipboardEvent, type DragEvent as ReactDragEvent } from "react";

import { useImageUploader } from "@/lib/use-image-uploader";

type PipelineSeedCardProps = {
  seedUrl: string;
  onChange: (next: { url: string; storageKey: string } | null) => void;
  disabled?: boolean;
};

// 流水线最左侧的「原图 seed」卡：上传 / 粘贴 / 拖入用户的初始图片，
// 后续步骤的第一步默认拿它当输入。结构跟 AgentWorkstation 里那块基本一致，
// 但因为是横向流水线的一节，做成更紧凑的方形而不是 textarea + 按钮组合。
export function PipelineSeedCard({ seedUrl, onChange, disabled }: PipelineSeedCardProps) {
  const { message } = App.useApp();
  const uploadWithToast = useImageUploader();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [dragHighlight, setDragHighlight] = useState(false);

  const handleFile = async (file?: File | null) => {
    if (!file) return;
    if (!file.type.startsWith("image/")) {
      message.error("请选择图片文件");
      return;
    }
    try {
      const stored = await uploadWithToast(file, { label: "原图" });
      onChange({ url: stored.url, storageKey: stored.storageKey });
    } catch {
      // uploader 已弹错误
    }
  };

  const handlePaste = (event: ReactClipboardEvent<HTMLDivElement>) => {
    const items = Array.from(event.clipboardData?.items || []);
    const file = items.find((item) => item.kind === "file" && item.type.startsWith("image/"))?.getAsFile();
    if (!file) return;
    event.preventDefault();
    void handleFile(file);
  };

  const handleClipboard = async () => {
    try {
      const items = await navigator.clipboard.read();
      for (const item of items) {
        const imageType = item.types.find((type) => type.startsWith("image/"));
        if (!imageType) continue;
        const blob = await item.getType(imageType);
        await handleFile(new File([blob], `clipboard-${Date.now()}.png`, { type: imageType }));
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
    void handleFile(file);
  };

  return (
    <div
      className={`flex w-[240px] shrink-0 flex-col gap-2 rounded-lg border-2 border-stone-200 bg-card p-3 shadow-sm transition-colors dark:border-stone-800 sm:w-[260px] ${dragHighlight ? "border-blue-500 bg-blue-50/40 dark:border-blue-400 dark:bg-blue-500/10" : ""}`}
      onPaste={handlePaste}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
    >
      <div className="flex items-center justify-between">
        <span className="text-xs font-semibold text-stone-500 dark:text-stone-400">原图</span>
        <span className="text-[11px] text-stone-400">流水线第一步的输入</span>
      </div>
      {seedUrl ? (
        <div className="relative">
          <Image src={seedUrl} alt="原图" className="!w-full rounded-md object-contain" preview={{ mask: "查看大图" }} />
          <button
            type="button"
            disabled={disabled}
            className="absolute right-1 top-1 grid size-6 place-items-center rounded bg-black/60 text-white transition hover:bg-black/80 disabled:opacity-50"
            onClick={() => onChange(null)}
            aria-label="移除原图"
          >
            <X className="size-3.5" />
          </button>
        </div>
      ) : (
        <div className="flex flex-col items-center gap-2 rounded-md border-2 border-dashed border-stone-300 p-4 text-center dark:border-stone-700">
          <ImagePlus className="size-7 text-stone-400" />
          <div className="text-xs text-stone-500 dark:text-stone-400">{dragHighlight ? "松开以添加原图" : "拖入 / 粘贴 / 点击上传"}</div>
        </div>
      )}
      <div className="flex gap-1.5">
        <Button size="small" disabled={disabled} icon={<Upload className="size-3.5" />} onClick={() => fileInputRef.current?.click()}>{seedUrl ? "替换" : "上传"}</Button>
        <Button size="small" disabled={disabled} icon={<ClipboardPaste className="size-3.5" />} onClick={() => void handleClipboard()}>剪切板</Button>
      </div>
      <input
        ref={fileInputRef}
        type="file"
        accept="image/*"
        style={{ display: "none" }}
        tabIndex={-1}
        aria-hidden
        onChange={(event) => {
          void handleFile(event.target.files?.[0]);
          event.target.value = "";
        }}
      />
    </div>
  );
}
