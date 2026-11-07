# Skills

The working habits in [AGENTS.md](../../AGENTS.md), as skills that Claude Code loads from this folder. Other agents can
read each `SKILL.md` as plain instructions.

| Skill | What it's for | From |
| --- | --- | --- |
| `ponytail` | Writing code: the smallest complete change, with `shortcut:` comments for known limits | [DietrichGebert/ponytail](https://github.com/DietrichGebert/ponytail), MIT |
| `caveman` | Talking in chat: terse, answer first, every fact kept | [JuliusBrussee/caveman](https://github.com/JuliusBrussee/caveman), Apache-2.0 |
| `ultracave`, `megacave` | caveman's terser levels, which it switches to | the same, Apache-2.0 |

They're copies, kept as published, each with its license. [sources.tsv](sources.tsv) says which release each one is.
`make update-skills` updates them all to their latest releases. It doesn't commit, so read the diff first: agents
follow these files.
