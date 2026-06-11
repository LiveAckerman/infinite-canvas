"use client";

import { create } from "zustand";

import { defaultConfig, type AiConfig } from "@/lib/ai-config";
import { updateMyPreferences, type UserPreferences } from "@/services/api/auth";
import { useUserStore } from "@/stores/use-user-store";

type AiConfigStore = {
  config: AiConfig;
  // 把服务器返回的偏好覆盖到本地。空字段保留 defaultConfig，避免新注册用户拿到全空配置。
  hydrateFromPreferences: (prefs?: UserPreferences | null) => void;
  updateConfig: <K extends keyof AiConfig>(key: K, value: AiConfig[K]) => void;
  // 仅更新本地内存、不上传服务器。用于「查看历史记录时把表单回填成那条记录的参数」这类
  // 不该改写用户默认偏好的场景：只是看一条旧记录，不应该把我的默认 张数/尺寸/质量 改掉并上云。
  applyConfigLocal: (partial: Partial<AiConfig>) => void;
};

let pendingPushTimer: ReturnType<typeof setTimeout> | null = null;
let pendingPushPayload: AiConfig | null = null;

// 改动节流：避免每改一项就打一次请求；最后一次连续输入后 600ms 统一推上去。
function schedulePush(next: AiConfig) {
  pendingPushPayload = next;
  if (pendingPushTimer) clearTimeout(pendingPushTimer);
  pendingPushTimer = setTimeout(() => {
    const payload = pendingPushPayload;
    pendingPushTimer = null;
    pendingPushPayload = null;
    if (!payload) return;
    const token = useUserStore.getState().token;
    if (!token) return;
    void updateMyPreferences(token, payload).catch(() => {
      // 网络挂时忽略；下次改动会再次重试，本地修改不丢。
    });
  }, 600);
}

function mergeDefaults(prefs?: UserPreferences | null): AiConfig {
  return {
    quality: prefs?.quality?.trim() || defaultConfig.quality,
    size: prefs?.size?.trim() || defaultConfig.size,
    count: prefs?.count?.trim() || defaultConfig.count,
  };
}

export const useAiConfigStore = create<AiConfigStore>()((set, get) => ({
  config: defaultConfig,
  hydrateFromPreferences: (prefs) => {
    set({ config: mergeDefaults(prefs) });
  },
  updateConfig: (key, value) => {
    const next = { ...get().config, [key]: value };
    set({ config: next });
    schedulePush(next);
  },
  applyConfigLocal: (partial) => {
    set({ config: { ...get().config, ...partial } });
    // 故意不 schedulePush：本地回填不算「用户改了偏好」，不上传。
  },
}));
