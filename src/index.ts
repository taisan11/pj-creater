#!/usr/bin/env bun
import { intro, outro, text, select, confirm, isCancel, cancel, spinner } from "@clack/prompts";
import { existsSync } from "node:fs";
import { mkdir, lstat, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve, basename } from "node:path";
import { spawnSync } from "node:child_process";
import {safeParse} from "valibot";
import { configSchema,GConfigSchema } from "./types";
import type {TemplateSource, PromptConfig, CreatorConfig} from "./types";

const CACHE_ROOT = join(homedir(), ".pj-creator", "cache");
// const GCONFIG_PATH = join(homedir(),".pj-creator","config.json")
const MANUAL_OPTION = "__manual__";
let CACHE_TTL_MS = 1000 * 60 * 60 * 24 * 30;

// const ensureDefaultConfig = async () => {
//   const defaultConfig = { cache: { ttl: CACHE_TTL_MS } };
//   await writeFile(GCONFIG_PATH, JSON.stringify(defaultConfig));
//   return defaultConfig;
// };

// async function loadGConfig() {
//   if (!existsSync(GCONFIG_PATH)) return ensureDefaultConfig();

//   const result = safeParse(GConfigSchema, await readFile(GCONFIG_PATH));
//   return result.success ? result.output : ensureDefaultConfig();
// }

const hasCommand = (cmd: string) => {
  const result = spawnSync(cmd, ["--version"], { stdio: "ignore" });
  return result.status === 0;
};

const isBinaryBuffer = (buffer: Uint8Array) => {
  const limit = Math.min(buffer.length, 8000);
  for (let i = 0; i < limit; i += 1) {
    if (buffer[i] === 0) return true;
  }
  return false;
};

const isSubPath = (relPath: string, segment: string) =>
  relPath === segment || relPath.startsWith(segment + "/") || relPath.startsWith(segment + "\\");

