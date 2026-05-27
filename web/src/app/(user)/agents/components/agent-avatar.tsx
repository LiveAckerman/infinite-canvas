"use client";

import { cn } from "@/lib/utils";

// 名字 → 取色：sum char code 取模一组固定色板，保证同名颜色稳定。
const AVATAR_PALETTE = [
  "#2563eb", // blue
  "#ea580c", // orange
  "#16a34a", // green
  "#9333ea", // purple
  "#db2777", // pink
  "#0d9488", // teal
  "#dc2626", // red
  "#ca8a04", // amber
  "#475569", // slate
] as const;

export function pickAvatarColor(name: string) {
  if (!name) return AVATAR_PALETTE[0];
  let sum = 0;
  for (const ch of name) sum = (sum + ch.codePointAt(0)!) % 1000;
  return AVATAR_PALETTE[sum % AVATAR_PALETTE.length];
}

export function pickAvatarLetter(name: string) {
  // 用 Array.from 处理 emoji / 多 BMP 字符，保证只取第一个"字"
  return Array.from(name.trim())[0] || "?";
}

type AgentAvatarProps = {
  name: string;
  avatarUrl?: string;
  size?: number;
  className?: string;
};

// 头像有图就走图，没图就走「首字 + 自动取色」文字头像。
export function AgentAvatar({ name, avatarUrl, size = 40, className }: AgentAvatarProps) {
  if (avatarUrl) {
    return (
      <img
        src={avatarUrl}
        alt={name}
        className={cn("shrink-0 rounded-full object-cover", className)}
        style={{ width: size, height: size }}
      />
    );
  }
  const color = pickAvatarColor(name);
  const letter = pickAvatarLetter(name);
  return (
    <div
      className={cn("flex shrink-0 select-none items-center justify-center rounded-full font-semibold text-white", className)}
      style={{ width: size, height: size, backgroundColor: color, fontSize: Math.max(12, Math.round(size * 0.45)) }}
    >
      {letter}
    </div>
  );
}
