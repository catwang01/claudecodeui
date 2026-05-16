import { claudeSessionSynchronizer } from './list/claude/claude-session-synchronizer.provider.js';
import { cursorSessionSynchronizer } from './list/cursor/cursor-session-synchronizer.provider.js';
import { codexSessionSynchronizer } from './list/codex/codex-session-synchronizer.provider.js';
import { geminiSessionSynchronizer } from './list/gemini/gemini-session-synchronizer.provider.js';
import { opencodeSessionSynchronizer } from './list/opencode/opencode-session-synchronizer.provider.js';
import type { ISessionSynchronizer } from './types.js';

export const ALL_SYNCHRONIZERS: ISessionSynchronizer[] = [
  claudeSessionSynchronizer,
  cursorSessionSynchronizer,
  codexSessionSynchronizer,
  geminiSessionSynchronizer,
  opencodeSessionSynchronizer,
];
