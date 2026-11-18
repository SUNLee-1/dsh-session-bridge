/**
 * Locate the machine-specific pieces this plugin needs, on any platform.
 *
 * Nothing here is hard-coded to one install layout: the running DSH app is the
 * first source of truth, environment variables come next, and a per-platform
 * default is only the last resort. Every resolver returns `undefined` instead of
 * throwing, so a machine without DSH still gets a working CLI and MCP server.
 */
import fs from 'node:fs';
import path from 'node:path';

function isFile(candidate) {
  try {
    return Boolean(candidate) && fs.statSync(candidate).isFile();
  } catch {
    return false;
  }
}

/** Directories where a packaged DSH app keeps its CLI package. */
function installCandidates() {
  const list = [];
  if (process.env.DSH_INSTALL_DIR) list.push(process.env.DSH_INSTALL_DIR);
  const resources = process.resourcesPath;
  if (resources) {
    for (const mode of ['app.asar', 'app', 'resources']) {
      list.push(path.join(resources, mode, 'dsh', 'node_modules', '@deepseek-ai', 'dsh'));
    }
    list.push(path.join(resources, 'dsh', 'node_modules', '@deepseek-ai', 'dsh'));
  }
  const home = process.env.HOME ?? process.env.USERPROFILE ?? '';
  if (process.platform === 'darwin') {
    list.push('/Applications/DeepSeek Harness.app/Contents/Resources/app.asar/dsh/node_modules/@deepseek-ai/dsh');
    if (home) list.push(path.join(home, 'Applications/DeepSeek Harness.app/Contents/Resources/app.asar/dsh/node_modules/@deepseek-ai/dsh'));
  } else if (process.platform === 'win32') {
    const local = process.env.LOCALAPPDATA ?? '';
    for (const base of [local, process.env.PROGRAMFILES ?? '', process.env['PROGRAMFILES(X86)'] ?? '']) {
      if (!base) continue;
      list.push(path.join(base, 'Programs', 'DeepSeek Harness', 'resources', 'app.asar', 'dsh', 'node_modules', '@deepseek-ai', 'dsh'));
      list.push(path.join(base, 'DeepSeek Harness', 'resources', 'app.asar', 'dsh', 'node_modules', '@deepseek-ai', 'dsh'));
    }
  } else if (home) {
    list.push(path.join(home, '.local/share/deepseek-harness/resources/app.asar/dsh/node_modules/@deepseek-ai', 'dsh'));
    list.push(path.join(home, '.local/lib/node_modules/@deepseek-ai/dsh'));
  }
  return list;
}

let installCache;

/** @returns {string|undefined} the CLI package directory of the running DSH */
export function installDir() {
  if (installCache !== undefined) return installCache;
  for (const candidate of installCandidates()) {
    if (isFile(path.join(candidate, 'package.json'))) {
      installCache = candidate;
      return installCache;
    }
  }
  installCache = undefined;
  return undefined;
}

/** A sibling package inside the same installation, e.g. `dsh-tools`. */
export function installedPackage(name) {
  const base = installDir();
  return base ? path.join(base, '..', name) : undefined;
}

let binaryCache;

/**
 * A Node-capable executable from the harness installation, used for zstd on a
 * host Node older than 22.15. The running Electron binary itself is the most
 * reliable answer, and it exists on every platform.
 * @returns {string|undefined}
 */
export function electronBinary() {
  if (binaryCache !== undefined) return binaryCache;
  for (const candidate of [process.env.ASB_NODE, process.env.DSH_NODE_EXECUTABLE]) {
    if (isFile(candidate)) {
      binaryCache = candidate;
      return binaryCache;
    }
  }
  if (process.versions?.electron && isFile(process.execPath)) {
    binaryCache = process.execPath;
    return binaryCache;
  }
  const base = installDir();
  if (base) {
    const root = path.resolve(base, '..', '..', '..', '..');
    for (const candidate of [
      path.join(root, 'DeepSeek Harness'),
      path.join(root, 'DeepSeek Harness.exe'),
      path.join(root, 'electron'),
    ]) {
      if (isFile(candidate)) {
        binaryCache = candidate;
        return binaryCache;
      }
    }
  }
  binaryCache = undefined;
  return undefined;
}

/** Where each harness keeps its data, honouring per-platform overrides. */
export function codexHome() {
  return process.env.CODEX_HOME || path.join(process.env.HOME ?? process.env.USERPROFILE ?? '', '.codex');
}

export function dshHome() {
  return process.env.DSH_HOME || path.join(process.env.HOME ?? process.env.USERPROFILE ?? '', '.dsh');
}
