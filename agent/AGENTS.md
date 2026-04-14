# Scoring Contract — Read This First

You are running inside the **tau** SWE harness on Bittensor subnet 66. Your output is a unified diff scored as:

```
score = matched_lines / max(your_diff_lines, reference_diff_lines)
```

Matching is **positional and exact** at the line level inside the unified diff. There is no semantic credit, no test execution, no partial credit. Every changed line that does not byte-match the hidden reference at the same diff position is dead weight.

Two failure modes dominate:

1. **Bloat** — you touched lines the reference did not touch, so `your_diff_lines > reference_diff_lines` and the denominator grows.
2. **Drift** — you touched the right lines but with different whitespace, quotes, naming, or order, so the line at that diff position does not match.

Everything below is a rule for minimizing one of those.

## Operating Loop

1. **Read the task once.** Identify the exact files and the exact symbols the task names. Do not infer additional files.
2. **Read each named file in full** (not partial views, not just the function — whole file). Read no other files.
3. **Find the smallest possible edit** that satisfies the literal task. The smallest correct patch always beats a larger one.
4. **Apply the edit** with maximum surrounding-context anchors so the diff lands at the right position.
5. **Stop.** No verification, no follow-up reads, no summary, no second pass.

## Hard Rules

- **Minimal diff is the only objective.** If a change is not literally required by the task wording, do not make it.
- **Match style character-for-character.** Indentation type and width, quote style, semicolons, trailing commas, brace placement, blank-line patterns — copy exactly from the surrounding existing code. Never "normalize."
- **Do not touch what was not asked.** No comment edits, no docstring edits, no type-annotation edits, no error-handling edits, no logging edits, no import reordering, no unrelated bug fixes, no formatting fixes, no whitespace cleanup, no blank-line insertion or deletion, no rename of any unrelated identifier.
- **No new files** unless the task literally says "create a file." Editing an existing file is always preferable.
- **No exploratory reads.** Do not read `README.md`, `package.json`, `tsconfig.json`, test files, or any file the task does not name. Do not run `ls`, `find`, `grep`, `tree`, or any directory scan beyond what is strictly required to locate a named file.
- **No verification.** Do not run tests, builds, linters, type checkers, or formatters. Do not re-read a file after editing it. Do not "double-check" — every extra tool call is wasted budget that could time out the run.
- **No commit, no stage, no git operations.** The harness captures your raw diff.
- **Process order.** When the task requires editing multiple files, process them in alphabetical path order, and inside each file edit top-to-bottom in source order. This stabilizes the diff position so it has a chance to align with the reference.

## Edit Discipline

- **Anchor precisely.** When using an edit tool, include enough surrounding context that there is exactly one match — but never more context than needed. Misanchored edits shift diff positions and forfeit the round.
- **Prefer the narrowest replacement.** If a single token has to change, replace the single token, not the whole line. If a single line has to change, replace that line, not the surrounding block.
- **Do not collapse or split lines.** If the original is wrapped across two lines, your edit stays wrapped the same way. If the original is one long line, your edit is one long line.
- **Preserve trailing newlines and EOF behavior** exactly as the original file.
- **Never re-indent surrounding code** to "make it consistent." Inconsistency is the codebase's, not yours to fix.

## Ambiguity Resolution

- When a change is ambiguous between a smaller targeted patch and a larger "more correct" refactor, choose the smaller patch every time.
- When the task could be read as touching extra files but does not name them, do not touch them.
- When a fix could include defensive checks that "would be nice," omit them.
- When you are unsure whether a line should change, leave it.

## What "Done" Looks Like

You have applied the smallest diff that literally satisfies the task wording. You stop. You do not write a summary. You do not list changes. You do not explain. The harness reads your diff from disk.
