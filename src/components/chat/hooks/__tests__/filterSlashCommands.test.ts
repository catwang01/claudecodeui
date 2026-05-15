import { describe, expect, test } from 'vitest';
import { filterSlashCommands } from '../useSlashCommands';
import type { SlashCommand } from '../useSlashCommands';

const cmd = (name: string, description?: string): SlashCommand => ({ name, description });

const COMMANDS: SlashCommand[] = [
  cmd('/status', 'Show current status'),
  cmd('/clear', 'Clear the conversation'),
  cmd('/compact', 'Compact the context'),
  cmd('/help', 'Show help'),
  cmd('/skill:review', 'Run code review skill'),
  cmd('/skill:summarize', 'Summarize the session'),
];

describe('filterSlashCommands', () => {
  describe('空 query', () => {
    test('返回全部命令', () => {
      expect(filterSlashCommands(COMMANDS, '')).toEqual(COMMANDS);
    });

    test('只有空格的 query 视为空', () => {
      expect(filterSlashCommands(COMMANDS, '   ')).toEqual(COMMANDS);
    });
  });

  describe('前缀匹配', () => {
    test('query 不含斜杠时自动补 /', () => {
      const result = filterSlashCommands(COMMANDS, 'sta');
      expect(result.map((c) => c.name)).toEqual(['/status']);
    });

    test('query 已含斜杠时直接匹配', () => {
      const result = filterSlashCommands(COMMANDS, '/st');
      expect(result.map((c) => c.name)).toEqual(['/status']);
    });

    test('前缀匹配多个结果', () => {
      const result = filterSlashCommands(COMMANDS, 'c');
      expect(result.map((c) => c.name)).toEqual(['/clear', '/compact']);
    });

    test('大小写不敏感', () => {
      const result = filterSlashCommands(COMMANDS, 'STA');
      expect(result.map((c) => c.name)).toEqual(['/status']);
    });

    test('前缀有结果时不继续子串匹配', () => {
      // '/clear' 和 '/compact' 都以 /c 开头，不应出现其他含 'c' 的命令
      const result = filterSlashCommands(COMMANDS, 'c');
      expect(result).not.toContainEqual(expect.objectContaining({ name: '/status' }));
    });
  });

  describe('namespace 命令（含 :）', () => {
    test('含冒号时走严格前缀匹配', () => {
      const result = filterSlashCommands(COMMANDS, '/skill:r');
      expect(result.map((c) => c.name)).toEqual(['/skill:review']);
    });

    test('namespace 无匹配时返回空', () => {
      const result = filterSlashCommands(COMMANDS, '/skill:xyz');
      expect(result).toHaveLength(0);
    });

    test('namespace 前缀有结果时不继续子串/描述匹配', () => {
      // '/skill:' 能前缀匹配到两个，不应触发描述匹配
      const result = filterSlashCommands(COMMANDS, '/skill:');
      expect(result.map((c) => c.name)).toEqual(['/skill:review', '/skill:summarize']);
    });
  });

  describe('子串匹配（前缀无结果时）', () => {
    test('匹配命令名中间的字符串', () => {
      // 'lear' 不是任何命令的前缀（/c 前缀会匹配到 /clear，但 '/lear' 不会）
      // 用一个只能靠子串命中的 query
      const result = filterSlashCommands(COMMANDS, 'lear');
      expect(result.map((c) => c.name)).toEqual(['/clear']);
    });

    test('子串有结果时不继续描述匹配', () => {
      // 'compact' 是 /compact 的名字子串，不应匹配描述含 compact 的其他命令
      const cmds = [
        cmd('/compact', 'Make it smaller'),
        cmd('/other', 'compact this thing'),
      ];
      const result = filterSlashCommands(cmds, 'compact');
      expect(result.map((c) => c.name)).toEqual(['/compact']);
    });
  });

  describe('描述匹配（名字完全无匹配时）', () => {
    test('query 只在描述中出现时能匹配', () => {
      // 'conversation' 不在任何命令名里，但在 /clear 的描述里
      const result = filterSlashCommands(COMMANDS, 'conversation');
      expect(result.map((c) => c.name)).toEqual(['/clear']);
    });

    test('没有任何匹配时返回空数组', () => {
      const result = filterSlashCommands(COMMANDS, 'xyznotexist');
      expect(result).toHaveLength(0);
    });

    test('没有描述的命令不会出错', () => {
      const cmds = [cmd('/nodesc')];
      expect(() => filterSlashCommands(cmds, 'something')).not.toThrow();
    });
  });

  describe('边界情况', () => {
    test('命令列表为空时返回空数组', () => {
      expect(filterSlashCommands([], 'status')).toEqual([]);
    });

    test('只有一个命令且匹配', () => {
      const result = filterSlashCommands([cmd('/status')], 'sta');
      expect(result).toHaveLength(1);
    });
  });
});
