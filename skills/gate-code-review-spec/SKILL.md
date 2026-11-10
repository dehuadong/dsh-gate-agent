---
name: gate-code-review-spec
description: Gate Spec review worker：只评审工作项验收合同与适用 Spec，保留原 code-review 的固定点与合同识别方法，不评审 Standards 轴。
---

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
