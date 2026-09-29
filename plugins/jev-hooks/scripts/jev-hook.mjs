#!/usr/bin/env node
// Claude Code hook backed by TypeSafe's Jev (System One) judge.
//
//   PreToolUse (Bash)  -> asks for confirmation before commands Jev rates as destructive.
//   UserPromptSubmit   -> grades the prompt; holds weak prompts or prompts that trip a known pitfall.
//
// Reads the hook event JSON on stdin and writes a Claude Code hook decision on stdout.
// Every failure (no key, network, timeout, bad response) fails open: the action proceeds.
// Requires Node 18+ (global fetch). No dependencies.

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const API_URL = process.env.TYPESAFE_BASE_URL?.replace(/\/$/, "") ?? "https://api.typesafe.ai";
const MODEL = process.env.JEV_MODEL ?? "jev-latest";
const TIMEOUT_MS = 8_000;
const API_KEY = process.env.CLAUDE_PLUGIN_OPTION_TYPESAFE_API_KEY || process.env.TYPESAFE_API_KEY || "";
const GRADE_PROMPTS = !/^(false|0|no|off)$/i.test(
	process.env.CLAUDE_PLUGIN_OPTION_GRADE_PROMPTS ?? process.env.JEV_GRADE_PROMPTS ?? "true",
);
const STATE_DIR = join(tmpdir(), "jev-claude-code-hooks");

// ---------------------------------------------------------------- Jev client

async function askJev(state, questions) {
	if (!API_KEY) throw new Error("no TypeSafe API key (set TYPESAFE_API_KEY or the plugin option)");
	const res = await fetch(`${API_URL}/v1/systemone`, {
		method: "POST",
		headers: { Authorization: `Bearer ${API_KEY}`, "Content-Type": "application/json" },
		body: JSON.stringify({ model: MODEL, state, questions }),
		signal: AbortSignal.timeout(TIMEOUT_MS),
	});
	const body = await res.json().catch(() => null);
	if (!res.ok) throw new Error(`TypeSafe ${res.status}: ${JSON.stringify(body)}`);
	if (!body || typeof body.answers !== "object" || body.answers === null) {
		throw new Error(`unexpected TypeSafe response: ${JSON.stringify(body)}`);
	}
	return body.answers;
}

// ---------------------------------------------------------------- per-session state

function sessionFile(sessionId, suffix) {
	mkdirSync(STATE_DIR, { recursive: true });
	const safe = String(sessionId ?? "default").replace(/[^A-Za-z0-9_-]/g, "_");
	return join(STATE_DIR, `${safe}.${suffix}`);
}

// Returns a one-time warning so a TypeSafe outage is reported once per session, not on every call.
function unavailableWarning(sessionId, label, err) {
	const message = err instanceof Error ? err.message : String(err);
	const marker = sessionFile(sessionId, "warned");
	if (existsSync(marker)) return undefined;
	writeFileSync(marker, message);
	return `${label} inactive: ${message}`;
}

// ---------------------------------------------------------------- Bash guard (PreToolUse)

// Ask for confirmation when Jev puts at least this much probability on "destructive".
const CONFIRM_AT = 0.5;

const RISK = {
	type: "choice",
	instructions:
		"If the shell command in `command` runs with working directory `cwd`, what is the worst realistic effect on the user's files, repositories, or systems?",
	criteria: {
		safe: "Only reads or inspects: listing, searching, printing, status, diffs, or running tests and builds that write only to build or cache output.",
		risky: "Changes state in a recoverable way: edits or creates files, installs packages, makes git commits or branches, or starts or stops local processes.",
		destructive:
			"Loses data or is hard to undo: deletes source files or directories, git reset --hard or clean, force push, drops databases, overwrites files by redirection, or changes permissions or system configuration.",
	},
};

async function bashGuard(input) {
	if (input.tool_name !== "Bash") return undefined;
	const command = typeof input.tool_input?.command === "string" ? input.tool_input.command.trim() : "";
	if (!command) return undefined;

	let pDestructive;
	try {
		const answer = (await askJev({ command, cwd: input.cwd }, { risk: RISK })).risk;
		if (answer?.type !== "choice") throw new Error(`unexpected answer: ${JSON.stringify(answer)}`);
		pDestructive = answer.probabilities?.destructive ?? 0;
	} catch (err) {
		const warning = unavailableWarning(input.session_id, "jev-guard", err);
		return warning ? { systemMessage: warning } : undefined;
	}

	if (pDestructive < CONFIRM_AT) return undefined;
	return {
		hookSpecificOutput: {
			hookEventName: "PreToolUse",
			permissionDecision: "ask",
			permissionDecisionReason: `Jev: destructive (p=${pDestructive.toFixed(2)})`,
		},
	};
}

// ---------------------------------------------------------------- Prompt grader (UserPromptSubmit)

// Pitfalls follow the prompt-level advice in
// https://platform.claude.com/docs/en/build-with-claude/prompt-engineering/prompting-claude-opus-5-5

// Jev probability at which a pitfall counts as present.
const FLAG_AT = 0.5;
// Probability at which the prompt is treated as a conversational follow-up and not graded.
const FOLLOWUP_AT = 0.6;
// Expected quality level (0-3) below which the prompt is held.
const HOLD_BELOW = 1.5;

const QUALITY_LEVELS = ["Unusable", "Weak", "Good", "Excellent"];

const QUALITY = {
	type: "score",
	instructions:
		"How well does `prompt` equip a capable AI coding and knowledge-work agent to do the requested work without guessing?",
	criteria: [
		"Unusable: the goal cannot be determined from the prompt",
		"Weak: the goal is recognizable but scope, needed context, or what counts as done is missing",
		"Good: the goal and scope are clear, with minor gaps in context or success criteria",
		"Excellent: the goal, scope, needed context, constraints, and completion condition are all stated",
	],
};

