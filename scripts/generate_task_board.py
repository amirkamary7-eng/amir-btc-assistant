#!/usr/bin/env python3
"""Generate TASK_BOARD.md from گزارش 3.txt"""
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
REPORT = ROOT / "گزارش 3.txt"
OUTPUT = ROOT / "TASK_BOARD.md"

content = REPORT.read_text(encoding="utf-8")

graph_match = re.search(
    r"```\n(1\.0 \(manual verify\).*?5\.x cleanup, CI, docs, migrations\n)```",
    content,
    re.DOTALL,
)
dep_graph = graph_match.group(1) if graph_match else ""

def extract_inline(text: str, header: str) -> str:
    m = re.search(rf"\*\*{re.escape(header)}:\*\*\s*(.+)", text)
    return m.group(1).strip() if m else ""

def extract_block(text: str, header: str, next_headers: list[str]) -> str:
    pattern = rf"\*\*{re.escape(header)}:\*\*\s*\n"
    m = re.search(pattern, text)
    if not m:
        return ""
    start = m.end()
    end = len(text)
    for nh in next_headers:
        nm = re.search(rf"\*\*{re.escape(nh)}:\*\*", text[start:])
        if nm:
            end = min(end, start + nm.start())
    return text[start:end].rstrip()

def parse_task(block: str) -> dict:
    task_id_m = re.search(r"### TASK (\d+\.\d+)", block)
    if not task_id_m:
        raise ValueError("No task id")
    task_id = task_id_m.group(1)
    phase = int(task_id.split(".")[0])

    scope = extract_block(
        block,
        "Scope",
        ["Problem", "Objective", "Implementation Steps", "Acceptance Criteria", "Risks", "Dependencies", "Unblocks"],
    )
    steps = extract_block(
        block,
        "Implementation Steps",
        ["Acceptance Criteria", "Risks", "Dependencies", "Unblocks"],
    )
    acceptance = extract_block(
        block,
        "Acceptance Criteria",
        ["Risks", "Dependencies", "Unblocks"],
    )

    return {
        "id": task_id,
        "phase": phase,
        "title": extract_inline(block, "Title"),
        "type": extract_inline(block, "Type"),
        "priority": extract_inline(block, "Priority"),
        "scope": scope,
        "problem": extract_inline(block, "Problem"),
        "objective": extract_inline(block, "Objective"),
        "steps": steps,
        "acceptance": acceptance,
        "risks": extract_inline(block, "Risks"),
        "dependencies": extract_inline(block, "Dependencies"),
        "unblocks": extract_inline(block, "Unblocks"),
    }

blocks = re.split(r"(?=### TASK \d+\.\d+)", content)
tasks = []
for block in blocks:
    if not re.match(r"### TASK \d+\.\d+", block):
        continue
    tasks.append(parse_task(block))

tasks.sort(key=lambda t: (t["phase"], float(t["id"].split(".")[1])))

if len(tasks) != 54:
    raise SystemExit(f"Expected 54 tasks, got {len(tasks)}: {[t['id'] for t in tasks]}")

def is_none_dep(dep: str) -> bool:
    d = dep.strip().lower()
    return d == "none" or d.startswith("none ")

def phase_label(phase: int) -> str:
    labels = {
        1: "PHASE 1: Critical Stability",
        2: "PHASE 2: Core System Fix",
        3: "PHASE 3: Architecture Cleanup",
        4: "PHASE 4: Security Hardening",
        5: "PHASE 5: Optimization & Cleanup",
    }
    return labels[phase]

lines = []

