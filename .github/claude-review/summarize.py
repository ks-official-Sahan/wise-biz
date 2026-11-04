#!/usr/bin/env python3
"""Merge the batch results of a sharded review into one pull request review.

Reads the plan (plan.json, valid_lines.json) and every batch's structured
output, then writes:
  review.json             the review to POST (body, event, inline comments)
  review-no-inline.json   the same review with the inline comments folded into the body (fallback)
  state.json              the review state to save on the status comment
  banner.md               the status line for the status comment
and prints decisions to GITHUB_OUTPUT (post_review, continue, failed, high).

Pure: no network calls, so every rule is testable offline.

Environment:
  PLAN_DIR, RESULTS_DIR, OUT_DIR, RUN_URL
  KIND               comment | manual | continue
  MAX_CONTINUATIONS  automatic retries for failed batches (default 7)
  MAX_INLINE         inline comments per review (default 25)
"""

from __future__ import annotations

import json
import os
import sys
from pathlib import Path

from plan import encode_paths

SEVERITIES = ("High", "Medium", "Low")
ICONS = {"High": "🔴", "Medium": "🟡", "Low": "🟢"}
BODY_LIMIT = 60000  # GitHub caps a review body at 65536 characters
FIELDS = ("severity", "path", "category", "problem", "fix")


def count(n: int, word: str) -> str:
    return f"{n} {word}" if n == 1 else f"{n} {word}{'es' if word.endswith(('ch', 'sh', 's', 'x')) else 's'}"


def read_json(path: Path):
    try:
        text = path.read_text(encoding="utf-8").strip()
        return json.loads(text) if text else None
    except (OSError, json.JSONDecodeError):
        return None


def in_diff(ranges: dict, path: str, line: int) -> bool:
    return any(start <= line <= end for start, end in ranges.get(path, []))


def finding_line(f: dict) -> str:
    return f"- `{f['path']}:{f['line']}` - {f['category'] or 'note'} - {f['problem']} - {f['fix']}"


def collect_findings(results: dict[str, dict], batches: dict[str, list[str]], ok_names: list[str]) -> list[dict]:
    """Findings from every finished batch, deduplicated and confined to that batch's own files."""
    seen, findings = set(), []
    for name in ok_names:
        own = set(batches[name])
        for raw in results[name]["findings"]:
            if not isinstance(raw, dict) or raw.get("severity") not in SEVERITIES or raw.get("path") not in own:
                continue
            f = {key: str(raw.get(key, "")).strip() for key in FIELDS}
            try:
                f["line"] = int(raw.get("line") or 0)
            except (TypeError, ValueError):
                f["line"] = 0
            key = (f["path"], f["line"], f["problem"][:80])
            if key not in seen:
                seen.add(key)
                findings.append(f)
    findings.sort(key=lambda f: (SEVERITIES.index(f["severity"]), f["path"], f["line"]))
    return findings


def inline_comments(findings: list[dict], ranges: dict, prior: list[dict], limit: int) -> list[dict]:
    """In the diff, not already an open thread at that line, highest severity first."""
    open_threads = {(p.get("path"), p.get("line")) for p in prior if p.get("status") == "OPEN"}
    comments = []
    for f in findings:
        if len(comments) >= limit:
            break
        if f["line"] > 0 and in_diff(ranges, f["path"], f["line"]) and (f["path"], f["line"]) not in open_threads:
            comments.append({
                "path": f["path"],
                "line": f["line"],
                "side": "RIGHT",
                "body": f"**[{f['severity']}]** {f['category'] or 'note'}: {f['problem']}\n\n**Fix:** {f['fix']}",
            })
    return comments


