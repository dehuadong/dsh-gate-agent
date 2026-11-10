---
name: gate-implement
description: Gate 派发的实现 worker；只负责授权范围、测试、findings 修正与 receipt。
---

# Implement

## 1. Entry conditions

Implement the selected scope of the work item (proposed Agent Note). Read its scope, acceptance criteria, and referenced design sections before coding.

Before implementation, check the scope and acceptance conditions, required decisions and approval evidence, unresolved blockers, and execution authorization for that scope under project rules. Reuse valid evidence without requesting confirmation again. Sync already agreed scope and decisions to their existing owners; route unresolved material decisions through the project's discussion, authorization, and gate rules before returning to discuss. Document status or location alone does not establish readiness or authorization.

## 2. Decompose when needed

After the Implementation Gate passes, create implementation tickets only when decomposition is needed. Their existence is not a condition for initially entering implementation.

Implement directly when the work fits one coherent execution unit.

Read `<gate-implement-dir>/tickets.md` when the work is too large or has meaningful independent slices or dependencies.

Do not create tickets merely to enumerate coding steps.

## 3. Execute

Implement against the selected work item's scope, acceptance conditions, referenced requirements, accepted designs and architectural decisions.

Use established architecture, conventions, interfaces, and domain language unless the authoritative design explicitly changes them.

If implementation exposes a material unresolved product, domain, architectural, interface, compatibility, or other contract decision, stop affected implementation and call `gate_record({node:'implement', requiresDiscussion:true, discussionReason})`. Do not invoke a slash command yourself. If `gate_record` is unavailable or fails, ask the user to enter `/gate-return-discuss`. Discuss the decision before any new planning or implementation authorization; do not continue the affected code.

### Implementation-time testing

Write or update tests as appropriate for the change. Use test-first development when it improves feedback or helps establish behavior clearly; when adopting it, load the `tdd` skill and follow its workflow.

Run focused tests and relevant static checks while working.

## 4. Implementation findings

The gate may return material findings. Resolve each finding by ownership:

| Finding                                                           | Route                                  |
| ----------------------------------------------------------------- | -------------------------------------- |
| Current implementation is missing or violates the agreed contract | Fix in the current implementation      |
| Additional execution unit is needed within the same agreed work   | Add or update an implementation ticket |
| Product or technical contract must change or was never resolved   | Stop affected work, call `gate_record` with `requiresDiscussion:true`, or ask the user for `/gate-return-discuss`; new planning needs authorization |
| Issue is unrelated to the agreed work                             | Do not expand scope automatically      |

There is no "fix it while we're here" path for unrelated work.

For findings you own, fix them in the current implementation, rerun the affected tests and static checks, and report each finding's disposition in the next receipt. Do not mark a finding resolved without evidence.

## 5. Receipt and handoff

Implementation is complete when:

- the authorized scope is implemented
- required tickets are complete
- relevant implementation-time checks pass
- material implementation findings are resolved or explicitly reported as blocked
- the change is ready for verification

Return a receipt with:

- changed files and scope covered
- tests and static checks run, with results
- each finding's disposition
- remaining risks, blockers, or decisions needed

Do not verify the delivery, mark the work item complete, or advance the gate. The gate owns the verify node and final completion.
