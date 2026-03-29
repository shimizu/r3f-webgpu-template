#!/usr/bin/env python3
import json
import subprocess
from pathlib import Path


def find_repo_root(start: Path) -> Path:
  for candidate in [start, *start.parents]:
    if (candidate / ".git").exists() or (candidate / "AGENTS.md").exists():
      return candidate
  return start


def run_git(repo_root: Path, *args: str) -> str:
  result = subprocess.run(
    ["git", *args],
    cwd=repo_root,
    check=False,
    capture_output=True,
    text=True,
  )
  if result.returncode != 0:
    return ""
  return result.stdout.strip()


def main() -> int:
  payload = json.load(__import__("sys").stdin)
  cwd = Path(payload.get("cwd") or ".").resolve()
  repo_root = find_repo_root(cwd)
  stop_hook_active = bool(payload.get("stop_hook_active"))
  working_memory_path = repo_root / "working-memory.md"

  if stop_hook_active:
    print(json.dumps({"continue": True}, ensure_ascii=False))
    return 0

  branch = run_git(repo_root, "branch", "--show-current") or "(unknown)"
  commit = run_git(repo_root, "rev-parse", "--short", "HEAD") or "(unknown)"
  status = run_git(repo_root, "status", "--short")
  status_summary = status if status else "(clean)"
  memory_exists = "exists" if working_memory_path.exists() else "missing"

  reason = (
    "作業終了前に working-memory.md の整合確認をしてください。"
    f"\nbranch: {branch}"
    f"\ncommit: {commit}"
    f"\nworking-memory: {memory_exists}"
    f"\ngit status:\n{status_summary}"
    "\n確認項目: current branch / latest meaningful commit / current implementation status / "
    "open decisions / next recommended tasks / key files."
    "\nズレがあれば working-memory.md を更新してから終了してください。"
  )

  print(
    json.dumps(
      {
        "decision": "block",
        "reason": reason,
      },
      ensure_ascii=False,
    )
  )
  return 0


if __name__ == "__main__":
  raise SystemExit(main())