def build(plan: dict, results: dict[str, dict], meta: dict[str, dict], env: dict) -> dict:
    names = plan["names"]
    batches = dict(zip(names, plan["batches"]))
    ok_names = [n for n in names if isinstance(results.get(n), dict) and isinstance(results[n].get("findings"), list)]
    failed = [n for n in names if n not in ok_names]

    findings = collect_findings(results, batches, ok_names)
    comments = inline_comments(findings, plan.get("valid_lines") or {}, plan.get("prior", []), int(env.get("MAX_INLINE") or 25))
    reviewed_now = sorted({p for n in ok_names for p in batches[n]})
    high = sum(f["severity"] == "High" for f in findings)
    head = plan["head"]

    scope_desc = ("the whole pull request" if plan["mode"] == "full"
                  else f"incremental: only changes since `{plan['scope_base'][:7]}`, the last reviewed commit")
    skipped = [count(len(plan["excluded"]), "generated or binary file") + " skipped"] if plan["excluded"] else []
    skipped += [count(len(plan["done_before"]), "file") + " reviewed by an earlier run"] if plan["done_before"] else []
    sections = [
        "## Overview",
        f"Sharded review of `{head[:7]}`, {scope_desc}: {count(len(reviewed_now), 'file')} in "
        f"{len(ok_names)} of {count(len(names), 'batch')}." + (f" {plan['note']}" if plan.get("note") else ""),
        f"Verdict: {'Request changes' if high else 'Comment' if findings else 'Approve'}.",
        "",
        "## Summary of changes",
    ]
    summary = [f"- {s.get('files', '')}: {s.get('change', '')}" for n in ok_names for s in results[n].get("summary") or [] if isinstance(s, dict)]
    sections += summary[:150] or ["- (no summary)"]
    if len(summary) > 150:
        sections.append(f"- ...and {len(summary) - 150} more areas")
    if findings:
        sections += ["", "## Findings"]
        for sev in SEVERITIES:
            tier = [finding_line(f) for f in findings if f["severity"] == sev]
            if tier:
                sections += [f"### {ICONS[sev]} {sev}", *tier]
    earlier = [e for n in ok_names for e in results[n].get("earlier") or [] if isinstance(e, dict)]
    if earlier:
        sections += ["", "## Earlier findings", *[f"- {e.get('status')}: `{e.get('path')}:{e.get('line')}`" for e in earlier]]
    turns = sum(int(meta.get(n, {}).get("turns") or 0) for n in names)
    cost = sum(float(meta.get(n, {}).get("cost") or 0) for n in names)
    sections += [
        "",
        "## Stats",
        f"Files reviewed: {len(reviewed_now)} of {plan['scope_files']} in scope ({scope_desc}"
        + "".join(f"; {part}" for part in skipped)
        + f"). The pull request changes {count(int(plan.get('total_files') or 0), 'file')} in total."
        + f" · Batches: {len(ok_names)}/{len(names)}"
        + (f" · Turns: {turns}" if turns else "") + (f" · Cost: ${cost:.3f}" if cost else ""),
    ]
    not_reviewed = [p for n in failed for p in batches[n]]
    if not_reviewed or plan["excluded"]:
        sections += ["", "## Not reviewed"]
        if not_reviewed:
            sections.append(f"- {count(len(not_reviewed), 'file')} in {count(len(failed), 'unfinished batch')} (retried automatically, or on `@claude-code review`):")
            sections += [f"  - `{p}`" for p in not_reviewed[:40]]
            if len(not_reviewed) > 40:
                sections.append(f"  - ...and {len(not_reviewed) - 40} more")
        if plan["excluded"]:
            shown = ", ".join(f"`{p}`" for p in plan["excluded"][:15])
            more = f" and {len(plan['excluded']) - 15} more" if len(plan["excluded"]) > 15 else ""
            sections.append(f"- Generated or binary: {shown}{more}")
    body = "\n".join(sections)
    if len(body) > BODY_LIMIT:
        body = body[:BODY_LIMIT] + "\n\n_(Truncated: the full list did not fit in one review.)_"

    event = "REQUEST_CHANGES" if high else "COMMENT"
    review = {"commit_id": head, "event": event, "body": body, "comments": comments}
    folded = body
    if comments:
        folded += "\n\n## Inline findings\n" + "\n".join(f"- `{c['path']}:{c['line']}` {c['body'].splitlines()[0]}" for c in comments)
    fallback = {"commit_id": head, "event": event, "body": folded[:65000]}

    state = plan.get("state") or {}
    max_cont = int(env.get("MAX_CONTINUATIONS") or 7)
    run_url = env.get("RUN_URL", "")
    if not failed:
        new_state = {"v": 2, "reviewed_sha": head, "continuations": 0}
        banner = (f"✅ **Review complete** for `{head[:7]}` ([view run]({run_url})): {count(len(reviewed_now), 'file')} in {count(len(names), 'batch')}. "
                  "Comment `@claude-code review` anytime to review new commits incrementally.")
        do_continue = False
    else:
        # A person asking again (comment or manual run) gets a fresh retry budget.
        cont = 0 if env.get("KIND") in ("comment", "manual") else int(state.get("continuations") or 0)
        do_continue = cont < max_cont
        cont += 1 if do_continue else 0
        done = set(plan["done_before"]) | set(reviewed_now)
        new_state = {
            "v": 2,
            "reviewed_sha": state.get("reviewed_sha") or "",
            "continuations": cont,
            "partial": {"head": head, "base": plan["scope_base"], "done": encode_paths(done)},
        }
        lead = f"⏳ **Partial review** of `{head[:7]}` ([view run]({run_url})): {len(failed)} of {count(len(names), 'batch')} did not finish."
        banner = (f"{lead} Retrying them automatically, round {cont}/{max_cont}." if do_continue
                  else f"{lead} Stopped retrying after {max_cont} rounds; comment `@claude-code review` to retry. Progress is kept.")
    if not names:
        banner = (f"✅ **Nothing to review** in `{head[:7]}` ([view run]({run_url})): "
                  + ("no new commits." if plan.get("skip") else "only generated or binary files changed, or everything was reviewed already."))

    return {
        "review": review if ok_names else None,
        "fallback": fallback if ok_names else None,
        "state": new_state,
        "banner": banner,
        "continue": do_continue,
        "failed": len(failed),
        "high": high,
    }


