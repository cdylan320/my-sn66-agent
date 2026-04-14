/**
 * System prompt construction and project context loading
 */

import { execSync } from "node:child_process";
import { getDocsPath, getExamplesPath, getReadmePath } from "../config.js";
import { formatSkillsForPrompt, type Skill } from "./skills.js";

function grepTaskKeywords(cwd: string, taskText: string): string {
	try {
		const backtickMatches = taskText.match(/`([^`]{2,60})`/g)?.map(k => k.replace(/`/g, '')) || [];
		const camelMatches = taskText.match(/\b[A-Z][a-z]+(?:[A-Z][a-z]+)+\b/g) || [];
		const snakeMatches = taskText.match(/\b[a-z]+_[a-z_]+\b/g) || [];
		const allKeywords = [...new Set([...backtickMatches, ...camelMatches, ...snakeMatches])]
			.filter(k => k.length >= 3 && k.length <= 60)
			.filter(k => !['the', 'and', 'for', 'with', 'that', 'this', 'from', 'should', 'must', 'when', 'each', 'into', 'also'].includes(k.toLowerCase()))
			.slice(0, 10);
		if (allKeywords.length === 0) return "";
		const fileHits = new Map<string, string[]>();
		for (const keyword of allKeywords) {
			try {
				const escaped = keyword.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
				const result = execSync(
					`grep -rl "${escaped}" --include="*.ts" --include="*.tsx" --include="*.js" --include="*.jsx" --include="*.py" --include="*.go" --include="*.java" --include="*.kt" --include="*.dart" --include="*.rb" --include="*.cs" --include="*.vue" . 2>/dev/null | grep -v node_modules | grep -v .git | grep -v dist/ | grep -v build/ | head -10`,
					{ cwd, timeout: 3000, encoding: "utf-8" }
				).trim();
				if (result) {
					for (const file of result.split("\n")) {
						const clean = file.replace("./", "");
						if (!fileHits.has(clean)) fileHits.set(clean, []);
						fileHits.get(clean)!.push(keyword);
					}
				}
			} catch {}
		}
		if (fileHits.size === 0) return "";
		const sorted = [...fileHits.entries()].sort((a, b) => b[1].length - a[1].length).slice(0, 15);
		let result = "\n\n## Files matching task keywords\n\nThese files contain identifiers from the task. Start here:\n";
		for (const [file, keywords] of sorted) {
			result += `- ${file} (${keywords.join(", ")})\n`;
		}
		return result + "\n";
	} catch {}
	return "";
}

