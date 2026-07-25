import path from "path";

/**
 * Безопасный resolve пути. Проверяет, что результат находится внутри workspaceDir.
 * Бросает ошибку при попытке path traversal.
 */
export function resolveSafePath(inputDir: string, workspaceDir: string): string {
  const workspaceResolved = path.resolve(workspaceDir);
  const resolved = path.resolve(workspaceDir, inputDir);

  if (
    !resolved.startsWith(workspaceResolved + path.sep) &&
    resolved !== workspaceResolved
  ) {
    throw new Error(
      `Path traversal: "${inputDir}" выходит за пределы "${workspaceDir}"`
    );
  }

  return resolved;
}
