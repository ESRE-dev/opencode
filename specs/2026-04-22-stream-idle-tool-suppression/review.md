## Spec Review Report — Gemini

### Verdict: NEEDS_WORK

### Subagents Invoked
| # | Agent | Purpose | Key Finding |
|---|-------|---------|-------------|
| 1 | @codebase-analyzer | Verify file paths and interfaces | Claims verified accurate (manual check resolved test path). |

---

### 1. Goal Coverage
- **Goal sections covered**: All
- **Scope creep detected**: NO
- The requirements perfectly capture the surgical fix proposed in the goal file, accurately maintaining backward compatibility and avoiding out-of-scope work like per-tool stuck detection.

### 2. EARS Compliance
- **Criteria using named EARS patterns**: 19/26
- **INCOSE violations found**: 8
- **Issue 1**: Improper mixing of Event and State patterns (Criteria 1.1, 1.2, 2.3, 3.4). EARS requires the Complex pattern (`WHERE -> WHILE -> WHEN/IF -> THE SYSTEM SHALL`) when both state and events are present.
  - *Example 1.1*: "WHEN the stream idle timer expires AND the in-flight tool count is greater than zero..." should be "WHILE the in-flight tool count is greater than zero, WHEN the stream idle timer expires, THE SYSTEM SHALL..."
- **Issue 2**: Invalid EARS keyword "THEN" (Criteria 4.1, 4.2, 4.3). EARS does not use "THEN" in IF statements. These should use "WHEN <trigger> THE SYSTEM SHALL" or "IF <trigger> THE SYSTEM SHALL" without "THEN".
- **Issue 3**: Untestable phrasing / Escape clause in 1.3. "with no upper limit on the number of consecutive re-arms" is explanatory and violates the "explicit and measurable values / solution-free" rule. The property covers the universality.

### 3. Cross-Reference Integrity
- **Requirements → Design coverage**: 26/26
- **Requirements → Design Properties**: All relevant functional requirements have ≥1 property.
- **Design → Beads coverage**: 100%
- **Coverage Summary accurate**: YES
- **Coverage Summary complete**: 26/26 criteria have rows.

### 4. Correctness Properties
- **Properties section exists**: YES
- **Acceptance criteria analysis complete**: 26/26 criteria analyzed
- **Properties with valid quantifiers**: 5/5
- **Properties with valid traceability**: 5/5
- Excellent usage of universal `*For any*` quantifiers and proper separation between properties and examples.

### 5. Checkpoints & Coverage Summary
- **Foundation checkpoint exists**: YES
- **Module checkpoints exist**: N/A (single task)
- **Final checkpoint exists**: YES
- **Coverage summary rows**: 26/26 criteria covered
- **EARS Pattern column accurate**: YES
- **Property column accurate**: YES
- **Issue 1**: The final checkpoint bead (`opencode-8mr.2`) is missing `lint` and `format` commands in its validation suite.

### 6. Codebase Grounding
| # | Claim in Spec | Location | Finding | Severity |
|---|--------------|----------|---------|----------|
| 1 | `startStreamIdleTripwire` signature at `processor.ts:26` | requirements.md | Accurate | PASS |
| 2 | `ctx.toolcalls` is `Record<string, ToolCall>` at `processor.ts:98` | requirements.md | Accurate | PASS |
| 3 | Call site at `processor.ts:586` with `streamInput.parentSessionID` | requirements.md | Accurate | PASS |
| 4 | `WATCHDOG_TIMEOUT_DEFAULTS.stream_idle` is 300 in `error.ts` | requirements.md | Accurate | PASS |
| 5 | Tripwire tests exist in `tripwires.test.ts` | requirements.md | Accurate | PASS |

### 7. Technical Feasibility
| # | Claim in Spec | Library/API | Finding | Severity |
|---|--------------|------------|---------|----------|
| 1 | JS Single-Threaded Race Safety | V8/Node/Bun | Accurate | PASS |
| 2 | AI SDK stream silence between tool-call and tool-result | Vercel AI SDK | Accurate | PASS |

### 8. Spec Quality
| # | Location | Issue | Severity | Fix Recommendation |
|---|----------|-------|----------|-------------------|
| 1 | requirements.md | EARS violation: Mixing event and state | MODERATE | Rewrite 1.1, 1.2, 2.3, 3.4 to use the Complex pattern (`WHILE <state>, WHEN <event>, THE SYSTEM SHALL...`) |
| 2 | requirements.md | EARS violation: Invalid keyword "THEN" | MODERATE | Remove "THEN" from criteria 4.1, 4.2, 4.3. Use standard "IF/WHEN <trigger> THE SYSTEM SHALL". |
| 3 | opencode-8mr.2 | Incomplete validation suite | MODERATE | Add `lint` and `format` validation commands to the checkpoint bead description. |

---

## Issues Summary

- **CRITICAL**: 0
- **MODERATE**: 3
- **MINOR**: 0

### Must Fix Before Implementation
*(No critical issues, but moderate issues should be addressed for spec hygiene)*
1. **EARS-01**: Rewrite criteria 1.1, 1.2, 2.3, 3.4 using the proper Complex pattern (`WHILE <state>, WHEN <event>...`).
2. **EARS-02**: Remove the invalid "THEN" keyword from criteria 4.1, 4.2, 4.3.
3. **CHK-01**: Update the checkpoint bead `opencode-8mr.2` to include `lint` and `format` commands in the validation checklist.

### Cycle Status
- **Current Cycle**: 1 of 3
- **Previous Issues Fixed**: N/A
- **Recommendation**: REVISE
