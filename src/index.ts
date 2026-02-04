#!/usr/bin/env bun
import { intro, outro, text, select, confirm, isCancel, cancel, spinner } from "@clack/prompts";
import { existsSync } from "node:fs";
import { mkdir, lstat, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import * as v from "valibot";

type PromptType = "text" | "select" | "confirm";
type PromptOption = string | { label: string; value: string; hint?: string };
type PromptConfig = {
  name: string;
  type: PromptType;
  message: string;
  initial?: string;
  options?: PromptOption[];
};
type CreaterConfig = {
  name?: string;
  description?: string;
  prompts?: PromptConfig[];
  files?: {
    include?: string[];
    exclude?: string[];
  };
};

type TemplateSource =
  | { kind: "local"; root: string }
  | { kind: "github"; repo: string; path: string | null };

const CACHE_ROOT = join(homedir(), ".pj-creater", "cache");
const MANUAL_OPTION = "__manual__";
const CACHE_TTL_MS = 1000 * 60 * 60 * 24 * 30;

const promptOptionSchema = v.union([
  v.string(),
  v.object({
    label: v.string(),
    value: v.string(),
    hint: v.optional(v.string()),
  }),
]);
const promptSchema = v.object({
  name: v.string(),
  type: v.picklist(["text", "select", "confirm"]),
  message: v.string(),
  initial: v.optional(v.string()),
  options: v.optional(v.array(promptOptionSchema)),
});
const configSchema = v.object({
  name: v.optional(v.string()),
  description: v.optional(v.string()),
  prompts: v.optional(v.array(promptSchema)),
  files: v.optional(
    v.object({
      include: v.optional(v.array(v.string())),
      exclude: v.optional(v.array(v.string())),
    }),
  ),
});

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
  const glob = new Bun.Glob("**/creater.json");
  const configs: { path: string; depth: number; config: CreaterConfig }[] = [];

  for await (const relPath of glob.scan({ cwd: templateRoot, dot: true, onlyFiles: true })) {
    const absPath = join(templateRoot, relPath);
    const content = await readFile(absPath, "utf8");
    const parsed = JSON.parse(content) as unknown;
    const result = v.safeParse(configSchema, parsed);
    if (!result.success) {
      throw new Error(`creater.json が不正です: ${absPath}`);
    }
    const config = result.output;
    const depth = relPath.split(/[\\/]/).length;
    configs.push({ path: absPath, depth, config });
  }

  configs.sort((a, b) => a.depth - b.depth);
  const merged: PromptConfig[] = [];
  const indexByName = new Map<string, number>();
  let filesConfig: CreaterConfig["files"] | undefined;

  for (const { config } of configs) {
    if (config.prompts) {
      for (const prompt of config.prompts) {
        const existingIndex = indexByName.get(prompt.name);
        if (existingIndex === undefined) {
          indexByName.set(prompt.name, merged.length);
          merged.push(prompt);
        } else {
          merged[existingIndex] = prompt;
        }
      }
    }
    if (config.files) filesConfig = config.files;
  }

  return { prompts: merged, files: filesConfig };
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

const collectFileList = async (templateRoot: string, files: CreaterConfig["files"]) => {
  const all = new Set<string>();
  const include = files?.include ?? ["**/*"];
  for (const pattern of include) {
    const glob = new Bun.Glob(pattern);
    for await (const relPath of glob.scan({ cwd: templateRoot, dot: true })) {
      all.add(relPath);
    }
  }

  if (files?.exclude?.length) {
    for (const pattern of files.exclude) {
      const glob = new Bun.Glob(pattern);
      for await (const relPath of glob.scan({ cwd: templateRoot, dot: true })) {
        all.delete(relPath);
      }
    }
  }

  return Array.from(all);
};

const copyTemplate = async (
  templateRoot: string,
  outputRoot: string,
  data: Record<string, string | boolean>,
  files: CreaterConfig["files"],
) => {
  const relPaths = await collectFileList(templateRoot, files);

  for (const relPath of relPaths) {
    if (isSubPath(relPath, ".git")) continue;
    if (relPath.endsWith("creater.json")) continue;

    const sourcePath = join(templateRoot, relPath);
    const stat = await lstat(sourcePath);
    const targetPath = join(outputRoot, relPath);

    if (stat.isDirectory()) {
      await mkdir(targetPath, { recursive: true });
      continue;
    }
    if (!stat.isFile()) continue;

    await mkdir(join(targetPath, ".."), { recursive: true });
    const buffer = await readFile(sourcePath);
    if (isBinaryBuffer(buffer)) {
      await writeFile(targetPath, buffer);
      continue;
    }
    const content = buffer.toString("utf8");
    const rendered = renderTemplate(content, data);
    await writeFile(targetPath, rendered, "utf8");
  }
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

  const options = [
    { label: "手入力する", value: MANUAL_OPTION },
    ...cached.map((name) => ({
      label: name.split("__").join("/"),
      value: name,
    })),
  ];
  const picked = await select({ message: "テンプレートを選択してください", options });
  if (isCancel(picked)) {
    cancel("キャンセルしました。");
    process.exit(0);
  }
  if (picked === MANUAL_OPTION) {
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

  return String(picked).split("__").join("/");
};

const main = async () => {
  intro("pj-creater");

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

  const { prompts, files } = await loadConfigs(templateRoot);
  const values = prompts.length ? await askPrompts(prompts) : {};
  await copyTemplate(templateRoot, outputRoot, values, files);

  outro("テンプレートを作成しました。");
};

main().catch((error) => {
  cancel(error instanceof Error ? error.message : "不明なエラーが発生しました。");
  process.exit(1);
});
