import dark from "../../third-party/typora-plugins/dark.js?typora-plugin";
import noImage from "../../third-party/typora-plugins/no_image.js?typora-plugin";
import blur from "../../third-party/typora-plugins/blur.js?typora-plugin";
import readOnly from "../../third-party/typora-plugins/read_only.js?typora-plugin";
import markers from "../../third-party/typora-plugins/static_markers.js?typora-plugin";
import collapseList from "../../third-party/typora-plugins/collapse_list.js?typora-plugin";
import autoNumber from "../../third-party/typora-plugins/auto_number.js?typora-plugin";
import collapseParagraph from "../../third-party/typora-plugins/collapse_paragraph.js?typora-plugin";
import type { PluginDefinition, PluginPreferences } from "./types";
import { t } from "../i18n";
// Upstream default layouts. Each heading pattern applies to content (c), outline (o) and [TOC] (t) counters; "$" stands for that prefix.
const numberingLayout = (headings: string[], captions: string[]) => Object.fromEntries([
  ...["content", "outline", "toc"].flatMap(scope => headings.map((pattern, level) => [`${scope}-h${level + 1}`, pattern.replaceAll("$", scope[0])])),
  ["table", captions[0]], ["image", captions[1]], ["fence", captions[2]],
]);
const numberingLayouts = [
  { name: "Layout::Decimal-H1", selected: false, layout: numberingLayout(["{$1}. ", "{$1}.{$2} ", "{$1}.{$2}.{$3} ", "{$1}.{$2}.{$3}.{$4} ", "{$1}.{$2}.{$3}.{$4}.{$5} ", "{$1}.{$2}.{$3}.{$4}.{$5}.{$6} "], ["Table {t}", "Image {i}", "Fence {f}"]) },
  { name: "Layout::Decimal-H2", selected: true, layout: numberingLayout(["", "{$2}. ", "{$2}.{$3} ", "{$2}.{$3}.{$4} ", "{$2}.{$3}.{$4}.{$5} ", "{$2}.{$3}.{$4}.{$5}.{$6} "], ["Table {t}", "Image {i}", "Fence {f}"]) },
  { name: "Layout::RomanNumeral", selected: false, layout: numberingLayout(["{$1:ur}. ", "{$2:ua}. ", "{$3}. ", "{$4:la}. ", "({$5}). ", "({$6:la}). "], ["Table {t}", "Image {i}", "Fence {f}"]) },
  { name: "Layout::ChineseThesis", selected: false, layout: numberingLayout(["{$1:cjk}、", "（{$2:cjk}）", "{$3}. ", "（{$4}）", "{$5}）", "{$6:ua}. "], ["表 {t}", "图 {i}", "代码 {f}"]) },
  { name: "Layout::None", selected: false, layout: numberingLayout(["", "", "", "", "", ""], ["", "", ""]) },
];
export const bundledPlugins: PluginDefinition[] = [
  { id: "auto_number", name: "自动编号", description: t("为正文标题、大纲和目录自动编号，导出时保留；可切换编号范围和格式。"), factory: autoNumber, config: { ENABLE_OUTLINE: true, ENABLE_CONTENT: true, ENABLE_TOC: false, ENABLE_TABLE: false, ENABLE_IMAGE: false, ENABLE_FENCE: false, SHOW_IMAGE_NAME: false, FONT_FAMILY: "monospace", ALIGN: "center", POSITION_TABLE: "after", ENABLE_WHEN_EXPORT: true, APPLY_EXPORT_HEADER_NUMBERING: "", LAYOUTS: numberingLayouts } },
  { id: "collapse_paragraph", name: "章节折叠", description: t("按住 Ctrl 点击标题折叠其下内容，也可通过插件命令折叠或展开全部章节。"), factory: collapseParagraph, config: { STRICT_MODE: true, STRICT_MODE_IN_CONTEXT_MENU: false, RECORD_COLLAPSE: true, MODIFIER_KEY: { COLLAPSE_SINGLE: "ctrl", COLLAPSE_SIBLINGS: "ctrl+alt", COLLAPSE_ALL_SIBLINGS: "ctrl+shift+alt", COLLAPSE_RECURSIVE: "" } } },
  { id: "collapse_list", name: "列表折叠", description: t("点击列表左侧三角折叠其余列表项，当前会话记住每份文档的折叠状态。"), factory: collapseList, config: { RECORD_COLLAPSE: true, TRIANGLE_COLOR: "" } },
  { id: "read_only", name: "只读模式", description: t("锁定正文、源码和编辑命令，安心阅读。"), factory: readOnly, config: { READ_ONLY_DEFAULT: true, HOTKEY: "mod+alt+r", SHOW_TEXT: "只读", DISABLE_EXPAND_WHEN_READ_ONLY: true, AUTO_COLLAPSE_WHEN_READ_ONLY: true, CLICK_HYPERLINK_TO_OPEN_WHEN_READ_ONLY: false, DISABLE_CONTEXT_MENU_WHEN_READ_ONLY: false, REMAIN_AVAILABLE_MENU_KEY: [] } },
  { id: "no_image", name: "无图阅读", description: t("暂时隐藏图片，鼠标悬停可查看。"), factory: noImage, config: { NO_IMAGE_DEFAULT: true, SHOW_ON_HOVER: true, TRANSITION_DURATION: 200, TRANSITION_DELAY: 0, HOTKEY: "mod+alt+i" } },
  { id: "blur", name: "段落聚焦", description: t("模糊光标之外的段落，悬停恢复清晰。"), factory: blur, config: { BLUR_DEFAULT: true, BLUR_TYPE: "blur", BLUR_LEVEL: 3, RESTORE_ON_HOVER: true, HOTKEY: "mod+alt+shift+b" } },
  { id: "static_markers", name: "常显语法标记", description: t("保留粗体、斜体、代码等 Markdown 符号。"), factory: markers, config: { STATIC_DEFAULT: true, STATIC_MARKERS: ["strong", "em", "del", "underline", "highlight", "superscript", "subscript", "code", "inlineMath", "image", "link", "footnote"], HOTKEY: "mod+alt+m" } },
  { id: "dark", name: "反色夜间模式", description: t("系统为浅色外观时反色显示，也可选用内置深色主题。"), factory: dark, config: { DARK_DEFAULT: true, HOTKEY: "mod+alt+d" } },
].map(plugin => ({ ...plugin, builtin: true }));
export const pluginPreferenceKey = "omarkie-plugins-v1";
export function loadPluginPreferences(): PluginPreferences {
  try { const parsed = JSON.parse(localStorage.getItem(pluginPreferenceKey) || "{}"); return parsed && !Array.isArray(parsed) && typeof parsed === "object" ? parsed : {}; } catch { return {}; }
}