def main() -> int:
    env = os.environ
    plan_dir, results_dir, out = Path(env["PLAN_DIR"]), Path(env["RESULTS_DIR"]), Path(env["OUT_DIR"])
    out.mkdir(parents=True, exist_ok=True)
    plan = read_json(plan_dir / "plan.json")
    if not isinstance(plan, dict):
        print("::error::plan.json is missing or unreadable", file=sys.stderr)
        return 1
    plan["valid_lines"] = read_json(plan_dir / "valid_lines.json") or {}
    results, meta = {}, {}
    for name in plan["names"]:
        folder = results_dir / name
        results[name] = read_json(folder / "out.json")
        meta[name] = read_json(folder / "meta.json") or {}

    decision = build(plan, results, meta, dict(env))
    if decision["review"]:
        (out / "review.json").write_text(json.dumps(decision["review"]), encoding="utf-8")
        (out / "review-no-inline.json").write_text(json.dumps(decision["fallback"]), encoding="utf-8")
    (out / "state.json").write_text(json.dumps(decision["state"], separators=(",", ":")), encoding="utf-8")
    (out / "banner.md").write_text(decision["banner"], encoding="utf-8")
    with open(env.get("GITHUB_OUTPUT", os.devnull), "a", encoding="utf-8") as fh:
        fh.write(f"post_review={'true' if decision['review'] else 'false'}\n")
        fh.write(f"continue={'true' if decision['continue'] else 'false'}\n")
        fh.write(f"failed={decision['failed']}\nhigh={decision['high']}\n")
    print(decision["banner"])
    return 0


if __name__ == "__main__":
    sys.exit(main())
