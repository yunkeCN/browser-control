/**
 * 通用控制层 — 统一入口
 *
 * Controller 层是所有命令的统一入口，同时服务于：
 * - Skill CLI: 可直接调用 controller 方法
 * - MCP Server: 通过 controller 层处理命令
 *
 * 所有命令的输出统一为 CommandResult<T> 格式，
 * 确保 LLM 在任何入口下都能获得一致的、易理解的结果。
 */

export type { CommandResult, CommandDefinition } from './types';
export { runCommand } from './runner';

// 导航
export { navigate } from './commands/navigate';
export type { NavigateInput, NavigateData } from './commands/navigate';

// 快照
export { snapshot } from './commands/snapshot';
export type { SnapshotInput, SnapshotData } from './commands/snapshot';

// 元素交互
export { click } from './commands/click';
export type { ClickInput, ClickData } from './commands/click';

export { fill } from './commands/fill';
export type { FillInput, FillData } from './commands/fill';

export { press } from './commands/press';
export type { PressInput, PressData } from './commands/press';

export { scroll } from './commands/scroll';
export type { ScrollInput, ScrollData } from './commands/scroll';

export { upload } from './commands/upload';
export type { UploadInput, UploadData } from './commands/upload';

// 页面读取
export { getText } from './commands/get-text';
export type { GetTextInput, GetTextData } from './commands/get-text';

export { capture } from './commands/capture';
export type { CaptureInput, CaptureData } from './commands/capture';

export { evaluate } from './commands/evaluate';
export type { EvaluateInput, EvaluateData } from './commands/evaluate';

export { waitFor } from './commands/wait-for';
export type { WaitForInput, WaitForData } from './commands/wait-for';


// 网络
export { network } from './commands/network';
export type { NetworkInput, NetworkData, NetworkStartData, NetworkListData, NetworkDetailData, NetworkStopData } from './commands/network';

// 标签页
export { tabs } from './commands/tabs';
export type { TabsInput, TabsData, ListTabsData, SwitchTabData, CloseTabData } from './commands/tabs';

// 会话
export { closeSession } from './commands/session';
export type { CloseSessionInput, CloseSessionData } from './commands/session';


// 下载
export { download } from './commands/download';
export type { DownloadInput, DownloadData } from './commands/download';
