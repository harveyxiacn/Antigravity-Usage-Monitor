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
  const bundleServer = path.join(projectRoot, 'dist', 'bundle', 'server.mjs');
  const uiHtml = path.join(projectRoot, 'dist', 'ui', 'index.html');
  if (!fs.existsSync(bundleServer) || !fs.existsSync(uiHtml)) {
    console.error('请先运行 "npm run build" 构建单文件 bundle 与 MCP App 前端。');
    process.exit(1);
  }

  fs.mkdirSync(targetDir, { recursive: true });

  // Remove legacy node_modules junction if present (v1.3+ is 100% standalone zero-dependency!)
  const legacyNodeModules = path.join(targetDir, 'node_modules');
  if (fs.existsSync(legacyNodeModules)) {
    try {
      fs.rmSync(legacyNodeModules, { recursive: true, force: true });
    } catch {
      // ignore if locked
    }
  }

  // Copy plugin manifest, mcp_config, hooks, skills, assets
  copyRecursive(path.join(projectRoot, 'plugin'), targetDir);
  fs.copyFileSync(path.join(projectRoot, 'README.md'), path.join(targetDir, 'README.md'));
  fs.copyFileSync(path.join(projectRoot, 'package.json'), path.join(targetDir, 'package.json'));

  // Copy only the standalone bundles and single-file UI HTML (no node_modules needed!)
  copyRecursive(path.join(projectRoot, 'dist', 'bundle'), path.join(targetDir, 'dist', 'bundle'));
  copyRecursive(path.join(projectRoot, 'dist', 'ui'), path.join(targetDir, 'dist', 'ui'));

  // Populate sidecar folder with standalone main.mjs and index.html for right-hand Plugins -> Usage Monitor pane
  const sidecarTargetDir = path.join(targetDir, 'sidecars', 'usage_monitor');
  fs.mkdirSync(sidecarTargetDir, { recursive: true });
  fs.copyFileSync(
    path.join(projectRoot, 'dist', 'bundle', 'sidecar.mjs'),
    path.join(sidecarTargetDir, 'main.mjs'),
  );
  fs.copyFileSync(
    path.join(projectRoot, 'dist', 'ui', 'index.html'),
    path.join(sidecarTargetDir, 'index.html'),
  );

  console.log(`✅ 零依赖独立插件（含右侧 Sidecar UI 面板）已安装至: ${targetDir}`);
  console.log('无需 node_modules，Antigravity 会自动发现并加载插件。');
}

main();
