#!/usr/bin/env node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, '..');
const targetDir = path.join(
  os.homedir(),
  '.gemini',
  'config',
  'plugins',
  'antigravity-usage-monitor',
);

function copyRecursive(src, dest) {
  const stat = fs.statSync(src);
  if (stat.isDirectory()) {
    fs.mkdirSync(dest, { recursive: true });
    for (const entry of fs.readdirSync(src)) {
      copyRecursive(path.join(src, entry), path.join(dest, entry));
    }
  } else {
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.copyFileSync(src, dest);
  }
}

function main() {
  const distDir = path.join(projectRoot, 'dist');
  const uiHtml = path.join(distDir, 'ui', 'index.html');
  if (!fs.existsSync(distDir) || !fs.existsSync(uiHtml)) {
    console.error('请先运行 "npm run build" 构建 dist/ 与单文件 MCP App 前端。');
    process.exit(1);
  }

  fs.mkdirSync(targetDir, { recursive: true });

  // Copy plugin manifest, mcp_config, hooks, skills, assets
  copyRecursive(path.join(projectRoot, 'plugin'), targetDir);
  // Copy README and built dist
  fs.copyFileSync(path.join(projectRoot, 'README.md'), path.join(targetDir, 'README.md'));
  fs.copyFileSync(path.join(projectRoot, 'package.json'), path.join(targetDir, 'package.json'));
  copyRecursive(distDir, path.join(targetDir, 'dist'));

  // Symlink or copy runtime node_modules needed by MCP server (@modelcontextprotocol/sdk, zod)
  const srcNodeModules = path.join(projectRoot, 'node_modules');
  const destNodeModules = path.join(targetDir, 'node_modules');
  if (fs.existsSync(srcNodeModules) && !fs.existsSync(destNodeModules)) {
    try {
      fs.symlinkSync(srcNodeModules, destNodeModules, 'junction');
    } catch {
      copyRecursive(srcNodeModules, destNodeModules);
    }
  }

  console.log(`✅ 插件已安装至: ${targetDir}`);
  console.log('Antigravity 会自动发现新插件，无需重启即可在 Customizations / 侧边栏 "+" 菜单 / 左侧导航中启用。');
}

main();
