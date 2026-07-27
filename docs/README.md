# Ribbit documentation

Docs for the **ribbit** audio engine. For the reference host app built on top
of it, see the [nllc](../../nllc/docs/) docs.

- **[docs/user](user/)** — for people driving the engine with commands: a
  tutorial and the full command/object reference (the slash-command vocabulary
  `createCommandRouter` exposes).
- **[docs/dev](dev/)** — for people modifying the engine: architecture, source
  walkthrough, and tutorials for extending it (new synths, processors,
  modulators, commands) or taking a type back out again
  ([removing-a-type.md](dev/removing-a-type.md)).
- **[docs/llm](llm/)** — concise, context-window-friendly summaries meant to be
  fed to an LLM (a coding assistant, or a host app's natural-language layer)
  instead of the full source.
