# Failure Diagnosis

Use this protocol when acceptance verification fails and the root cause is not already established.

The goal is:

> What is wrong, where does it originate, and what must change?

Do not assume the implementation is wrong.

This is a read-only reference for `to-verify`. Describe required corrections; do not perform them, grant authorization, or invoke a correction workflow.

## Process

1. Identify the affected acceptance criterion and its authoritative contract, expected behavior, and observed failure.
2. Gather the strongest available reproduction evidence.
3. Follow the actual references and causal relationships through relevant evidence, which may include:
   - product requirements
   - accepted technical design
   - architectural decisions
   - specification and acceptance criteria
   - tests
   - implementation
   - runtime environment and external dependencies
4. Separate symptom, immediate cause, and root cause.
5. Identify the earliest cause supported by evidence along that causal path. Separate confirmed causes from hypotheses and unresolved questions.
6. Classify the failure and describe the required correction.

If repository evidence can answer a factual question, inspect it instead of asking the user.

If a genuinely user-owned ambiguity remains, report it as requiring a decision rather than inventing one.

The artifact list is neither a mandatory checklist nor a universal precedence order. Infer authority from the project's approved contract and references; claim an upstream contract defect only with supporting evidence.

Return when the evidence establishes ownership and the required correction, or further investigation needs unavailable evidence, an environment, additional permission, or a user decision. In the latter case, report what is known, what remains uncertain, and the specific evidence or action needed next. A fully proven root cause is not a prerequisite for delivering the acceptance report.

## Classification

Use one primary classification per distinct issue. The correction descriptions below are recommendations for a later user-requested action, not instructions to execute now:

- **Implementation Bug** — implementation violates a clear established contract; required correction belongs in the implementation.
- **Test Defect** — a check misrepresents the established contract or fails to measure it reliably; the check needs correction.
- **Spec Defect** — the implementation contract is incomplete, contradictory, ambiguous, or conflicts with governing requirements; specification and affected acceptance criteria need clarification or revision.
- **Design Defect** — accepted technical design does not satisfy established intent or constraints; the design needs revision before downstream correction.
- **Architectural Decision Defect** — evidence establishes that a durable architectural decision is no longer valid; a replacement decision is needed while preserving its history.
- **Product Requirement Defect** — evidence establishes a mismatch between product requirements and authorized product intent; requirements need a user-owned decision before downstream correction.
- **Environment / Dependency Issue** — an environment or dependency prevents required behavior or reliable observation; restoration or suitable verification conditions are needed.
- **Unresolved** — evidence cannot establish the cause or owner; further evidence or a decision is needed, as specified in the report.

## Root-Cause Rule

Prefer the earliest evidenced cause on the relevant causal path, without presuming that a higher-level artifact must be wrong.

Do not patch downstream behavior around an incorrect upstream contract.

Do not treat tests as automatically authoritative.

Do not rewrite historical architectural decisions to hide changed decisions.

## Result

Return the diagnosis to the calling `to-verify` acceptance report with:

- affected criterion and contract reference
- confirmed root cause, or hypotheses and explicit uncertainty
- classification
- supporting evidence
- affected authority or artifact
- required correction
- regression verification needed after correction

Acceptance status remains governed by `to-verify`: an evidenced contract violation remains FAIL even if its cause is unresolved. A faulty test or unavailable environment does not alone prove a product failure; distinguish observed violations from an inability to verify reliably. Diagnosis does not turn either case into PASS.