// =============================================================================
// tau / sn66 strategy preamble — baked into the system prompt so it is loaded
// on every invocation, independent of project-context-file resolution.
//
// Scoring (verified in tau/src/compare.py):
//   - Validator runs cursor on the same task as the live oracle.
//   - For each agent: changed_sequence(orig, agent_repo) is built per file
//     using difflib.SequenceMatcher (top-to-bottom file order, "-:" lines
//     first then "+:" lines per replace block).
//   - matched_changed_lines = sum over files of zip(seq_a, seq_b) positional
//     equality.
//   - Winner = whoever has more matched_changed_lines vs the cursor oracle.
//
// Implications driving the rules below:
//   1. Touching files cursor would not touch is pure loss (bloat).
//   2. Missing files cursor would touch forfeits all matches on that file.
//   3. Wholesale `write` of an existing file generates a huge changed
//      sequence that almost never positionally aligns with cursor's
//      surgical `edit`. Use `edit` for existing files.
//   4. Reading a file before editing is much cheaper than editing the wrong
//      file or the wrong region.
// =============================================================================
const TAU_SCORING_PREAMBLE = `# tau / sn66 optimized strategy

You are running inside the tau SWE harness on Bittensor subnet 66. Your unified diff is scored line-by-line against another agent's diff (the oracle) using longest common subsequence matching. Whoever has more matched changed lines wins. The oracle is another instance of the same model on the same task — match what it would naturally produce.

## Speed matters — you may have as little as 40 seconds

Your time budget varies per task (40–300 seconds). You do NOT know how much time you have. An empty diff scores 0. Therefore:
- **Never run tests, builds, linters, servers, or type checkers.** The sandbox has no running services. These waste your entire budget.
- **3 bash calls maximum** (find + grep + sibling ls). Then use read/edit only.
- Your FIRST response MUST be a tool call. Never start with text or plans.

## Mandatory file discovery (BEFORE any edit)

Before your first edit, run a quick search:
- find . -type f \( -name "*.EXT" -o -name "Dockerfile" -o -name "*.sh" -o -name "*.json" \) | grep -v node_modules | grep -v .git | head -60
- grep -r "KEYWORD" --include="*.EXT" -l | head -10
This costs 1 tool call but prevents editing the wrong file (which costs the entire round).

After editing a file, check if there are **sibling files** in the same directory that also need editing. Run \`ls $(dirname path)/\` to see all files in that folder.

## File selection (highest leverage)

- Read the task carefully and identify exactly which files it implies.
- If uncertain which file implements a feature, READ the candidate file first to verify before editing.
- Touch only the files the oracle would touch. Adding extra files is pure loss; missing files cuts your possible matches.
- **Cover ALL files the task implies — do not stop early.** If the task has 5 acceptance criteria spanning 4 files, you must edit all 4 files. Missing a file = losing ALL matched lines in that file.
- **If you read a file, edit it.** Reading without editing is wasted budget.

## Style detection (before editing each file)

When you read a file, note from the first 20 lines:
- Indentation: tabs or spaces? 2 or 4 spaces?
- Quotes: single or double?
- Semicolons: present or absent?
- Trailing commas: yes or no?
- Brace style: same line or next line?
Your edits MUST match ALL of these exactly. A single style mismatch can shift diff positions and score 0.

## Tool choice

- For files that already exist: ALWAYS use edit. The write tool fails on existing files.
- For genuinely new files the task explicitly asks to create: use write.
- Use read freely to verify file structure before editing.

## No summary, no explanation

The harness reads your diff from disk, not your chat. After editing, reply "done" or nothing. Never write summaries, checklists, or recaps. Each extra token is wasted budget.

## Edit discipline

- Each edit should be the smallest change that satisfies the literal task wording.
- **Implement only what the task literally requests. Never extend logically.** The oracle reads the task literally; you must too.
- **Append new entries to the END of existing lists, switches, enums, OR-chains.** The oracle appends at the end; you must too.
- **String literals: copy verbatim from the task.** Do not paraphrase, translate, or expand.
- **Variable naming: scan adjacent code in the SAME file.** Use the existing local conventions. Prefer shorter local names.
- **Brace and whitespace placement: copy from immediate context exactly.**
- Match indentation, quote style, semicolons, and trailing commas character-for-character.
- Do not refactor, reorder imports, fix unrelated issues, or add comments/docstrings unless the task asks.
- Process multiple files in alphabetical path order; within each file, edit top-to-bottom.
- **Use short, unique oldText in edits (3-5 lines).** Long oldText blocks break from whitespace mismatches.
- **If an edit fails, re-read the file before retrying.** Never retry from memory.

## Positional alignment

Scoring uses longest common subsequence matching on changed lines. Maximize alignment:
- **Read the FULL file before editing.** Not just the function — the entire file.
- **Edit at the exact location the task implies.** Not at the top or in a new function below.
- **Do not reorder existing code.** Add imports at the end of the import block. The oracle appends; you must too.
- **Do not add blank lines between changes** unless existing code uses blank line separation.
- **When adding a new function, place it after the last existing similar function.**
- **Change only the lines that need changing.** Do not rewrite entire functions.

## Write minimal code — match the oracle's size

The oracle writes compact, targeted changes. Do not write boilerplate, comments, docstrings, or verbose error handling unless asked. A surgical 5-line edit beats a 50-line function rewrite.

## Conservative file selection

- Edit only files that exist or are explicitly named. Do NOT create new helper modules or utility files.
- When in doubt between two files, prefer the larger / more central one.
- **BUT: do not freeze.** An empty diff scores zero. A diff that touches 3 files (2 right + 1 wrong) still scores on the 2 right files. **Some output beats no output.**
- Config files: only edit if the task mentions configuration.

## Task scope sanity check

- Count acceptance criteria bullets. Each typically needs at least one edit.
- If the task names multiple files, touch each named file. Stopping early is wrong.
- "X and also Y" = both halves must be edited.
- 4+ criteria almost always need 4+ edits across 2+ files.
- Reference solutions are typically 100-500 changed lines spanning 1-5 files.
- "configure" or "update settings" usually means config + code changes. Do not stop after only config.
- If scope check says continue, make the next edit silently. Do not narrate.

## Stop

When the diff satisfies the task AND scope check passes, stop. No tests, no re-reads, no summaries.

---

`;

export interface BuildSystemPromptOptions {
	/** Custom system prompt (replaces default). */
	customPrompt?: string;
	/** Tools to include in prompt. Default: [read, bash, edit, write] */
	selectedTools?: string[];
	/** Optional one-line tool snippets keyed by tool name. */
	toolSnippets?: Record<string, string>;
	/** Additional guideline bullets appended to the default system prompt guidelines. */
	promptGuidelines?: string[];
	/** Text to append to system prompt. */
	appendSystemPrompt?: string;
	/** Working directory. Default: process.cwd() */
	cwd?: string;
	/** Pre-loaded context files. */
	contextFiles?: Array<{ path: string; content: string }>;
	/** Pre-loaded skills. */
	skills?: Skill[];
}

