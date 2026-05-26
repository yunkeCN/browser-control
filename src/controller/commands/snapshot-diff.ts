/**
 * 快照差异分析 — snapshot-diff
 *
 * 功能: 比较两个可访问性树（SnapShotNode[]），返回 DOM 结构语义级的变化
 *
 * 比较逻辑:
 *   1. 以 ref 的 structureId 作为元素的稳定标识
 *   2. 新增元素: 在当前树中存在，在基线树中不存在
 *   3. 移除元素: 在基线树中存在，在当前树中不存在
 *   4. 变化元素: structureId 相同，但 text / state 不同
 *
 * 使用场景:
 *   - snapshot baseline=<baselineId>: 对比当前页面与基线
 *   - click 后自动对比: 点击前后的 DOM 结构变化
 */

import type { SnapshotNode } from '../../../contracts';

// ─── 导出的差异类型 ────────────────────────────────────────────────

/** DOM 结构差异 */
export interface StructureDiff {
  /** 新增的子树列表 */
  added: DiffSubtree[];
  /** 移除的子树列表 */
  removed: DiffSubtree[];
  /** 变化的元素列表（text/state 改变） */
  changed: DiffChanged[];
  /** 差异摘要 */
  summary: string;
  /** 是否有变化 */
  hasChanges: boolean;
}

/** 一个新增或移除的子树 */
export interface DiffSubtree {
  /** 元素的 ARIA role */
  role: string;
  /** 可访问名称 */
  name: string;
  /** HTML 标签 */
  tag: string;
  /** 元素的文本内容 */
  text?: string;
  /** 元素 ref（如果存在） */
  ref?: string;
  /** 在 parent 下的位置描述 */
  position: string;
  /** 子节点数量 */
  childrenCount: number;
  /** 子节点的标签列表（最多 10 个） */
  childLabels: string[];
}

/** 一个属性变化的元素 */
export interface DiffChanged {
  /** 元素 ref */
  ref: string;
  /** element structureId */
  structureId: string;
  /** 元素 role */
  role: string;
  /** 元素名称 */
  name: string;
  /** tag */
  tag: string;
  /** 变化的属性 */
  attr: string;
  /** 变化前的值 */
  from: string;
  /** 变化后的值 */
  to: string;
}

// ─── 内部类型 ──────────────────────────────────────────────────────

interface FlatNode {
  ref: string | undefined;
  structureId: string | undefined;
  role: string;
  name: string;
  tag: string;
  text: string;
  path: string[];
  childCount: number;
  childLabels: string[];
}

// ─── 主要 API ─────────────────────────────────────────────────────

/**
 * 比较两棵可访问性树，返回结构语义级差异
 *
 * @param baselineTree  基线树（snapshot 之前的状态）
 * @param currentTree   当前树（snapshot 之后的状态）
 * @returns StructureDiff 结构化差异
 */
export function computeSnapshotDiff(
  baselineTree: Array<SnapshotNode | { text: string }>,
  currentTree: Array<SnapshotNode | { text: string }>,
): StructureDiff {
  const baselineNodes = flattenTree(baselineTree, []);
  const currentNodes = flattenTree(currentTree, []);

  const baselineMap = new Map<string, FlatNode>();
  for (const node of baselineNodes) {
    if (node.structureId) baselineMap.set(node.structureId, node);
  }
  const currentMap = new Map<string, FlatNode>();
  for (const node of currentNodes) {
    if (node.structureId) currentMap.set(node.structureId, node);
  }

  const added: DiffSubtree[] = [];
  const removed: DiffSubtree[] = [];
  const changed: DiffChanged[] = [];

  // 找新增的元素（当前有，基线没有）
  for (const node of currentNodes) {
    if (!node.structureId) continue;
    if (!baselineMap.has(node.structureId)) {
      added.push({
        role: node.role,
        name: node.name,
        tag: node.tag,
        text: node.text || undefined,
        ref: node.ref,
        position: node.path.join(' > '),
        childrenCount: node.childCount,
        childLabels: node.childLabels,
      });
    }
  }

  // 找移除的元素（基线有，当前没有）
  for (const node of baselineNodes) {
    if (!node.structureId) continue;
    if (!currentMap.has(node.structureId)) {
      removed.push({
        role: node.role,
        name: node.name,
        tag: node.tag,
        text: node.text || undefined,
        ref: node.ref,
        position: node.path.join(' > '),
        childrenCount: node.childCount,
        childLabels: node.childLabels,
      });
    }
  }

  // 找变化的元素（structureId 相同，但 text 不同）
  for (const node of currentNodes) {
    if (!node.structureId) continue;
    const baseline = baselineMap.get(node.structureId);
    if (!baseline) continue;

    if (baseline.text !== node.text) {
      changed.push({
        ref: node.ref || baseline.ref || '',
        structureId: node.structureId,
        role: node.role,
        name: node.name,
        tag: node.tag,
        attr: 'text',
        from: baseline.text,
        to: node.text,
      });
    }
  }

  const hasChanges = added.length > 0 || removed.length > 0 || changed.length > 0;
  const summary = buildSummary(added, removed, changed);

  return { added, removed, changed, summary, hasChanges };
}

