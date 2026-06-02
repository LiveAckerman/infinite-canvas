"use client";

import imageCompression from "browser-image-compression";

// 压缩后**仍**超过这个体积 → 直接拒收上传，提示用户手动减小图片。
// 5MB 是个折中：cpa-manager 上游 multipart 默认 32MB，按最多 9 张参考图算单张 ≤ 5MB 留 buffer 不会超。
export const MAX_IMAGE_BYTES_AFTER_COMPRESS = 5 * 1024 * 1024;

// 目标体积：单张图压缩到 ≤ 2MB，长边 ≤ 2048px。
// 这个尺寸对 OpenAI gpt-image 完全够用（模型实际推荐输入长边 ≤ 2048），
// 5 张参考图加起来 < 10MB 也远低于上游 32MB 限制。
const TARGET_MAX_BYTES_MB = 2;
const TARGET_MAX_DIMENSION = 2048;

// PNG 带透明通道时保留 PNG（避免丢 alpha）；其它一律转 JPEG，体积小很多。
function pickOutputType(mimeType: string): string {
  if (mimeType === "image/png") return "image/png";
  // gif / webp 等较少见，统一转 JPEG，压缩率更高
  return "image/jpeg";
}

type CompressInput = Blob | File;

// 把 dataURL 转 Blob，让压缩入口统一吃 Blob/File。
async function dataUrlToBlob(dataUrl: string): Promise<Blob> {
  const response = await fetch(dataUrl);
  return response.blob();
}

// 压缩单张图。压缩失败时返回原图（兜底）。
//   - 输入 < 200KB → 直接跳过压缩（小图压完反而可能更大）
//   - 体积或尺寸超阈值 → 走 browser-image-compression 压缩
//   - 不是图片类型 → 直接返回原 Blob（让上游报错或 SaveImage 拦下）
export async function compressImage(input: CompressInput | string): Promise<Blob> {
  const blob: Blob = typeof input === "string"
    ? await dataUrlToBlob(input)
    : input;
  if (!blob.type.startsWith("image/")) return blob;
  // 已经很小的图就不浪费 CPU 了
  if (blob.size < 200 * 1024) return blob;

  // browser-image-compression 接受 File（Blob 子类），把 Blob 转 File 走它的 API
  const file: File = blob instanceof File
    ? blob
    : new File([blob], `upload-${Date.now()}`, { type: blob.type });

  try {
    const compressed = await imageCompression(file, {
      maxSizeMB: TARGET_MAX_BYTES_MB,
      maxWidthOrHeight: TARGET_MAX_DIMENSION,
      useWebWorker: true,
      fileType: pickOutputType(blob.type),
      initialQuality: 0.85,
    });
    // 如果压缩反而变大了（极少见），仍返回原图
    if (compressed.size >= blob.size) return blob;
    return compressed;
  } catch {
    // worker 报错 / 浏览器不支持 → 兜底用原图
    return blob;
  }
}

// 友好提示：把字节数转 「x.y MB」
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}