const parseTemplateSource = (raw: string): TemplateSource => {
  const resolved = resolve(raw);
  if (existsSync(resolved)) {
    return { kind: "local", root: resolved };
  }

  const normalized = raw.startsWith("gh:") ? raw.slice(3) : raw;
  const match = normalized.match(/^([^/]+)\/([^/]+)(\/.*)?$/);
  if (!match) {
    throw new Error("テンプレート指定が不正です。例: gh:username/repo/path");
  }
  const repo = `${match[1]}/${match[2]}`;
  const path = match[3] ? match[3].replace(/^\//, "") : null;
  return { kind: "github", repo, path };
};

const ensureCacheDir = async () => {
  await mkdir(CACHE_ROOT, { recursive: true });
};

const isCacheStale = async (repoDir: string) => {
  const info = await stat(repoDir);
  const age = Date.now() - info.mtime.getTime();
  return age > CACHE_TTL_MS;
};

const fetchRepo = async (repo: string, update: boolean) => {
  const repoDir = join(CACHE_ROOT, repo.replace("/", "__"));
  if (existsSync(repoDir)) {
    const stale = await isCacheStale(repoDir);
    if (!update && !stale) return repoDir;
    await rm(repoDir, { recursive: true, force: true });
  }

  await ensureCacheDir();
  const useGh = hasCommand("gh");
  const useGit = hasCommand("git");
  if (!useGh && !useGit) {
    throw new Error("gh か git が見つかりません。どちらかをインストールしてください。");
  }

  const spin = spinner();
  spin.start(`テンプレート取得中: ${repo}`);
  if (useGh) {
    const result = spawnSync("gh", ["repo", "clone", repo, repoDir], { stdio: "inherit" });
    if (result.status !== 0) {
      spin.stop("テンプレート取得に失敗しました。");
      throw new Error("gh での clone に失敗しました。");
    }
  } else {
    const url = `https://github.com/${repo}.git`;
    const result = spawnSync("git", ["clone", "--depth", "1", url, repoDir], { stdio: "inherit" });
    if (result.status !== 0) {
      spin.stop("テンプレート取得に失敗しました。");
      throw new Error("git での clone に失敗しました。");
    }
  }
  spin.stop("テンプレート取得完了");
  return repoDir;
};

const loadConfigs = async (templateRoot: string) => {
  const glob = new Bun.Glob("**/creator.json");
  const configs: { path: string; depth: number; config: CreatorConfig; configDir: string }[] = [];

  for await (const relPath of glob.scan({ cwd: templateRoot, dot: true, onlyFiles: true })) {
    const absPath = join(templateRoot, relPath);
    const configDir = resolve(absPath, "..");
    const content = await readFile(absPath, "utf8");
    const parsed = JSON.parse(content) as unknown;
    const result = safeParse(configSchema, parsed);
    if (!result.success) {
      throw new Error(`creator.json が不正です: ${absPath}`);
    }
    const config = result.output;
    const depth = relPath.split(/[\\/]/).length;
    configs.push({ path: absPath, depth, config, configDir });
  }

  return configs;
};

type DirectoryNode = {
  name: string;
  path: string;
  children: Map<string, DirectoryNode>;
  hasConfig: boolean;
};

const buildDirTree = async (rootPath: string): Promise<DirectoryNode> => {
  const root: DirectoryNode = {
    name: ".",
    path: rootPath,
    children: new Map(),
    hasConfig: existsSync(join(rootPath, "creator.json")),
  };

  const queue: DirectoryNode[] = [root];
  while (queue.length > 0) {
    const node = queue.shift()!;
    const entries = await readdir(node.path, { withFileTypes: true });
    
    for (const entry of entries) {
      if (entry.isDirectory() && !entry.name.startsWith(".")) {
        const childPath = join(node.path, entry.name);
        const childNode: DirectoryNode = {
          name: entry.name,
          path: childPath,
          children: new Map(),
          hasConfig: existsSync(join(childPath, "creator.json")),
        };
        node.children.set(entry.name, childNode);
        queue.push(childNode);
      }
    }
  }

  return root;
};

const selectTemplateDir = async (
  node: DirectoryNode,
  pathStack: string[] = []
): Promise<DirectoryNode> => {
  // このディレクトリに creator.json がなければここが確定
  if (!node.hasConfig) {
    return node;
  }

  // 子ディレクトリがなければここが確定
  if (node.children.size === 0) {
    return node;
  }

  // 子ディレクトリを選択肢として表示
  const options = Array.from(node.children.values()).map((child) => ({
    label: child.name,
    value: child.name,
  }));

  const picked = await select({
    message: pathStack.length === 0
      ? "テンプレートを選択してください"
      : `"${pathStack.join("/")}" の次を選択してください`,
    options,
  });

  if (isCancel(picked)) {
    cancel("キャンセルしました。");
    process.exit(0);
  }

  const selectedChild = node.children.get(String(picked));
  if (!selectedChild) {
    cancel("選択が無効です。");
    process.exit(1);
  }

  return selectTemplateDir(selectedChild, [...pathStack, String(picked)]);
};

const collectAllConfigs = async (
  selectedDir: DirectoryNode,
  rootPath: string
): Promise<{ configs: CreatorConfig[]; paths: string[]; selectedDirConfig: CreatorConfig | undefined }> => {
  const configs: CreatorConfig[] = [];
  const paths: string[] = [];
  const visited = new Set<string>();
  let selectedDirConfig: CreatorConfig | undefined;

  // ルートから選択されたディレクトリまでのパスを生成
  const pathChain: string[] = [];
  let current = selectedDir.path;
  while (current && current !== rootPath && !visited.has(current)) {
    pathChain.unshift(current);
    visited.add(current);
    current = resolve(current, "..");
  }
  pathChain.unshift(rootPath); // ルートを追加

  // 各階層の creator.json を読み込む
  for (const dirPath of pathChain) {
    const configPath = join(dirPath, "creator.json");
    if (existsSync(configPath)) {
      const content = await readFile(configPath, "utf8");
      const parsed = JSON.parse(content) as unknown;
      const result = safeParse(configSchema, parsed);
      if (!result.success) {
        throw new Error(`creator.json が不正です: ${configPath}`);
      }
      configs.push(result.output);
      paths.push(dirPath);
      
      // 選択されたディレクトリの config を保存
      if (dirPath === selectedDir.path) {
        selectedDirConfig = result.output;
      }
    }
  }

  // copyFrom で指定されたディレクトリの config も収集（prompts のみ使用）
  const toProcess: CreatorConfig[] = selectedDirConfig?.files?.copyFrom ? [selectedDirConfig] : [];
  const processedCopyFroms = new Set<string>();
  
  while (toProcess.length > 0) {
    const config = toProcess.shift();
    if (config?.files?.copyFrom) {
      for (const copyPath of config.files.copyFrom) {
        // selectedDir を基準に解決
        const resolvedPath = resolve(selectedDir.path, copyPath);
        if (!visited.has(resolvedPath) && !processedCopyFroms.has(resolvedPath) && existsSync(resolvedPath)) {
          visited.add(resolvedPath);
          processedCopyFroms.add(resolvedPath);
          const copyConfigPath = join(resolvedPath, "creator.json");
          if (existsSync(copyConfigPath)) {
            const content = await readFile(copyConfigPath, "utf8");
            const parsed = JSON.parse(content) as unknown;
            const result = safeParse(configSchema, parsed);
            if (!result.success) {
              throw new Error(`creator.json が不正です: ${copyConfigPath}`);
            }
            configs.push(result.output);
            paths.push(resolvedPath);
            // copyFrom の連鎖は prompts のみ収集するため、files.copyFrom は無視
          }
        }
      }
    }
  }

  return { configs, paths, selectedDirConfig };
};

const mergeConfigs = (
  configs: CreatorConfig[],
  selectedDirConfig: CreatorConfig | undefined
): {
  prompts: PromptConfig[];
  files: CreatorConfig["files"];
} => {
  const promptMap = new Map<string, PromptConfig>();

  // 全ての config から prompts をマージ
  for (const config of configs) {
    if (config.prompts) {
      for (const prompt of config.prompts) {
        promptMap.set(prompt.name, prompt);
      }
    }
  }

  const mergedPrompts = Array.from(promptMap.values());

  // files は選択されたディレクトリのもののみ使用（途中ディレクトリは無視）
  const files = selectedDirConfig?.files || undefined;

  return { prompts: mergedPrompts, files };
};

const askPrompts = async (prompts: PromptConfig[]) => {
  const values: Record<string, string | boolean> = {};
  for (const prompt of prompts) {
    if (prompt.type === "text") {
      const result = await text({
        message: prompt.message,
        initialValue: prompt.initial,
      });
      if (isCancel(result)) {
        cancel("キャンセルしました。");
        process.exit(0);
      }
      values[prompt.name] = String(result);
      continue;
    }

    if (prompt.type === "confirm") {
      const result = await confirm({ message: prompt.message, initialValue: false });
      if (isCancel(result)) {
        cancel("キャンセルしました。");
        process.exit(0);
      }
      values[prompt.name] = Boolean(result);
      continue;
    }

    if (prompt.type === "select") {
      const options =
        prompt.options?.map((option) =>
          typeof option === "string" ? { label: option, value: option } : option,
        ) ?? [];
      const result = await select({ message: prompt.message, options });
      if (isCancel(result)) {
        cancel("キャンセルしました。");
        process.exit(0);
      }
      values[prompt.name] = String(result);
    }
  }
  return values;
};

const renderTemplate = (content: string, data: Record<string, string | boolean>) =>
  content.replace(/<%=\s*([a-zA-Z0-9_.-]+)\s*%>/g, (_, key: string) => {
    const value = data[key];
    return value === undefined ? "" : String(value);
  });

const collectFileList = async (
  templateRoot: string,
  configDir: string,
  files: CreatorConfig["files"]
): Promise<Array<{ sourcePath: string; targetPath: string }>> => {
  const fileMap = new Map<string, string>(); // targetPath -> sourcePath

  const include = files?.include ?? ["**/*"];
  for (const pattern of include) {
    const glob = new Bun.Glob(pattern);
    for await (const relPath of glob.scan({ cwd: configDir, dot: true })) {
      // configDir からの相対パス = そのまま出力先のパスとして使用
      const sourcePath = join(configDir, relPath);
      fileMap.set(relPath, sourcePath);
    }
  }

  if (files?.exclude?.length) {
    for (const pattern of files.exclude) {
      const glob = new Bun.Glob(pattern);
      for await (const relPath of glob.scan({ cwd: configDir, dot: true })) {
        fileMap.delete(relPath);
      }
    }
  }

  // copyFrom で指定されたディレクトリからもファイルを収集
  if (files?.copyFrom?.length) {
    for (const copyPath of files.copyFrom) {
      const resolvedCopyPath = resolve(join(configDir, copyPath));
      if (!existsSync(resolvedCopyPath)) continue;
      
      const copyStats = await stat(resolvedCopyPath);
      if (!copyStats.isDirectory()) continue;

      const glob = new Bun.Glob("**/*");
      for await (const relPath of glob.scan({ cwd: resolvedCopyPath, dot: true })) {
        const sourcePath = join(resolvedCopyPath, relPath);
        // copyFrom のファイルは templateRoot からの相対パスで保存
        const relFromRoot = resolve(sourcePath).replace(resolve(templateRoot) + "\\", "").replace(resolve(templateRoot) + "/", "");
        fileMap.set(relFromRoot, sourcePath);
      }
    }
  }

  return Array.from(fileMap.entries()).map(([targetPath, sourcePath]) => ({
    sourcePath,
    targetPath,
  }));
};

const copyTemplate = async (
  templateRoot: string,
  outputRoot: string,
  data: Record<string, string | boolean>,
  configDir: string,
  files: CreatorConfig["files"],
) => {
  const fileList = await collectFileList(templateRoot, configDir, files);

  for (const { sourcePath, targetPath } of fileList) {
    if (isSubPath(targetPath, ".git")) continue;
    if (targetPath.endsWith("creator.json")) continue;

    const stat = await lstat(sourcePath);
    const fullTargetPath = join(outputRoot, targetPath);

    if (stat.isDirectory()) {
      await mkdir(fullTargetPath, { recursive: true });
      continue;
    }
    if (!stat.isFile()) continue;

    await mkdir(join(fullTargetPath, ".."), { recursive: true });
    const buffer = await readFile(sourcePath);
    if (isBinaryBuffer(buffer)) {
      await writeFile(fullTargetPath, buffer);
      continue;
    }
    const content = buffer.toString("utf8");
    const rendered = renderTemplate(content, data);
    await writeFile(fullTargetPath, rendered, "utf8");
  }
};

type TemplateNode = {
  name: string;
  children: Map<string, TemplateNode>;
  fullPath: string | null; // leaf node に設定
};

const buildTemplateTree = (paths: string[]): TemplateNode => {
  const root: TemplateNode = { name: "root", children: new Map(), fullPath: null };

  for (const path of paths) {
    const segments: string[] = path.split("__").filter(Boolean);
    let current = root;
    for (let i = 0; i < segments.length; i++) {
      const segment: string = segments[i]!;
      if (!current.children.has(segment)) {
        current.children.set(segment, {
          name: segment,
          children: new Map(),
          fullPath: i === segments.length - 1 ? segments.join("/") : null,
        });
      }
      current = current.children.get(segment)!;
    }
  }

  return root;
};

const selectTemplate = async (node: TemplateNode, currentPath: string[] = []): Promise<string> => {
  const options = Array.from(node.children.entries()).map(([name, child]) => ({
    label: name,
    value: name,
  }));

  // リーフノードはない場合は手入力オプション追加
  const hasValidLeaves = Array.from(node.children.values()).some((child) => child.fullPath);

  const picked = await select({
    message: currentPath.length === 0 ? "テンプレートを選択してください" : `"${currentPath.join("/")}" の次を選択してください`,
    options,
  });

  if (isCancel(picked)) {
    cancel("キャンセルしました。");
    process.exit(0);
  }

  const selectedNode = node.children.get(String(picked))!;
  const nextPath = [...currentPath, String(picked)];

  // リーフノードならそこまで
  if (selectedNode.fullPath) {
    return selectedNode.fullPath;
  }

  // さらに深い階層があればそこを選択
  return selectTemplate(selectedNode, nextPath);
};

const pickTemplateArg = async (arg?: string) => {
  if (arg) return arg;
  await ensureCacheDir();
  const entries = await readdir(CACHE_ROOT, { withFileTypes: true });
  const cached = entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name);

  if (cached.length === 0) {
    const result = await text({
      message: "テンプレートを指定してください (例: gh:username/repo/path)",
      placeholder: "gh:username/repo/path",
    });
    if (isCancel(result)) {
      cancel("キャンセルしました。");
      process.exit(0);
    }
    return String(result);
  }

  const tree = buildTemplateTree(cached);
  
  // ルートに直下の子がない場合は手入力へ
  if (tree.children.size === 0) {
    const result = await text({
      message: "テンプレートを指定してください (例: gh:username/repo/path)",
      placeholder: "gh:username/repo/path",
    });
    if (isCancel(result)) {
      cancel("キャンセルしました。");
      process.exit(0);
    }
    return String(result);
  }

  // 手入力オプションを追加
  const optionsWithManual = [
    { label: "手入力する", value: MANUAL_OPTION },
    ...Array.from(tree.children.entries()).map(([name]) => ({
      label: name,
      value: name,
    })),
  ];

  const firstPick = await select({
    message: "テンプレートを選択してください",
    options: optionsWithManual,
  });

  if (isCancel(firstPick)) {
    cancel("キャンセルしました。");
    process.exit(0);
  }

  if (firstPick === MANUAL_OPTION) {
    const result = await text({
      message: "テンプレートを指定してください (例: gh:username/repo/path)",
      placeholder: "gh:username/repo/path",
    });
    if (isCancel(result)) {
      cancel("キャンセルしました。");
      process.exit(0);
    }
    return String(result);
  }

  const selectedNode = tree.children.get(String(firstPick))!;

  // リーフノードならそこまで
  if (selectedNode.fullPath) {
    return selectedNode.fullPath;
  }

  // さらに深い階層があればそこを選択
  return selectTemplate(selectedNode, [String(firstPick)]);
};

