/**
 * 基线存储 — 供 snapshot、click 等命令共享
 *
 * 使用简单的模块级 Map，V1 内存在线。
 */
import type { SnapshotNode } from '../../../contracts';

const store = new Map<string, Array<SnapshotNode | { text: string }>>();

export function setBaseline(id: string, tree: Array<SnapshotNode | { text: string }>): void {
  store.set(id, tree);
}

export function getBaseline(id: string): Array<SnapshotNode | { text: string }> | undefined {
  return store.get(id);
}

export function hasBaseline(id: string): boolean {
  return store.has(id);
}
