---
name: gate-research
description: Investigate a question against high-trust primary sources and capture the findings as a Markdown file in the repo. Use when the user wants a topic researched, docs or API facts gathered, or reading legwork delegated to a background agent.
user-invocable: false
---

调用 `gate_research_dispatch({ question, purpose })` 派 research worker，并等待结果。

worker 的职责：

1. Investigate the question against **primary sources** — official docs, source code, specs, first-party APIs — not a secondary write-up of them. Follow every claim back to the source that owns it.
2. Write the findings to a single Markdown file, citing each claim's source.
3. Save it with `gate_artifact_write({ kind: 'research', path, content })`；优先项目文档位置，否则 `.scratch/research/`。不要使用通用 `write`。

