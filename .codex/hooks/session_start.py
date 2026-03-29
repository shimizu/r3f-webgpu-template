#!/usr/bin/env python3
import json
from pathlib import Path


def find_repo_root(start: Path) -> Path:
  for candidate in [start, *start.parents]:
    if (candidate / ".git").exists() or (candidate / "AGENTS.md").exists():
      return candidate
  return start


def main() -> int:
  payload = json.load(__import__("sys").stdin)
  cwd = Path(payload.get("cwd") or ".").resolve()
  repo_root = find_repo_root(cwd)
  working_memory_path = repo_root / "working-memory.md"

  if not working_memory_path.exists():
    print(
      json.dumps(
        {
          "continue": True,
          "systemMessage": (
            f"working-memory.md が見つかりません: {working_memory_path}. "
            "作業前に最新の作業メモを確認してください。"
          ),
        },
        ensure_ascii=False,
      )
    )
    return 0

  content = working_memory_path.read_text(encoding="utf-8").strip()
  additional_context = (
    "作業開始前に working-memory.md を必ず前提として扱ってください。"
    f"\npath: {working_memory_path}"
    "\n以下が現在の working memory です:\n\n"
    f"{content}\n"
  )

  print(
    json.dumps(
      {
        "continue": True,
        "hookSpecificOutput": {
          "hookEventName": "SessionStart",
          "additionalContext": additional_context,
        },
      },
      ensure_ascii=False,
    )
  )
  return 0


if __name__ == "__main__":
  raise SystemExit(main())