/** Build the system prompt with tools, guidelines, and context */
export function buildSystemPrompt(options: BuildSystemPromptOptions = {}): string {
	const {
		customPrompt,
		selectedTools,
		toolSnippets,
		promptGuidelines,
		appendSystemPrompt,
		cwd,
		contextFiles: providedContextFiles,
		skills: providedSkills,
	} = options;
	const resolvedCwd = cwd ?? process.cwd();
	const promptCwd = resolvedCwd.replace(/\\/g, "/");

	const date = new Date().toISOString().slice(0, 10);

	const appendSection = appendSystemPrompt ? `\n\n${appendSystemPrompt}` : "";

	const keywordHits = customPrompt ? grepTaskKeywords(resolvedCwd, customPrompt) : "";

	const contextFiles = providedContextFiles ?? [];
	const skills = providedSkills ?? [];

	if (customPrompt) {
		let prompt = TAU_SCORING_PREAMBLE + keywordHits + customPrompt;

		if (appendSection) {
			prompt += appendSection;
		}

		// Append project context files
		if (contextFiles.length > 0) {
			prompt += "\n\n# Project Context\n\n";
			prompt += "Project-specific instructions and guidelines:\n\n";
			for (const { path: filePath, content } of contextFiles) {
				prompt += `## ${filePath}\n\n${content}\n\n`;
			}
		}

		// Append skills section (only if read tool is available)
		const customPromptHasRead = !selectedTools || selectedTools.includes("read");
		if (customPromptHasRead && skills.length > 0) {
			prompt += formatSkillsForPrompt(skills);
		}

		// Add date and working directory last
		prompt += `\nCurrent date: ${date}`;
		prompt += `\nCurrent working directory: ${promptCwd}`;

		return prompt;
	}

	// Get absolute paths to documentation and examples
	const readmePath = getReadmePath();
	const docsPath = getDocsPath();
	const examplesPath = getExamplesPath();

	// Build tools list based on selected tools.
	// A tool appears in Available tools only when the caller provides a one-line snippet.
	const tools = selectedTools || ["read", "bash", "edit", "write"];
	const visibleTools = tools.filter((name) => !!toolSnippets?.[name]);
	const toolsList =
		visibleTools.length > 0 ? visibleTools.map((name) => `- ${name}: ${toolSnippets![name]}`).join("\n") : "(none)";

	// Build guidelines based on which tools are actually available
	const guidelinesList: string[] = [];
	const guidelinesSet = new Set<string>();
	const addGuideline = (guideline: string): void => {
		if (guidelinesSet.has(guideline)) {
			return;
		}
		guidelinesSet.add(guideline);
		guidelinesList.push(guideline);
	};

	const hasBash = tools.includes("bash");
	const hasGrep = tools.includes("grep");
	const hasFind = tools.includes("find");
	const hasLs = tools.includes("ls");
	const hasRead = tools.includes("read");

	// File exploration guidelines
	if (hasBash && !hasGrep && !hasFind && !hasLs) {
		addGuideline("Use bash for file operations like ls, rg, find");
	} else if (hasBash && (hasGrep || hasFind || hasLs)) {
		addGuideline("Prefer grep/find/ls tools over bash for file exploration (faster, respects .gitignore)");
	}

	for (const guideline of promptGuidelines ?? []) {
		const normalized = guideline.trim();
		if (normalized.length > 0) {
			addGuideline(normalized);
		}
	}

	// Always include these
	addGuideline("Be concise in your responses");
	addGuideline("Show file paths clearly when working with files");

	const guidelines = guidelinesList.map((g) => `- ${g}`).join("\n");

	let prompt = TAU_SCORING_PREAMBLE + `You are an expert coding assistant operating inside pi, a coding agent harness. You help users by reading files, executing commands, editing code, and writing new files.

Available tools:
${toolsList}

In addition to the tools above, you may have access to other custom tools depending on the project.

Guidelines:
${guidelines}

Pi documentation (read only when the user asks about pi itself, its SDK, extensions, themes, skills, or TUI):
- Main documentation: ${readmePath}
- Additional docs: ${docsPath}
- Examples: ${examplesPath} (extensions, custom tools, SDK)
- When asked about: extensions (docs/extensions.md, examples/extensions/), themes (docs/themes.md), skills (docs/skills.md), prompt templates (docs/prompt-templates.md), TUI components (docs/tui.md), keybindings (docs/keybindings.md), SDK integrations (docs/sdk.md), custom providers (docs/custom-provider.md), adding models (docs/models.md), pi packages (docs/packages.md)
- When working on pi topics, read the docs and examples, and follow .md cross-references before implementing
- Always read pi .md files completely and follow links to related docs (e.g., tui.md for TUI API details)`;

	if (appendSection) {
		prompt += appendSection;
	}

	// Append project context files
	if (contextFiles.length > 0) {
		prompt += "\n\n# Project Context\n\n";
		prompt += "Project-specific instructions and guidelines:\n\n";
		for (const { path: filePath, content } of contextFiles) {
			prompt += `## ${filePath}\n\n${content}\n\n`;
		}
	}

	// Append skills section (only if read tool is available)
	if (hasRead && skills.length > 0) {
		prompt += formatSkillsForPrompt(skills);
	}

	// Add date and working directory last
	prompt += `\nCurrent date: ${date}`;
	prompt += `\nCurrent working directory: ${promptCwd}`;

	return prompt;
}
