"use client";

import imageCompression from "browser-image-compression";

// 压缩后**仍**超过这个体积 → 直接拒收上传，提示用户手动减小图片。
// 8MB 是个偏宽松的折中：cpa-manager 上游 multipart 默认 32MB（后续会调到 100MB），
// 按最多 4 张参考图算单张 ≤ 8MB 仍在 buffer 内；优先保证清晰度。
export const MAX_IMAGE_BYTES_AFTER_COMPRESS = 8 * 1024 * 1024;

// 目标体积：单张图压缩到 ≤ 4MB，长边 ≤ 2048px。
// 之前用 2MB + q=0.85，复杂细节多的照片（人像 / 多色椅子）会有明显糊化感；
// 提到 4MB + q=0.95 后视觉几乎无损，仍远低于上游 32MB（5 张 × 4MB = 20MB）。
// OpenAI gpt-image 实际处理时也会内部下采样到长边 ≤ 2048，再大没意义。
const TARGET_MAX_BYTES_MB = 4;
const TARGET_MAX_DIMENSION = 2048;

// JPEG / WebP 起始质量：0.95 视觉无损，0.85 开始能看出来糊。
// 这个值是「起始尝试」，如果一次性压完 > maxSizeMB 库会自动迭代降质量。
// 因为 maxSizeMB 已经够宽松（4MB），绝大多数情况不会触发降质量，等于始终 0.95 出图。
const INITIAL_QUALITY = 0.95;

// 小于这个体积 / 像素的图不做压缩（小图压完反而可能更大、还浪费 CPU + 损失清晰度）。
const SKIP_IF_SMALLER_THAN = 500 * 1024;

// 给用户看的标准压缩说明文案（页面上常驻提示用），所有上传入口共用这一句话，
// 不要在各页面里再各自拼，避免参数调整后多处文案漂移。
export const COMPRESS_HINT_TEXT = "大于 500KB 的图会自动压缩到 4MB 内（长边 2048px），保持画质清晰";

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
//   - 输入 < 500KB → 直接跳过压缩（小图压完反而可能更大、还损失清晰度）
//   - 体积或尺寸超阈值 → 走 browser-image-compression 压缩（q=0.95 视觉无损 + 长边 2048）
//   - 不是图片类型 → 直接返回原 Blob（让上游报错或 SaveImage 拦下）
export async function compressImage(input: CompressInput | string): Promise<Blob> {
  const blob: Blob = typeof input === "string"
    ? await dataUrlToBlob(input)
    : input;
  if (!blob.type.startsWith("image/")) return blob;
  // 已经很小的图就不浪费 CPU 了 + 不损失清晰度
  if (blob.size < SKIP_IF_SMALLER_THAN) return blob;

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
      initialQuality: INITIAL_QUALITY,
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
