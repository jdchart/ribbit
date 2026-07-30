# Ribbit documentation

Docs for the **ribbit** audio engine. For the reference host app built on top
of it, see the [nllc](../../nllc/docs/) docs.

- **[docs/user](user/)** — for people driving the engine with commands: a
  tutorial and the full command/object reference (the slash-command vocabulary
  `createCommandRouter` exposes), plus
  **[patterns.md](user/patterns.md)** — how to write the hand-editable JSON
  files that `patternvariator` plays.
- **[docs/dev](dev/)** — for people modifying the engine: architecture, source
  walkthrough, and tutorials for extending it (new synths, processors,
  modulators, commands, or the
  [pattern format](dev/creating-a-pattern.md)) or taking a type back out again
  ([removing-a-type.md](dev/removing-a-type.md)).
- **[docs/llm](llm/)** — concise, context-window-friendly summaries meant to be
  fed to an LLM (a coding assistant, or a host app's natural-language layer)
  instead of the full source.

Looking for **what the engine can already do**? [`llm/catalog.md`](llm/catalog.md)
is a one-page list of every synth, processor and modulator with its params and
options, plus a "which one to copy" table for building a new one. Despite
living under `llm/`, it's the fastest orientation for a human too — and it must
be kept in step whenever a type is added or removed.
