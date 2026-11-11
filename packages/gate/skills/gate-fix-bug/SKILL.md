---
name: gate-fix-bug
description: "Fix a user-requested post-delivery implementation defect against its authoritative contract, using available diagnosis, focused correction, review, and regression verification."
user-invocable: false
---

# Fix Bug

Fix a post-delivery **Implementation Bug** that the user has explicitly asked to correct.

This skill changes code. It does not redesign product behavior or architecture.

## Gate worker assets

主 agent 使用本技能的 `assets/worker-briefs/gate-fix-bug.md` 派 fix worker；独立 review 使用 `assets/worker-briefs/fix-bug-review.md`。

## Preconditions

Before fixing, establish:

- observed failure
- expected behavior
- authoritative contract establishing the expected behavior
- available diagnosis and supporting evidence
- enough evidence to treat this as an implementation defect

Reuse an existing acceptance report or diagnosis when available, identifying the selected failure items and checking that its evidence still applies to the current delivery. A diagnosis explains the cause; it does not replace the contract. A prior report is not required for a direct user bug report.

The user requests the correction; determine its technical classification from evidence rather than requiring the user to confirm the root cause. When the cause is uncertain, investigate using `gate-diagnosing-bugs` before changing code. If evidence identifies a test, contract, design, or environment problem instead, report its ownership and required next action rather than treating it as an implementation bug.

Establish the selected repair scope and execution authorization under the project's workflow rules. Reuse authorization throughout in-scope correction, review, and re-verification.

Inspect the applicable product contract, design and decisions identified by project configuration and the work item, together with code and tests. Report missing or conflicting required inputs and the affected behavior before choosing its expected result. A defect spanning layers is not itself a reason to stop. Pause affected work only if fixing it requires an unresolved change to product behavior, an approved contract, acceptance, compatibility, migration strategy or authorized scope; surface that decision and continue independent authorized work. Do not guess a new contract in code.

## Process

1. Reproduce the reported failure.
2. Identify the smallest stable seam that captures the real bug.
3. Add or confirm regression coverage when practical; it should fail before the fix.
4. Locate the root implementation cause.
5. Apply the smallest coherent correction.
6. If unexpected technical failures arise during the fix, use `gate-diagnosing-bugs`.
7. Re-run the regression check and original reproduction.
8. Run directly related tests, then broader relevant tests when necessary.
9. Run typechecking/build checks where applicable.
10. The main agent uses `gate-code-review` to dispatch an independent review worker with the repair baseline, selected failures, contract references, and the complete repair diff, including new files.
11. Resolve material in-scope review findings by ownership. Return unresolved contract decisions to Discuss and obtain the required planning or implementation authorization under project gates; keep unrelated findings outside the repair scope.
12. Re-verify behavior affected by review corrections, including the original reproduction, affected acceptance criteria, and relevant regressions. Continue the correction and review loop until the completion conditions hold or further progress requires an unavailable dependency, a user-owned decision, or additional authorization.

Verify the original observable failure at an appropriate stable boundary. A passing lower-level regression test alone does not demonstrate that the original acceptance condition is restored. Complete this repair's verification within this skill; a separate user invocation of `gate-user-verify` is not a completion prerequisite.

## Scope Rules

Do not use a bug fix to introduce unrelated:

- refactoring
- architecture changes
- API redesign
- dependencies
- optimization
- cleanup
- product behavior

Small refactoring is allowed only when required to implement the correct fix safely.

Do not weaken or delete a valid test merely to make the suite pass.

## Completion

A fix is complete when:

- the original problem no longer reproduces
- expected behavior is restored
- the selected failed acceptance criteria have evidence of passing on the repaired delivery
- regression coverage passes when practical
- relevant tests/build checks pass
- no established contract was silently changed
- material in-scope review findings are resolved and affected behavior has been re-verified
- no blocker to this repair's completion remains

## Report

Lead with whether the selected repair is complete and verified or remains incomplete. Report:

- selected failure items and their latest results
- root implementation cause
- correction made
- regression coverage
- original reproduction and acceptance re-verification evidence
- review outcome and relevant regression results
- remaining failures, blockers, verification gaps, and required next actions, if any

Limit the conclusion to the selected repair. Unselected failures or blockers in the original acceptance report remain outside this completion claim. If the original behavior cannot be reliably verified, report the repair as incomplete rather than inferring success from code changes or passing checks alone.