const FOLLOWUP = {
	type: "noul",
	instructions:
		"Is `prompt` a short conversational follow-up inside an ongoing conversation (a confirmation, a yes/no reply, 'continue', a thanks, or a one-line correction to the previous answer) rather than a request that starts a new task?",
};

const PITFALLS = {
	unmarked_paste: {
		question: {
			type: "noul",
			instructions:
				"Does `prompt` contain a block of text the user copied from somewhere else (an email, chat thread, web page, document, ticket, or log) that is not wrapped in <pasted_content> tags?",
		},
		fix: 'Wrap pasted text in <pasted_content id="x1">...</pasted_content id="x1"> so instructions inside it are not followed as yours.',
	},
	reasoning_in_response: {
		question: {
			type: "noul",
			instructions:
				"Does `prompt` ask the model to write out its reasoning, chain of thought, or step-by-step thinking inside its reply text?",
		},
		fix: "Drop the request to write out reasoning in the reply; Opus 5.5 can decline it as reasoning_extraction. Its thinking is always on.",
	},
	think_harder: {
		question: {
			type: "noul",
			instructions:
				"Does `prompt` tell the model to think carefully, think hard, deliberate, or take its time before answering, as a general instruction about how much to think?",
		},
		fix: "Remove 'think carefully' lines; Opus 5.5 decides how much to think and effort is the control. They mostly add latency.",
	},
	generic_frontend: {
		question: {
			type: "noul",
			instructions:
				"Does `prompt` request frontend or visual UI work (web page, component, dashboard, site styling) while giving no concrete design direction, or only a general style instruction such as 'make it modern' or 'avoid a generic AI look' instead of naming specific styles or patterns to use or avoid?",
		},
		fix: "Name the specific styles to avoid (e.g. cream background, pill buttons, monospace labels, '01/02/03' section numbers) instead of 'avoid a generic look'.",
	},
	unpointed_context: {
		question: {
			type: "noul",
			instructions:
				"Does the task in `prompt` depend on information kept in other apps or records outside both the prompt text and the current code repository (emails, shared documents, spreadsheets, CRM or ticket records), while the prompt neither says where that information is nor asks the model to look through those sources before acting?",
		},
		fix: "Point at where the needed context lives, or tell it to explore the relevant sources before changing anything.",
	},
	no_done_condition: {
		question: {
			type: "noul",
			instructions:
				"Does `prompt` ask for long or multi-part work (several changes, a migration, an audit, a multi-step build) without stating what counts as finished or which situations should make the model stop and ask?",
		},
		fix: "State the completion condition (and the parts, as a checklist) plus which blockers justify stopping to ask.",
	},
};

function gradingQuestions() {
	const all = { quality: QUALITY, followup: FOLLOWUP };
	for (const [id, pitfall] of Object.entries(PITFALLS)) all[id] = pitfall.question;
	return all;
}

async function promptGrader(input) {
	if (!GRADE_PROMPTS) return undefined;
	const prompt = typeof input.prompt === "string" ? input.prompt.trim() : "";
	// Slash commands and `!` shell escapes are not model prompts.
	if (!prompt || prompt.startsWith("/") || prompt.startsWith("!")) return undefined;

	// A held prompt submitted again unchanged is the user's "send anyway".
	const heldFile = sessionFile(input.session_id, "held");
	const hash = createHash("sha256").update(prompt).digest("hex");
	if (existsSync(heldFile)) {
		const held = readFileSync(heldFile, "utf8");
		rmSync(heldFile, { force: true });
		if (held === hash) return undefined;
	}

	let answers;
	try {
		answers = await askJev({ prompt }, gradingQuestions());
	} catch (err) {
		const warning = unavailableWarning(input.session_id, "prompt-grader", err);
		return warning ? { systemMessage: warning } : undefined;
	}

	if (answers.followup?.type === "noul" && answers.followup.noul >= FOLLOWUP_AT) return undefined;

	const score = answers.quality?.type === "score" ? answers.quality.score : undefined;
	const level = score === undefined ? "?" : QUALITY_LEVELS[Math.round(score)];
	const grade = `Prompt grade: ${level}${score === undefined ? "" : ` (${score.toFixed(1)}/3)`}`;
	const flagged = Object.entries(PITFALLS).filter(([id]) => {
		const answer = answers[id];
		return answer?.type === "noul" && answer.noul >= FLAG_AT;
	});

	if (flagged.length === 0 && (score === undefined || score >= HOLD_BELOW)) {
		return { systemMessage: grade };
	}

	const lines = flagged.map(([, pitfall]) => `- ${pitfall.fix}`);
	if (score !== undefined && score < HOLD_BELOW) {
		lines.unshift("- Goal, scope, needed context, or what counts as done is unclear.");
	}
	writeFileSync(heldFile, hash);
	return {
		decision: "block",
		reason: [`${grade}. Held before sending:`, ...lines, "", "Submit the same prompt again to send it anyway."].join(
			"\n",
		),
	};
}

// ---------------------------------------------------------------- entry point

async function main() {
	let raw = "";
	for await (const chunk of process.stdin) raw += chunk;
	const input = JSON.parse(raw);

	let output;
	if (input.hook_event_name === "PreToolUse") output = await bashGuard(input);
	else if (input.hook_event_name === "UserPromptSubmit") output = await promptGrader(input);

	if (output) process.stdout.write(JSON.stringify(output));
}

main().catch((err) => {
	// Fail open on anything unexpected; stderr lands in Claude Code's debug log.
	process.stderr.write(`jev-hook: ${err instanceof Error ? err.message : String(err)}\n`);
	process.exit(0);
});
