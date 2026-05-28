/**
 * 快照差异分析 — snapshot-diff
 *
 * 核心逻辑已迁移至 src/shared/snapshot-diff.ts（daemon 层同样需要使用）
 * 此文件保留以维持 controller 层的导入兼容性
 */

export type { StructureDiff, DiffSubtree, DiffChanged } from '../../shared/snapshot-diff';
export { computeSnapshotDiff } from '../../shared/snapshot-diff';
