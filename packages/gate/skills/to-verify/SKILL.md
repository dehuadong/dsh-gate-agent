---
name: to-verify
description: "Verify delivered behavior against approved requirements and acceptance criteria. Use observable evidence, diagnose failures when necessary, and report pass, fail, or blocked without modifying the delivery."
user-invocable: false
---

# Verify

Perform user-requested post-delivery acceptance verification.

Verify answers:

> Does the delivered behavior satisfy the approved acceptance contract?

This is not code review and does not modify the delivery.

Report the delivery's current acceptance state. The user decides whether to request repairs afterward; this skill does not start a correction workflow or advance engineering completion status.

## Rules

### 1. Verify the contract

Use the relevant authoritative artifacts:

- requirements
- acceptance criteria
- approved product behavior
- applicable technical design or architectural constraints
- compatibility requirements

Implementation is the subject of verification, not the source of expected behavior.

### 2. Verify observable behavior

Use the highest stable seam that demonstrates the required behavior, such as:

- user-visible behavior
- public API or CLI
- protocol or integration boundary
- service or domain boundary

Use lower-level checks only when necessary.

### 3. Tests are evidence, not authority

Existing tests may be reused when they actually demonstrate the acceptance criteria.

Passing tests, CI, or code review alone does not prove acceptance.

### 4. Do not repair during verification

Do not modify:

- product code
- tests
- requirements
- specifications
- technical design

Keep diagnosis read-only as well. Do not create commits or publish external review comments as part of this verification request.

Do not weaken or reinterpret acceptance expectations to obtain a pass.

### 5. Do not invent expected behavior

If authoritative artifacts allow materially different interpretations, mark the affected criterion `BLOCKED`.

Report the ambiguity instead of choosing an interpretation.

## Process

### Step 1 — Establish the acceptance contract

Identify the relevant:

- requirements
- acceptance criteria
- observable constraints
- compatibility expectations

Do not expand scope beyond the approved contract.

### Step 2 — Choose verification evidence

For each acceptance criterion, determine the highest stable seam and smallest sufficient check that can demonstrate it.

Reuse existing tests or interfaces when appropriate.

### Step 3 — Execute verification

Actually exercise the delivered behavior when practical.

For each required criterion record:

- `PASS` — evidence demonstrates the required behavior
- `FAIL` — observed behavior contradicts the required behavior
- `BLOCKED` — reliable verification cannot currently determine pass or fail

Do not infer `PASS` merely from the absence of observed failure.

Continue through all required criteria after finding a failure, checking those that remain independently verifiable and recording blockers for those that cannot be checked reliably.

### Step 4 — Diagnose failures

Do not assume a failed criterion is an implementation bug.

Confirm each failure against its contract reference, trigger or reproduction steps, expected behavior, observed behavior, and supporting evidence. Speculative concerns are not failures; insufficient acceptance evidence is a blocker. A demonstrated failure may have an unresolved cause: preserve FAIL and explicitly state what remains unknown.

Report pre-existing problems when they affect the acceptance contract, identifying their ownership without expanding the repair scope. Acceptance findings need not originate in the reviewed diff or point to a changed code line.

When the cause is not already established, use [DIAGNOSE.md](./DIAGNOSE.md) to identify:

- root cause
- classification
- supporting evidence
- affected authority or artifact
- required correction
- regression verification needed

Diagnosis describes what must change; it does not select or invoke the correction workflow.

### Step 5 — Check relevant regressions

Run regression checks when the delivered change may affect established adjacent behavior.

Keep the scope proportional to the change and its risk.

### Step 6 — Report

Produce a concise verification report.

## Report Output

# Verification: <Title>

## Result

PASS | FAIL | BLOCKED

## Failures

List discrete, actionable failures in impact order. For each include:

- affected criterion and contract reference
- trigger or reproduction steps and supporting evidence
- expected behavior
- observed behavior
- root cause and classification, or explicit uncertainty
- required correction

Omit when none fail.

## Blockers

Describe anything preventing reliable verification, the affected criteria, and what evidence or user decision is needed. Prioritize by impact.

Omit when none exist.

## Acceptance Results

For every required criterion, provide its contract reference, `PASS | FAIL | BLOCKED`, and observable evidence. Use a compact table or entries; reference failure and blocker details above rather than repeating them.

## Regression Checks

Relevant regression checks and results.

Omit when unnecessary.

## Verification Limits

State material coverage gaps and residual risks. Any gap preventing a reliable determination on a required criterion must also appear as BLOCKED for that criterion.

Omit when none exist.

## Overall Result

- `PASS` only when every required criterion passes
- `FAIL` when any required criterion fails
- `BLOCKED` when none fail but one or more required criteria cannot be reliably verified

Verification is complete when every required criterion has sufficient evidence or an explicit blocker and the current result has been reported. This completes the independent acceptance report, not a repair workflow. Do not substitute "No findings" for evidence-backed PASS or invent issues to fill the report.
