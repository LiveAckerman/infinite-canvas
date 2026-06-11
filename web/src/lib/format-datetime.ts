// 后端的 created_at / updated_at 统一是 RFC3339 字符串，服务器进程跑在 UTC 时区，
// 字段末尾会带 "Z"。直接拼到 UI 上会让用户看到比本地少 8 小时的"假时间"。
// 这里统一按浏览器时区（用户当前所在时区）格式化。

const DEFAULT_OPTIONS: Intl.DateTimeFormatOptions = {
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hour12: false,
};

const SHORT_OPTIONS: Intl.DateTimeFormatOptions = {
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  hour12: false,
};

function safeDate(value?: string | null) {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

// 完整时间，例如 "2026-05-21 15:59:16"
export function formatLocalDateTime(value?: string | null, fallback = "-") {
  const date = safeDate(value);
  if (!date) return fallback;
  return date.toLocaleString("zh-CN", DEFAULT_OPTIONS).replace(/\//g, "-");
}

// 简短形态，例如 "05-21 15:59"
export function formatLocalDateTimeShort(value?: string | null, fallback = "-") {
  const date = safeDate(value);
  if (!date) return fallback;
  return date.toLocaleString("zh-CN", SHORT_OPTIONS).replace(/\//g, "-");
}

// 相对时间："刚刚 / N 分钟前 / N 小时前 / N 天前 / yyyy-MM-dd"。
// 批量任务卡片、流水线执行流程卡片共用（原先两份逐字重复）。
export function formatRelativeTime(value?: string | null): string {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  const diff = Date.now() - date.getTime();
  const minute = 60 * 1000;
  const hour = 60 * minute;
  const day = 24 * hour;
  if (diff < minute) return "刚刚";
  if (diff < hour) return `${Math.floor(diff / minute)} 分钟前`;
  if (diff < day) return `${Math.floor(diff / hour)} 小时前`;
  if (diff < 7 * day) return `${Math.floor(diff / day)} 天前`;
  return date.toLocaleDateString("zh-CN");
}
