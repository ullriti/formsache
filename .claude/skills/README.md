# .claude/skills/

Project-specific **skills** for Claude Code. Each skill is a subfolder with a
`SKILL.md` (frontmatter `name` + `description`, then the instructions) and
optional helper files/scripts.

```
.claude/skills/
└── <skill-name>/
    ├── SKILL.md
    └── <optional references, scripts, assets>
```

Skills load when their `description` matches the task – so write it precisely and
trigger-strong. Use the `skill-creator` skill to create/optimize them.

*(This README is just a placeholder – replace it with real skills or delete the folder.)*
