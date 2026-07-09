---
name: Skills manager — Agent Instructions
description: Instructions for AI agents on how to use create, update, remove, and otherwise modify skills using the Overskill CLI
---

You have access to a skills system that provides curated instruction files
to guide your work. This file explains how to use it.

## Discovering Skills

Check `.Codex/skills/SKILLS_INDEX.md` (in the project root). It lists every
skill installed in this project with its name, description, tags, and file path.

Before starting any task, scan SKILLS_INDEX.md to identify relevant skills.
Match skills to your task by:
- Name and description (most reliable)
- Tags (e.g. if working with Supabase, look for "supabase" tag)
- Compatibility (check if your agent type is listed)

## Using Skills

When you find a relevant skill:
1. Read the full SKILL.md file at the path listed in SKILLS_INDEX.md
2. Follow its instructions as authoritative guidance for your work
3. If multiple skills are relevant, read all of them before starting
4. Skills take precedence over your default patterns when they conflict

## Updating Skills

EVERY TIME YOU ADD, UPDATE, OR REMOVE A SKILL, update the skill list in .Codex/skills/SKILLS_INDEX.md.