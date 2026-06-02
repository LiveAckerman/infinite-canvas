"use client";

import { App } from "antd";
import { useCallback, useRef } from "react";

import { MAX_IMAGE_BYTES_AFTER_COMPRESS, compressImage, formatBytes } from "@/lib/compress-image";
import { uploadImage, type UploadedImage } from "@/services/image-storage";

type UploadOptions = {
  // 用户可见的描述，比如「参考图」「素材封面」；为空则用默认"图片"。
  label?: string;
  // 上传成功后是否弹 message.success；默认 true。
  silentSuccess?: boolean;
  // 跳过自动压缩（默认走压缩）。极个别需要原图精度的场景才传 true，比如导出 / 备份。
  // 一般用户上传（头像 / 参考图 / 素材封面 / 画布原图）都走压缩，省服务器空间也躲开上游 32MB multipart 限制。
  skipCompress?: boolean;
};

// useImageUploader 在 antd App 上下文里给 uploadImage 包一层「压缩 + loading toast + 友好错误」逻辑：
//   1. 先用 browser-image-compression 把图压到长边 ≤ 2048 + 体积 ≤ 2MB（PNG 透明保留 PNG，其它转 JPEG）
//   2. 压完仍 > 5MB → 直接拒绝（极少见，提示用户手动减小）
//   3. 上传 + 处理 message toast
//
// 用法：
//   const upload = useImageUploader();
//   const { storageKey, url } = await upload(file, { label: "参考图" });
//
// 多次并发上传也安全：每次调用用独立 key 区分 toast。
export function useImageUploader() {
  const { message } = App.useApp();
  const counterRef = useRef(0);

  return useCallback(
    async (input: string | Blob, options: UploadOptions = {}): Promise<UploadedImage> => {
      const label = options.label?.trim() || "图片";
      const key = `upload-${++counterRef.current}-${Date.now()}`;
      // 压缩时间通常 0.3-1.5s，让用户看到「正在处理图片…」避免以为卡死；
      // 压完进上传阶段再换文案。
      message.loading({ content: `正在处理${label}…`, key, duration: 0 });
      try {
        // 1. 自动压缩（除非显式 skip）
        const toUpload = options.skipCompress
          ? (typeof input === "string" ? input : input)
          : await compressImage(input);

        // 2. 硬上限兜底（极少见 case：压缩后仍 > 5MB，比如 4K 多人复杂场景）
        if (toUpload instanceof Blob && toUpload.size > MAX_IMAGE_BYTES_AFTER_COMPRESS) {
          const tip = `${label}处理后仍有 ${formatBytes(toUpload.size)}（上限 ${formatBytes(MAX_IMAGE_BYTES_AFTER_COMPRESS)}），请手动减小尺寸 / 拆分后再上传`;
          message.error({ content: tip, key, duration: 4 });
          throw new Error(tip);
        }

        // 3. 真正上传
        message.loading({ content: `正在上传${label}…`, key, duration: 0 });
        const result = await uploadImage(toUpload);
        if (options.silentSuccess === false) {
          message.success({ content: `${label}已上传`, key, duration: 1.5 });
        } else {
          // 默认静默成功：直接关闭 loading toast，不打扰
          message.destroy(key);
        }
        return result;
      } catch (error) {
        const text = error instanceof Error ? error.message : `${label}上传失败`;
        message.error({ content: text, key, duration: 3 });
        throw error;
      }
    },
    [message],
  );
}
