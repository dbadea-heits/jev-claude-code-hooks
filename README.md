# jev-hooks for Claude Code

Two Claude Code hooks that ask TypeSafe's Jev judge (`jev-latest`) before something happens:

- **Bash guard** (`PreToolUse`). Before Claude runs a Bash command, Jev rates it as `safe`, `risky`, or `destructive`. If the probability of `destructive` is 0.5 or higher, Claude Code shows its permission prompt with the reason `Jev: destructive (p=0.93)`. This happens even for commands you have already allowed.
- **Prompt grader** (`UserPromptSubmit`). Each prompt you send gets a grade from 0 to 3 (Unusable, Weak, Good, Excellent), and Jev checks it for six pitfalls from Anthropic's [Opus 5.5 prompting guide](https://platform.claude.com/docs/en/build-with-claude/prompt-engineering/prompting-claude-opus-5-5): unmarked pasted text, asking for written-out reasoning, "think harder" lines, frontend work with no design direction, context that lives in other apps without saying where, and multi-part work with no definition of done. A prompt that scores below 1.5 or trips a pitfall is held, and the message lists what to fix. To send it unchanged, submit the same text again. Short follow-ups ("yes", "continue"), slash commands, and `!` shell commands are not graded. Good prompts go through with a one-line grade.

Both hooks fail open. With a missing key, a network error, or an 8-second timeout, the command or prompt goes through and you get one warning per session.

## Requirements

- Claude Code
- Node.js 18 or newer on your `PATH` (the hook is one dependency-free `.mjs` file)
- A TypeSafe API key for `https://api.typesafe.ai` ([docs](https://docs.typesafe.ai)). Each Bash command and each prompt makes one API call.

## Install as a plugin (recommended)

Inside Claude Code:

```
/plugin marketplace add dbadea-heits/jev-claude-code-hooks
/plugin install jev-hooks@jev-hooks
```

When you enable the plugin, Claude Code asks for two settings:

- **TypeSafe API key.** Stored in your system's secure credential store, not in `settings.json`. You can leave it empty and export `TYPESAFE_API_KEY` in your shell instead.
- **Grade prompts.** Turn it off if you only want the Bash guard.

Restart Claude Code, or run `/hooks` to confirm that `PreToolUse` (matcher `Bash`) and `UserPromptSubmit` both list the plugin's hook.

If the repository is private, your git credentials need read access to it for `marketplace add` to work.

## Install by hand (no plugin)

1. Copy the script somewhere stable:

   ```bash
   mkdir -p ~/.claude/hooks
   curl -fsSL https://raw.githubusercontent.com/dbadea-heits/jev-claude-code-hooks/main/plugins/jev-hooks/scripts/jev-hook.mjs \
     -o ~/.claude/hooks/jev-hook.mjs
   ```

   For a private repo, clone it and copy `plugins/jev-hooks/scripts/jev-hook.mjs` instead.

2. Merge this into `~/.claude/settings.json` (all projects) or `.claude/settings.json` (one project). If a `hooks` key already exists, add these entries to it rather than replacing it.

   ```json
   {
     "env": {
       "TYPESAFE_API_KEY": "your-typesafe-key"
     },
     "hooks": {
       "PreToolUse": [
         {
           "matcher": "Bash",
           "hooks": [{ "type": "command", "command": "node ~/.claude/hooks/jev-hook.mjs", "timeout": 15 }]
         }
       ],
       "UserPromptSubmit": [
         {
           "hooks": [{ "type": "command", "command": "node ~/.claude/hooks/jev-hook.mjs", "timeout": 15 }]
         }
       ]
     }
   }
   ```

   Leave out the `env` block if you export `TYPESAFE_API_KEY` in your shell profile. Keep a key in a committed project `settings.json` out of git; use `.claude/settings.local.json` for that case.

3. Restart Claude Code and check `/hooks`.

## Try it

- Ask Claude to run `rm -rf build`. You should get a permission prompt that says `Jev: destructive (p=…)`.
- Send "Build me a dashboard, make it modern, think really hard." It should be held with a Weak grade and a list of fixes. Send it again to let it through.

You can also run the hook without Claude Code:

```bash
echo '{"hook_event_name":"PreToolUse","session_id":"t","cwd":"/tmp","tool_name":"Bash","tool_input":{"command":"git push --force"}}' \
  | TYPESAFE_API_KEY=your-typesafe-key node plugins/jev-hooks/scripts/jev-hook.mjs
```

## Configuration

Environment variables the hook reads:

| Variable | Default | Effect |
| :- | :- | :- |
| `TYPESAFE_API_KEY` | none | API key. The plugin's `typesafe_api_key` option takes precedence. |
| `JEV_GRADE_PROMPTS` | `true` | Set to `0` or `false` to turn off the prompt grader. The plugin's `grade_prompts` option takes precedence. |
| `JEV_MODEL` | `jev-latest` | TypeSafe model to call. |
| `TYPESAFE_BASE_URL` | `https://api.typesafe.ai` | API base URL. |

The thresholds (`CONFIRM_AT`, `FLAG_AT`, `FOLLOWUP_AT`, `HOLD_BELOW`) and the question wording are constants at the top of each section in `jev-hook.mjs`.

## Things to know

- Claude Code doesn't tell hooks which model is active. The prompt pitfalls come from the Opus 5.5 guide but apply to every model.
- In `claude -p` (non-interactive) runs, a held prompt is dropped and a Bash command flagged `destructive` is denied, because nobody is there to confirm.
- The hook keeps small state files (held-prompt hash, "already warned" marker) in `$TMPDIR/jev-claude-code-hooks/`.
- The full text of every prompt and Bash command is sent to TypeSafe for judging.

## Repository layout

```
.claude-plugin/marketplace.json           marketplace listing (one plugin)
plugins/jev-hooks/.claude-plugin/plugin.json   plugin manifest and settings
plugins/jev-hooks/hooks/hooks.json        hook registration
plugins/jev-hooks/scripts/jev-hook.mjs    the hook
```
