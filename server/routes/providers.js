import express from 'express';
import { promises as fs } from 'fs';
import os from 'os';
import path from 'path';

import { parseFrontmatter } from '../utils/frontmatter.js';

const router = express.Router();

/**
 * GET /api/providers/:provider/skills
 * List skills from installed Claude plugins.
 * Only 'claude' provider is implemented; others return an empty list.
 */
router.get('/:provider/skills', async (req, res) => {
  const { provider } = req.params;

  if (provider !== 'claude') {
    return res.json({ success: true, data: { skills: [] } });
  }

  try {
    const claudeHome = path.join(os.homedir(), '.claude');
    const skills = await listClaudePluginSkills(claudeHome);
    res.json({ success: true, data: { skills } });
  } catch (error) {
    console.error('Error listing provider skills:', error);
    res.json({ success: true, data: { skills: [] } });
  }
});

async function listClaudePluginSkills(claudeHome) {
  const skills = [];

  let settings, installedPlugins;
  try {
    settings = JSON.parse(await fs.readFile(path.join(claudeHome, 'settings.json'), 'utf8'));
  } catch { return skills; }

  try {
    const raw = JSON.parse(
      await fs.readFile(path.join(claudeHome, 'plugins', 'installed_plugins.json'), 'utf8')
    );
    installedPlugins = raw.plugins || {};
  } catch { return skills; }

  const enabledPlugins = settings.enabledPlugins || {};
  const visited = new Set();

  for (const [pluginId, enabled] of Object.entries(enabledPlugins)) {
    if (enabled !== true) continue;

    const installs = installedPlugins[pluginId];
    if (!Array.isArray(installs)) continue;

    for (const install of installs) {
      const installPath = install?.installPath;
      if (!installPath) continue;

      // Plugin payloads live in sibling directories of the versioned install folder
      let pluginFolders;
      try {
        const entries = await fs.readdir(path.dirname(installPath), { withFileTypes: true });
        pluginFolders = entries
          .filter(e => e.isDirectory())
          .map(e => path.join(path.dirname(installPath), e.name));
      } catch { continue; }

      for (const pluginFolder of pluginFolders) {
        const key = `${pluginId}:${path.resolve(pluginFolder)}`;
        if (visited.has(key)) continue;
        visited.add(key);

        const pluginName = await readPluginName(pluginFolder, pluginId);
        if (!pluginName) continue;

        const commandsPath = path.join(pluginFolder, 'commands');
        if (await isDir(commandsPath)) {
          skills.push(...await scanCommandFiles(commandsPath, pluginId, pluginName));
          continue;
        }

        const skillsPath = path.join(pluginFolder, 'skills');
        if (await isDir(skillsPath)) {
          skills.push(...await scanSkillDirs(skillsPath, pluginId, pluginName));
        }
      }
    }
  }

  return skills;
}

async function isDir(p) {
  try { return (await fs.stat(p)).isDirectory(); } catch { return false; }
}

async function readPluginName(pluginFolder, pluginId) {
  try {
    const cfg = JSON.parse(
      await fs.readFile(path.join(pluginFolder, '.claude-plugin', 'plugin.json'), 'utf8')
    );
    if (typeof cfg.name === 'string' && cfg.name) return cfg.name;
  } catch { /* fall through */ }
  const [name] = (pluginId || '').trim().split('@');
  return name || null;
}

async function scanCommandFiles(commandsPath, pluginId, pluginName) {
  const skills = [];
  try {
    const entries = await fs.readdir(commandsPath, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.toLowerCase().endsWith('.md')) continue;
      const sourcePath = path.join(commandsPath, entry.name);
      try {
        const { data } = parseFrontmatter(await fs.readFile(sourcePath, 'utf8'));
        const name = entry.name.replace(/\.md$/i, '');
        skills.push({ name, description: data.description || '', command: `/${pluginName}:${name}`, scope: 'plugin', sourcePath, pluginName, pluginId });
      } catch { /* skip malformed */ }
    }
  } catch { /* skip unreadable */ }
  return skills;
}

async function scanSkillDirs(skillsPath, pluginId, pluginName) {
  const skills = [];
  try {
    const entries = await fs.readdir(skillsPath, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const skillMd = path.join(skillsPath, entry.name, 'SKILL.md');
      try {
        const { data } = parseFrontmatter(await fs.readFile(skillMd, 'utf8'));
        const name = entry.name;
        skills.push({ name, description: data.description || '', command: `/${pluginName}:${name}`, scope: 'plugin', sourcePath: skillMd, pluginName, pluginId });
      } catch { /* skip */ }
    }
  } catch { /* skip */ }
  return skills;
}

export default router;