lines.append("<!-- Task count: 54 tasks (1.0–5.12). Report footer says 48 — discrepancy noted; actual header count is 54. -->")
lines.append("")
lines.append("# TASK BOARD — Amir BTC Assistant")
lines.append("")
lines.append("## Single Source of Truth (SSOT)")
lines.append("")
lines.append("This file is the **central Single Source of Truth for task execution**, alongside [`گزارش 3.txt`](./گزارش%203.txt) for task definitions.")
lines.append("")
lines.append("### Agent Execution Rules")
lines.append("")
lines.append("1. **One task at a time** — pick a single task from \"Next Executable Tasks\", execute it fully, then update status.")
lines.append("2. **Check dependencies before starting** — do not start a task until every listed dependency is ✅ Done.")
lines.append("3. **Update status only after acceptance criteria met** — mark ✅ Done only when all acceptance criteria are verified.")
lines.append("4. **Blocked status rules** — use ⛔ Blocked when external input is required (operator IDs, secrets, live verification) or a dependency cannot proceed; document the blocker inline in the task section.")
lines.append("")
lines.append("## Status Legend")
lines.append("")
lines.append("| Symbol | Status |")
lines.append("|--------|--------|")
lines.append("| ⬜ | Todo |")
lines.append("| 🟨 | In Progress |")
lines.append("| ✅ | Done |")
lines.append("| ⛔ | Blocked |")
lines.append("")
lines.append("## Progress")
lines.append("")
lines.append("**0/54 done (0%)**")
lines.append("")
lines.append("## Dependency Graph")
lines.append("")
lines.append("```")
lines.append(dep_graph.rstrip())
lines.append("```")
lines.append("")
lines.append("## Master Execution Table")
lines.append("")
lines.append("| Exec# | Task ID | Phase | Title | Priority | Status | Dependencies | Unblocks |")
lines.append("|-------|---------|-------|-------|----------|--------|--------------|----------|")

for i, t in enumerate(tasks, 1):
    title = t["title"].replace("|", "\\|")
    deps = t["dependencies"].replace("|", "\\|")
    unblocks = t["unblocks"].replace("|", "\\|")
    lines.append(
        f"| {i} | {t['id']} | {t['phase']} | {title} | {t['priority']} | ⬜ Todo | {deps} | {unblocks} |"
    )

lines.append("")
lines.append("---")
lines.append("")
lines.append("## Task Details")
lines.append("")

current_phase = None
for t in tasks:
    if t["phase"] != current_phase:
        current_phase = t["phase"]
        lines.append(f"### {phase_label(current_phase)}")
        lines.append("")

    lines.append(f"#### TASK {t['id']}")
    lines.append("")
    lines.append(f"- **Phase:** {t['phase']}")
    lines.append(f"- **Task ID:** {t['id']}")
    lines.append("- **Status:** ⬜ Todo")
    lines.append(f"- **Title:** {t['title']}")
    lines.append(f"- **Type:** {t['type']}")
    lines.append(f"- **Priority:** {t['priority']}")
    lines.append("")
    lines.append("**Scope:**")
    lines.append(t["scope"])
    lines.append("")
    lines.append(f"**Problem:** {t['problem']}")
    lines.append("")
    lines.append(f"**Objective:** {t['objective']}")
    lines.append("")
    lines.append("**Implementation Steps:**")
    lines.append(t["steps"])
    lines.append("")
    lines.append("**Acceptance Criteria:**")
    lines.append(t["acceptance"])
    lines.append("")
    lines.append(f"**Risks:** {t['risks']}")
    lines.append("")
    lines.append(f"**Dependencies:** {t['dependencies']}")
    lines.append("")
    lines.append(f"**Unblocks:** {t['unblocks']}")
    lines.append("")
    lines.append("---")
    lines.append("")

lines.append("## Next Executable Tasks")
lines.append("")
lines.append("Tasks whose dependencies are all satisfied (currently: tasks with **Dependencies: None** only, since no tasks are ✅ Done yet):")
lines.append("")

next_exec = [t for t in tasks if is_none_dep(t["dependencies"])]
for t in next_exec:
    lines.append(f"- **{t['id']}** — {t['title']} (Priority: {t['priority']})")

lines.append("")
lines.append(f"*{len(next_exec)} tasks ready to execute.*")

OUTPUT.write_text("\n".join(lines) + "\n", encoding="utf-8")
print(f"Wrote {OUTPUT}")
print(f"Lines: {len(lines) + 1}")
print(f"Tasks: {len(tasks)}")
print(f"Next executable: {len(next_exec)}")
