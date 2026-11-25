// V-3 设置大页面：八分区登记表（顺序即导航顺序）。
// 分区存 URL 查询串 ?section=<id>——可直达、随历史回退；缺省/非法回外观。
export const SETTINGS_SECTIONS = [
  { id: "appearance", label: "外观", desc: "主题、背景与窗口观感" },
  { id: "reading", label: "阅读", desc: "EPUB 新书的默认阅读设置" },
  { id: "library", label: "书库", desc: "位置、存储占用与维护工具" },
  { id: "cloud", label: "云书架", desc: "wenku8 账号与拉取偏好" },
  { id: "network", label: "网络与更新", desc: "文库地址、代理与应用更新" },
  { id: "shortcuts", label: "快捷键", desc: "阅读与书库的键盘操作" },
  { id: "manga", label: "漫画增强", desc: "漫画与 PDF 的默认阅读设置" },
  { id: "about", label: "关于", desc: "版本、数据位置与项目链接" },
] as const;

export type SettingsSectionId = (typeof SETTINGS_SECTIONS)[number]["id"];

export function normalizeSettingsSection(v: unknown): SettingsSectionId {
  return SETTINGS_SECTIONS.find((s) => s.id === v)?.id ?? "appearance";
}