const main = async () => {
  intro("pj-creator");
  if (!existsSync(CACHE_ROOT)) {
    await mkdir(CACHE_ROOT)
  }
  // const config = await loadGConfig()
  // CACHE_TTL_MS = config.cache.ttl

  const args = process.argv.slice(2);
  const [firstArg] = args;
  if (firstArg === "clean") {
    await rm(CACHE_ROOT, { recursive: true, force: true });
    outro("キャッシュを削除しました。");
    return;
  }
  const positional: string[] = [];
  let update = false;
  for (const arg of args) {
    if (arg === "--update") {
      update = true;
      continue;
    }
    positional.push(arg);
  }

  const [templateArg, outArg] = positional;
  const templateInput = await pickTemplateArg(templateArg);
  const outputRoot = outArg ? resolve(outArg) : process.cwd();

  let templateRoot = "";
  const source = parseTemplateSource(templateInput);

  if (source.kind === "local") {
    templateRoot = source.root;
  } else {
    const repoDir = await fetchRepo(source.repo, update);
    templateRoot = source.path ? join(repoDir, source.path) : repoDir;
  }

  if (!existsSync(templateRoot)) {
    cancel("テンプレートのパスが存在しません。");
    process.exit(1);
  }

  // templateRoot内に`template`ディレクトリがあればそこを使用
  const templateSubDir = join(templateRoot, "template");
  if (existsSync(templateSubDir)) {
    const stats = await stat(templateSubDir);
    if (stats.isDirectory()) {
      templateRoot = templateSubDir;
    }
  }

  // 新しい仕組み：ディレクトリツリーを構築して選択
  const dirTree = await buildDirTree(templateRoot);
  const selectedDir = await selectTemplateDir(dirTree);

  // 選択されたディレクトリまでの全ての creator.json を収集＆マージ
  const { configs, paths, selectedDirConfig } = await collectAllConfigs(selectedDir, templateRoot);
  const { prompts, files } = mergeConfigs(configs, selectedDirConfig);

  const values = prompts.length ? await askPrompts(prompts) : {};
  
  // selectedDir がテンプレートの実際のルート
  await copyTemplate(templateRoot, outputRoot, values, selectedDir.path, files);

  outro("テンプレートを作成しました。");
};

main().catch((error) => {
  cancel(error instanceof Error ? error.message : "不明なエラーが発生しました。");
  process.exit(1);
});