// ─── 辅助函数 ──────────────────────────────────────────────────────

/**
 * 将树平铺为 FlatNode 列表，使用 structureId 作为唯一标识
 */
function flattenTree(
  nodes: Array<SnapshotNode | { text: string }>,
  parents: string[],
  depth = 0,
): FlatNode[] {
  if (depth > 20) return []; // 防止无限递归
  const result: FlatNode[] = [];
  for (const item of nodes) {
    if (!item || typeof item === 'string') continue;
    // 跳过纯文本节点 { text: string }（没有 tag 属性）
    if (!('tag' in item)) continue;
    const node = item as SnapshotNode;

    const text = node.text || '';
    const ref = node.ref || undefined;
    const structureId = ref ? extractStructureId(ref) : undefined;
    const role = node.role || 'generic';
    const name = node.name || '';
    const tag = node.tag || '';

    const children = extractChildren(node.children);
    const childLabels = children
      .slice(0, 10)
      .map((c) => c.role ? `${c.role} "${c.text || c.name || ''}"` : c.text || '');

    result.push({
      ref,
      structureId,
      role,
      name,
      tag,
      text,
      path: [...parents, `${role} "${name || text || role}"`],
      childCount: children.length,
      childLabels,
    });

    result.push(...flattenTree(children, [...parents, `${role} "${name || text || role}"`], depth + 1));
  }
  return result;
}

/**
 * 从 children 数组中提取 SnapshotNode 列表（过滤掉纯文本节点 { text: string }）
 */
function extractChildren(children: Array<SnapshotNode | { text: string }> | undefined): SnapshotNode[] {
  if (!children) return [];
  return children.filter(
    (c): c is SnapshotNode => typeof c === 'object' && 'tag' in c,
  );
}

/**
 * 从 @e<structureId>_<revision> 中提取 structureId
 */
function extractStructureId(ref: string): string | undefined {
  const match = /^@e([a-z0-9]+)_\d+$/i.exec(ref);
  return match ? match[1] : undefined;
}

/**
 * 生成人类可读的差异摘要
 */
function buildSummary(
  added: DiffSubtree[],
  removed: DiffSubtree[],
  changed: DiffChanged[],
): string {
  const parts: string[] = [];
  if (added.length > 0) {
    const byRole = countBy(added, (n) => n.role);
    const desc = [...byRole.entries()]
      .map(([role, count]) => `${count} 个 ${role}`)
      .join('、');
    parts.push(`新增 ${added.length} 个元素（${desc}）`);
  }
  if (removed.length > 0) {
    const byRole = countBy(removed, (n) => n.role);
    const desc = [...byRole.entries()]
      .map(([role, count]) => `${count} 个 ${role}`)
      .join('、');
    parts.push(`移除 ${removed.length} 个元素（${desc}）`);
  }
  if (changed.length > 0) {
    parts.push(`变化 ${changed.length} 个元素`);
  }
  return parts.length > 0 ? parts.join('；') : '无变化';
}

function countBy<T>(items: T[], keyFn: (item: T) => string): Map<string, number> {
  const map = new Map<string, number>();
  for (const item of items) {
    const key = keyFn(item);
    map.set(key, (map.get(key) || 0) + 1);
  }
  return map;
}
