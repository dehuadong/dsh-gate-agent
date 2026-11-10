---
name: gate-code-review
description: Gate code review worker：由主 agent 读取并提炼后派发；一个 worker 同时评审 Standards 与 Spec 两轴，不拆成两个技能。
---

Review the requested change scope on both **Standards** and **Spec** axes in one pass. Do not spawn sub-agents. The main agent has already read this method and will supply the concrete task, fixed point, and acceptance contract; do not re-load gate skills or method files.

## Standards


Review the requested change scope on the **Standards** axis only, including uncommitted work when applicable:

- does the change conform to this repo's documented standards and current authoritative decisions?

Do not review the Spec axis and do not spawn sub-agents. Resolve work tracking and document ownership from project instructions.

## Process

### 1. Pin the fixed point

Use the fixed point supplied by the gate or implementation workflow. Reuse the baseline already recorded in the conversation; ask only when the intended scope cannot be established from available context.

Capture the exact review commands once. For committed branch changes use `git diff <fixed-point>...HEAD`; for implementation worktree changes compare the recorded baseline to the working tree and separately inspect scoped untracked files. Include staged and unstaged changes, excluding pre-existing user changes and other tasks. Also record relevant commits. When existing changes overlap, inspect attribution rather than discarding the entire file.

Before reviewing, resolve the fixed point and verify the complete scope, including new files. If it is empty, report no changes to review; do not mistake an empty committed diff for an empty worktree.

### 2. Identify the standards sources

Read project instructions and the document ownership entry, then relevant writing and coding standards such as `CODING_STANDARDS.md` or `CONTRIBUTING.md`. Include the applicable design decisions and constraints identified by the project configuration and governing work item. Report missing or conflicting required inputs as review coverage gaps.

On top of whatever the repo documents, the Standards axis always carries the **smell baseline** below: a fixed set of Fowler code smells (_Refactoring_, ch.3) that applies even when a repo documents nothing. Two rules bind it:

- **The repo overrides.** A documented repo standard always wins; where it endorses something the baseline would flag, suppress the smell.
- **Always a judgement call.** Each smell is a labelled heuristic ("possible Feature Envy"), never a hard violation. Like any standard here, skip anything tooling already enforces.

Each smell reads *what it is* → *how to fix*; match it against the diff:

- **Mysterious Name**: a function, variable, or type whose name doesn't reveal what it does or holds. → rename it; if no honest name comes, the design's murky.
- **Duplicated Code**: the same logic shape appears in more than one hunk or file in the change. → extract the shared shape, call it from both.
- **Feature Envy**: a method that reaches into another object's data more than its own. → move the method onto the data it envies.
- **Data Clumps**: the same few fields or params keep travelling together (a type wanting to be born). → bundle them into one type, pass that.
- **Primitive Obsession**: a primitive or string standing in for a domain concept that deserves its own type. → give the concept its own small type.
- **Repeated Switches**: the same `switch`/`if`-cascade on the same type recurs across the change. → replace with polymorphism, or one map both sites share.
- **Shotgun Surgery**: one logical change forces scattered edits across many files in the diff. → gather what changes together into one module.
- **Divergent Change**: one file or module is edited for several unrelated reasons. → split so each module changes for one reason.
- **Speculative Generality**: abstraction, parameters, or hooks added for needs the spec doesn't have. → delete it; inline back until a real need shows.
- **Message Chains**: long `a.b().c().d()` navigation the caller shouldn't depend on. → hide the walk behind one method on the first object.
- **Middle Man**: a class or function that mostly just delegates onward. → cut it, call the real target direct.
- **Refused Bequest**: a subclass or implementer that ignores or overrides most of what it inherits. → drop the inheritance, use composition.

### 3. Output

Report, per file/hunk where relevant: (a) every place the diff violates a documented standard or current authoritative decision, citing the source and rule; and (b) any baseline smell you spot, naming it and quoting the hunk. Distinguish hard violations from judgement calls: documented rules and current decisions can be hard, but baseline smells are always judgement calls, and a documented repo standard overrides the baseline. Skip anything tooling enforces.

```json
{"ok":true,"findings":[{"axis":"Standards","summary":"...","evidence":"...","severity":"blocking|important"}],"summary":"..."}
```

Empty `findings` means this axis passes. Do not fix the findings.


## Spec


Review the requested change scope on the **Spec** axis only, including uncommitted work when applicable:

- does the change satisfy the governing work item's scope and acceptance conditions, including the work item acceptance contract?

Do not review the Standards axis and do not spawn sub-agents. Resolve work tracking and document ownership from project instructions.

## Process

### 1. Pin the fixed point

Use the fixed point supplied by the gate or implementation workflow. Reuse the baseline already recorded in the conversation; ask only when the intended scope cannot be established from available context.

Capture the exact review commands once. For committed branch changes use `git diff <fixed-point>...HEAD`; for implementation worktree changes compare the recorded baseline to the working tree and separately inspect scoped untracked files. Include staged and unstaged changes, excluding pre-existing user changes and other tasks. Also record relevant commits. When existing changes overlap, inspect attribution rather than discarding the entire file.

Before reviewing, resolve the fixed point and verify the complete scope, including new files. If it is empty, report no changes to review; do not mistake an empty committed diff for an empty worktree.

### 2. Identify the acceptance contract

First reuse the governing work item, acceptance conditions and applicable design already supplied by the gate or conversation. Otherwise:

1. Resolve a work identifier or path from the user's request, branch or relevant commits; locate it through the project's configured tracker or existing work-item convention.
2. Read that work item's selected scope and acceptance conditions, then follow its references to the applicable revision and sections of the work item contract. Use the registered document owner to resolve design decisions; do not infer a contract solely from a matching filename.
3. For direct changes without a separate work item, use the authorized user request and settled decisions in the conversation as the contract. If the contract still cannot be identified, ask the gate for its owner. Report the gap; do not invent acceptance.

### 3. Output

Report: (a) requirements of the acceptance contract that are missing or partial; (b) behaviour in the diff that wasn't requested (scope creep); (c) requirements that look implemented but where the implementation looks wrong. Quote or identify the exact contract clause for each finding.

```json
{"ok":true,"findings":[{"axis":"Spec","summary":"...","evidence":"...","severity":"blocking|important"}],"summary":"..."}
```

Empty `findings` means this axis passes. Do not fix the findings.


## Combined output

Return both axes in one result:

``json
{"ok":true,"standards":{"findings":[{"axis":"Standards","summary":"...","evidence":"...","severity":"blocking|important"}]},"spec":{"findings":[{"axis":"Spec","summary":"...","evidence":"...","severity":"blocking|important"}]},"summary":"..."}
``

Empty indings means that axis passes. Do not fix findings.
