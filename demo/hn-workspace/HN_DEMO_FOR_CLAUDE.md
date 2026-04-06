# Prompt For Claude Code

Use this prompt in Claude Code if you want it to help produce a polished demo recording workflow.

```text
You are working inside the Teepee repo.

Goal:
prepare a clean, repeatable demo capture workflow for `demo/hn-workspace` that I can record for LinkedIn or Hacker News.

What I need:
1. verify the workspace still starts cleanly
2. verify the prompts in `demo/hn-workspace/HN_PROMPTS.md` still make sense
3. identify the best 3-prompt sequence for a 45-90 second demo
4. if terminal capture tools are installed (`vhs`, `asciinema`, `agg`, `ffmpeg`), generate the necessary scripts/assets to record a polished terminal demo
5. if those tools are not installed, prepare everything except the final recording and tell me exactly which tool to install and which command to run
6. avoid touching the main repo outside `demo/hn-workspace` unless needed for the demo itself

Constraints:
- keep the demo realistic, not fake
- do not invent successful edits or test runs
- prefer MP4 as the primary output and GIF only as a short teaser
- keep the resulting flow concise and high signal

Deliverables:
- updated demo instructions if needed
- any helper scripts needed to reset or prepare the workspace
- a final recommended recording sequence
```
