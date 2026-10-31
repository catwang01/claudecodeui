import type { TFunction } from 'i18next';
import type { Preset, PresetTask } from '../types';
import { describeRule, normalizeRuleKind, toTaskRule } from './rules';

/** Trailing-separator-insensitive path comparison (mirrors the server's sameProjectPath). */
export function normalizePresetPath(value: string | null | undefined): string {
  const isSeparator = (char: string) => char === '/' || char.charCodeAt(0) === 92;
  let trimmed = (value ?? '').trim();
  while (trimmed.length > 1 && isSeparator(trimmed.charAt(trimmed.length - 1))) {
    trimmed = trimmed.slice(0, -1);
  }
  return trimmed;
}

/** True when this preset already installed real tasks in `projectPath`. */
export function isPresetInstalledIn(preset: Preset, projectPath: string): boolean {
  const target = normalizePresetPath(projectPath);
  if (!target) return false;
  return (preset.installedProjects ?? []).some((value) => normalizePresetPath(value) === target);
}

/** Human readable frequency text for one template inside a preset. */
export function describePresetTask(
  task: Pick<PresetTask, 'kind' | 'rule'>,
  t: TFunction,
  locale?: string,
): string {
  const rule = toTaskRule(normalizeRuleKind(task.kind || task.rule?.kind), task.rule);
  return describeRule(rule, t, locale);
}
