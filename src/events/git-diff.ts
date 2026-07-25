import { spawnSync } from "child_process";
import fs from "fs";
import type { Logger } from "../logger.js";

export interface DiffResult {
  diff: string;
  filePath: string;
  type: "modified" | "created" | "deleted";
  content?: string;
}

const GIT_TIMEOUT = 10_000;
const GIT_MAX_BUFFER = 1024 * 1024; // 1MB

// ── Проверка: находимся ли в git-репозитории ──

function isGitRepo(): boolean {
  const result = spawnSync("git", ["rev-parse", "--git-dir"], {
    stdio: "pipe",
    timeout: GIT_TIMEOUT,
  });
  return result.status === 0;
}

// ── Diff для отслеживаемого (staged) файла ──

function gitDiffStaged(filePath: string, log?: Logger): string {
  try {
    const result = spawnSync("git", ["diff", "HEAD", "--", filePath], {
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
      maxBuffer: GIT_MAX_BUFFER,
      timeout: GIT_TIMEOUT,
    });
    return result.stdout || "";
  } catch (err) {
    log?.debug(
      `git diff HEAD не удался: ${err instanceof Error ? err.message : String(err)}`
    );
    return "";
  }
}

// ── Diff для нового (не в HEAD) файла ──

function gitDiffNew(filePath: string, log?: Logger): string {
  try {
    const result = spawnSync(
      "git",
      ["diff", "--no-index", "/dev/null", filePath],
      {
        encoding: "utf-8",
        stdio: ["pipe", "pipe", "pipe"],
        maxBuffer: GIT_MAX_BUFFER,
        timeout: GIT_TIMEOUT,
      }
    );
    return result.stdout || "";
  } catch (err) {
    log?.debug(
      `git diff --no-index не удался: ${err instanceof Error ? err.message : String(err)}`
    );
    return "";
  }
}

/**
 * Получает diff изменённого файла через git.
 * Если git недоступен или не в репозитории — читает содержимое файла.
 */
export function getGitDiff(filePath: string, log?: Logger): DiffResult {
  const exists = fs.existsSync(filePath);

  // Файл удалён
  if (!exists) {
    return { diff: "", filePath, type: "deleted" };
  }

  let type: DiffResult["type"] = "modified";
  let content = "";

  // Не git-репозиторий — просто читаем файл
  if (!isGitRepo()) {
    log?.debug("Не git-репозиторий, читаем файл напрямую");
    try {
      content = fs.readFileSync(filePath, "utf-8");
    } catch (readErr) {
      log?.debug(
        `Не удалось прочитать файл: ${readErr instanceof Error ? readErr.message : String(readErr)}`
      );
    }
    return { diff: "", filePath, type: exists ? "modified" : "deleted", content };
  }

  // Пытаемся получить staged diff
  let diff = gitDiffStaged(filePath, log);

  // Если файл новый (не в HEAD) — пробуем diff --no-index
  if (!diff.trim()) {
    const newDiff = gitDiffNew(filePath, log);
    if (newDiff.trim()) {
      diff = newDiff;
      type = "created";
    }
  }

  // Если всё ещё нет diff — читаем как есть
  if (!diff.trim()) {
    content = fs.readFileSync(filePath, "utf-8");
    return { diff, filePath, type, content };
  }

  return { diff, filePath, type };
}

/**
 * Обрезает diff до разумного размера для отправки в LLM.
 */
export function truncateDiff(diff: string, maxLines: number = 200): string {
  const lines = diff.split("\n");
  if (lines.length <= maxLines) return diff;

  const head = lines.slice(0, Math.ceil(maxLines / 2));
  const tail = lines.slice(-Math.floor(maxLines / 2));
  return [
    ...head,
    `... (пропущено ${lines.length - maxLines} строк)`,
    ...tail,
  ].join("\n");
}
