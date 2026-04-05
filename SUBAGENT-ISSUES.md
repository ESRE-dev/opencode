# OpenCode Sub-Agent Issues & PRs Tracker

> Comprehensive list of all GitHub issues and PRs related to sub-agent runs in OpenCode.
> Generated from [anomalyco/opencode](https://github.com/anomalyco/opencode) on 2025-07-14.

---

## Table of Contents

- [Bugs: Execution and Lifecycle](#bugs-execution-and-lifecycle)
- [Bugs: UI and Navigation](#bugs-ui-and-navigation)
- [Bugs: Permissions and Security](#bugs-permissions-and-security)
- [Feature Requests: Core](#feature-requests-core)
- [Feature Requests: UI/UX](#feature-requests-uiux)
- [Feature Requests: Configuration and Model Selection](#feature-requests-configuration-and-model-selection)
- [Design Proposals](#design-proposals)
- [Pull Requests: Bug Fixes](#pull-requests-bug-fixes)
- [Pull Requests: Features](#pull-requests-features)

---

## Bugs: Execution and Lifecycle

Issues where sub-agent execution fails, hangs, or produces incorrect results.

| # | Title | State | Labels |
|---|-------|-------|--------|
| [#16303](https://github.com/anomalyco/opencode/issues/16303) | Task tool in nested subSession dispatches to wrong agent | OPEN | core |
| [#16254](https://github.com/anomalyco/opencode/issues/16254) | Subagent tool calls against external paths can apply side effects but never return results | OPEN | bug, core |
| [#16148](https://github.com/anomalyco/opencode/issues/16148) | Sub-Agents get stuck trying to find AGENTS.md file | OPEN | bug, core |
| [#14633](https://github.com/anomalyco/opencode/issues/14633) | Agent loses context of AGENTS.MD rules when invoking parallel Task tool for batch processing | OPEN | bug, windows, core |
| [#14424](https://github.com/anomalyco/opencode/issues/14424) | Explore Task sub-agent is non-interactable 0 toolcalls | OPEN | bug, core |
| [#14195](https://github.com/anomalyco/opencode/issues/14195) | Multiple Task tool calls in a single LLM response execute sequentially instead of in parallel | OPEN | core |
| [#14063](https://github.com/anomalyco/opencode/issues/14063) | Gemini models in Task (subagent) session immediately stopped | OPEN | bug, core |
| [#13910](https://github.com/anomalyco/opencode/issues/13910) | Task tool loses session ID (task_id) when sub-agent fails or is cancelled | OPEN | bug |
| [#13333](https://github.com/anomalyco/opencode/issues/13333) | Subagent given silly instructions (started recently) | OPEN | bug |
| [#11903](https://github.com/anomalyco/opencode/issues/11903) | Task tool truncation drops session_id metadata | OPEN | - |
| [#11324](https://github.com/anomalyco/opencode/issues/11324) | Task tool ignores per-target deny and allows self-dispatch recursion | OPEN | - |
| [#11012](https://github.com/anomalyco/opencode/issues/11012) | SubAgents are enclosed, prohibiting genuine task management | OPEN | bug, docs |
| [#10492](https://github.com/anomalyco/opencode/issues/10492) | Agent question is not passed in a sub-sub session | CLOSED | bug |
| [#8733](https://github.com/anomalyco/opencode/issues/8733) | Subagent not reading markdown instructions from agent definition file | OPEN | bug |
| [#8089](https://github.com/anomalyco/opencode/issues/8089) | Auto-compaction errors still occur in agent workflows | OPEN | bug, docs |
| [#6598](https://github.com/anomalyco/opencode/issues/6598) | KimiK2-thinking fails at subagent call | OPEN | bug, zen |
| [#4483](https://github.com/anomalyco/opencode/issues/4483) | Subagents inappropriately inherit main agent instructions from CLAUDE.md/AGENTS.md | OPEN | bug |
| [#4439](https://github.com/anomalyco/opencode/issues/4439) | Subagents are using the task tool (unauthorized nesting) | OPEN | bug |
| [#3526](https://github.com/anomalyco/opencode/issues/3526) | Performance issue: session-child-cycle becomes extremely slow with many sessions | OPEN | perf |
| [#3173](https://github.com/anomalyco/opencode/issues/3173) | Subagent results not always properly handled | OPEN | - |
| [#9379](https://github.com/anomalyco/opencode/issues/9379) | Task tool constantly used even after disabling it | OPEN | bug |
| [#12950](https://github.com/anomalyco/opencode/issues/12950) | .opencode/agents/ folder agents give tool_call response | OPEN | - |

## Bugs: UI and Navigation

Issues with the TUI/Desktop/Web rendering and navigation of sub-agent sessions.

| # | Title | State | Labels |
|---|-------|-------|--------|
| [#16039](https://github.com/anomalyco/opencode/issues/16039) | Stale read from Show crash when trying to access subagent task | OPEN | bug, windows, web |
| [#16002](https://github.com/anomalyco/opencode/issues/16002) | Unable to click on task tool calls to go to subagent view in v1.2.16 | CLOSED | bug, opentui |
| [#15972](https://github.com/anomalyco/opencode/issues/15972) | Subagent navigation broken for nested sessions and imprecise for multiple concurrent tasks | OPEN | opentui |
| [#15769](https://github.com/anomalyco/opencode/issues/15769) | Clicking on Task tool no longer navigates to subagent session | CLOSED | core |
| [#14053](https://github.com/anomalyco/opencode/issues/14053) | Web UI session list shows subagent and archived sessions that TUI hides | OPEN | bug, core |
| [#13715](https://github.com/anomalyco/opencode/issues/13715) | Permission asks from nested subagent sessions silently hang | OPEN | bug, opentui |
| [#13563](https://github.com/anomalyco/opencode/issues/13563) | OpenCode Desktop Sub-Agents scroll remains in the middle if you navigate and come back | OPEN | bug, web |
| [#13334](https://github.com/anomalyco/opencode/issues/13334) | Sub-Agents constantly trigger OS notifications | OPEN | bug |
| [#12271](https://github.com/anomalyco/opencode/issues/12271) | opencode web: child session created with ?directory= returns empty body on POST | OPEN | - |
| [#11034](https://github.com/anomalyco/opencode/issues/11034) | Desktop version of OpenCode cannot call the sub-agent | OPEN | web |
| [#10444](https://github.com/anomalyco/opencode/issues/10444) | session_child_cycle + session_child_cycle_reverse stopped working | OPEN | bug, opentui |
| [#7654](https://github.com/anomalyco/opencode/issues/7654) | Questions from nested sub-agents don't appear in TUI | OPEN | bug, opentui |
| [#7241](https://github.com/anomalyco/opencode/issues/7241) | Color for sub-agents have no effect | OPEN | bug, opentui |
| [#6491](https://github.com/anomalyco/opencode/issues/6491) | Session does not automatically return to parent after subagent execution | OPEN | bug |
| [#6191](https://github.com/anomalyco/opencode/issues/6191) | Subagent session doesn't appear in Desktop Sidebar anymore | OPEN | web |
| [#4727](https://github.com/anomalyco/opencode/issues/4727) | Subagent Switching - Buggy | OPEN | bug, opentui |
| [#4422](https://github.com/anomalyco/opencode/issues/4422) | Primary agent responds in subagent view; delegated subagent views become inaccessible | OPEN | good first issue, opentui |
| [#2390](https://github.com/anomalyco/opencode/issues/2390) | Switching to child session doesn't send subsequent messages to that session but to the parent | OPEN | - |
| [#16270](https://github.com/anomalyco/opencode/issues/16270) | /sessions TUI only shows recent sessions, ignores historical ones | OPEN | windows, core |

## Bugs: Permissions and Security

Issues where sub-agents bypass or incorrectly inherit permissions.

| # | Title | State | Labels |
|---|-------|-------|--------|
| [#12566](https://github.com/anomalyco/opencode/issues/12566) | Subagents don't respect "*": "allow" agent permissions | OPEN | bug |
| [#10057](https://github.com/anomalyco/opencode/issues/10057) | plan agent runs amok and starts writing | OPEN | bug |
| [#9554](https://github.com/anomalyco/opencode/issues/9554) | "Always allow" TUI approvals override restrictions for all agents | OPEN | bug, opentui |
| [#8852](https://github.com/anomalyco/opencode/issues/8852) | Plan mode called a subagent to bypass edit permission | OPEN | - |
| [#6527](https://github.com/anomalyco/opencode/issues/6527) | Plan mode restrictions bypassed when spawning sub-agents | OPEN | - |
| [#5894](https://github.com/anomalyco/opencode/issues/5894) | Plugin hooks don't intercept subagent tool calls - security bypass | OPEN | bug |
| [#5475](https://github.com/anomalyco/opencode/issues/5475) | Files were modified even being under Plan Mode | OPEN | bug |
| [#14308](https://github.com/anomalyco/opencode/issues/14308) | Custom agents cannot access task tool despite frontmatter configuration | OPEN | core |

## Feature Requests: Core

Feature requests for sub-agent execution, lifecycle, and architecture.

| # | Title | State | Labels |
|---|-------|-------|--------|
| [#15969](https://github.com/anomalyco/opencode/issues/15969) | Asynchronous user-agent communication | OPEN | discussion, core |
| [#15877](https://github.com/anomalyco/opencode/issues/15877) | Should /undo also rollback subagent child sessions created after reverted message? | OPEN | core |
| [#15332](https://github.com/anomalyco/opencode/issues/15332) | Subagent view - permission requests | OPEN | discussion, core |
| [#15082](https://github.com/anomalyco/opencode/issues/15082) | Agents to span different model subagents | OPEN | discussion, core |
| [#15080](https://github.com/anomalyco/opencode/issues/15080) | Add configurable timeout parameter to the Task tool | OPEN | core |
| [#14510](https://github.com/anomalyco/opencode/issues/14510) | Disallow subagents to spawn new sub-sub-agents (nesting) | OPEN | discussion, core |
| [#13916](https://github.com/anomalyco/opencode/issues/13916) | Individual task cancellation | OPEN | discussion |
| [#12930](https://github.com/anomalyco/opencode/issues/12930) | Forward session and parent-session IDs as HTTP headers in LLM API requests | OPEN | - |
| [#10374](https://github.com/anomalyco/opencode/issues/10374) | Allow "aborted" agents to be continued | OPEN | discussion |
| [#8554](https://github.com/anomalyco/opencode/issues/8554) | Enable programmatic sub-LLM calls for RLM (Recursive Language Model) pattern | OPEN | - |
| [#7296](https://github.com/anomalyco/opencode/issues/7296) | Allow configurable subagent-to-subagent task delegation with call limits | OPEN | discussion |
| [#6792](https://github.com/anomalyco/opencode/issues/6792) | Task Tool Timeouts and Early Termination in Multi-Agent Conductor Pattern | OPEN | windows |
| [#6584](https://github.com/anomalyco/opencode/issues/6584) | Agent-level resume for subagents (resumeSessionId parameter) | OPEN | - |
| [#5887](https://github.com/anomalyco/opencode/issues/5887) | True Async/Background Sub-Agent Delegation | OPEN | - |
| [#3153](https://github.com/anomalyco/opencode/issues/3153) | Subagents should support auto compaction | OPEN | - |
| [#2906](https://github.com/anomalyco/opencode/issues/2906) | Limit Subagent Tree Depth | OPEN | - |
| [#2588](https://github.com/anomalyco/opencode/issues/2588) | Let subagents inherit context | OPEN | - |
| [#1047](https://github.com/anomalyco/opencode/issues/1047) | Automatize review-fix-review-n-finish workflow with subagents | OPEN | - |
| [#14592](https://github.com/anomalyco/opencode/issues/14592) | ACP: tool_call_update in_progress notifications don't include tool metadata | OPEN | acp |

## Feature Requests: UI/UX

Feature requests for sub-agent display, navigation, and interaction in TUI/Desktop/Web.

| # | Title | State | Labels |
|---|-------|-------|--------|
| [#16287](https://github.com/anomalyco/opencode/issues/16287) | Show agent type and session ID in Task tool call display | OPEN | - |
| [#16242](https://github.com/anomalyco/opencode/issues/16242) | Able to click subagents in TUI | OPEN | opentui, discussion |
| [#15216](https://github.com/anomalyco/opencode/issues/15216) | Web UI does not have any method of getting to permission request in sub-agents | OPEN | bug, web |
| [#12980](https://github.com/anomalyco/opencode/issues/12980) | Remember thinking state when navigating between sub-agents in Desktop App | OPEN | discussion, web |
| [#12463](https://github.com/anomalyco/opencode/issues/12463) | Sub-agent status sidebar panel | OPEN | - |
| [#11575](https://github.com/anomalyco/opencode/issues/11575) | Support plugin delegation tools in subagent UI view | OPEN | - |
| [#10339](https://github.com/anomalyco/opencode/issues/10339) | Add visual indicator for subagent status (running, error, finished) | OPEN | opentui, discussion |
| [#8322](https://github.com/anomalyco/opencode/issues/8322) | Show background tasks status in sidebar | OPEN | web |
| [#7923](https://github.com/anomalyco/opencode/issues/7923) | Sub-agents in opencode desktop | OPEN | discussion, web |
| [#6183](https://github.com/anomalyco/opencode/issues/6183) | Add interactive session switcher for navigating between subagent sessions | OPEN | opentui |
| [#5578](https://github.com/anomalyco/opencode/issues/5578) | Custom command to cycle between child sessions | OPEN | - |
| [#4432](https://github.com/anomalyco/opencode/issues/4432) | "session_child_return_to_parent" in keybinds | OPEN | discussion |
| [#3291](https://github.com/anomalyco/opencode/issues/3291) | Navigation to parent session from child/subagent sessions | OPEN | - |

## Feature Requests: Configuration and Model Selection

Feature requests for configuring sub-agent models, variants, and behavior.

| # | Title | State | Labels |
|---|-------|-------|--------|
| [#10320](https://github.com/anomalyco/opencode/issues/10320) | Specify sub-agent variant (thinking lvl) from script for token economy | OPEN | discussion, zen |
| [#9575](https://github.com/anomalyco/opencode/issues/9575) | Model fallback in specific agents | OPEN | discussion, docs |
| [#8456](https://github.com/anomalyco/opencode/issues/8456) | Opencode could automatically use different models based on task type | OPEN | discussion |
| [#8123](https://github.com/anomalyco/opencode/issues/8123) | Can't set the effort when configuring a sub-agent | OPEN | docs |
| [#7138](https://github.com/anomalyco/opencode/issues/7138) | Support default variant configuration per agent | OPEN | - |
| [#6651](https://github.com/anomalyco/opencode/issues/6651) | Dynamic model selection for subagents via Task tool | OPEN | discussion |
| [#7457](https://github.com/anomalyco/opencode/issues/7457) | Add option to call sub-agents like CC and also being able to call skills | OPEN | discussion |
| [#6627](https://github.com/anomalyco/opencode/issues/6627) | Delegate to Coding Agent? | OPEN | discussion |
| [#4925](https://github.com/anomalyco/opencode/issues/4925) | Display total cost for session | OPEN | discussion |
| [#3374](https://github.com/anomalyco/opencode/issues/3374) | Optimal use of subagents | OPEN | - |

## Design Proposals

High-level design proposals for multi-agent architecture.

| # | Title | State | Labels |
|---|-------|-------|--------|
| [#12711](https://github.com/anomalyco/opencode/issues/12711) | Agent Teams: flat teams with named messaging, multi-model support, and TUI integration | OPEN | - |
| [#12661](https://github.com/anomalyco/opencode/issues/12661) | Add Agent Teams Equivalent or Better | OPEN | discussion |

---

## Pull Requests: Bug Fixes

| # | Title | State | Fixes |
|---|-------|-------|-------|
| [#16273](https://github.com/anomalyco/opencode/pull/16273) | fix(tui): pass roots:true in session list bootstrap to fix child session dilution | OPEN | #16270 |
| [#15993](https://github.com/anomalyco/opencode/pull/15993) | fix(tui): restore nested subagent navigation without changing inline task UI | OPEN | #15972 |
| [#15974](https://github.com/anomalyco/opencode/pull/15974) | fix(tui): fix nested subagent navigation and restore click-to-navigate on tasks | CLOSED | #15972 |
| [#15946](https://github.com/anomalyco/opencode/pull/15946) | fix(tui): restore agent name in task progress display | OPEN | - |
| [#15770](https://github.com/anomalyco/opencode/pull/15770) | fix(tui): make "view subagents" hint clickable to restore Task click-to-navigate | CLOSED | #15769 |
| [#15036](https://github.com/anomalyco/opencode/pull/15036) | fix(core): reinforce project instructions in Task tool sub-agent prompts | OPEN | #14633 |
| [#14196](https://github.com/anomalyco/opencode/pull/14196) | fix(opencode): execute subtask tool calls in parallel | OPEN | #14195 |
| [#13974](https://github.com/anomalyco/opencode/pull/13974) | fix(run): prevent subagent question tool hang in non-interactive mode | OPEN | - |
| [#13958](https://github.com/anomalyco/opencode/pull/13958) | fix(task): return task_id when subagent run errors | OPEN | #13910 |
| [#13719](https://github.com/anomalyco/opencode/pull/13719) | fix: render permission and question prompts from nested subagent session | OPEN | #13715 |
| [#13422](https://github.com/anomalyco/opencode/pull/13422) | fix(opencode): propagate subagent errors to parent session | OPEN | - |
| [#13321](https://github.com/anomalyco/opencode/pull/13321) | fix: robust subagent completion propagation | OPEN | - |
| [#12584](https://github.com/anomalyco/opencode/pull/12584) | fix: propagate parent agent permissions to subagent child sessions | OPEN | #12566 |
| [#12136](https://github.com/anomalyco/opencode/pull/12136) | fix(acp): handle permission requests from child sessions | OPEN | - |
| [#10539](https://github.com/anomalyco/opencode/pull/10539) | fix(questions): fixes where sub-sub agents can't ask questions | OPEN | #7654 |
| [#9254](https://github.com/anomalyco/opencode/pull/9254) | fix: prevent Plan mode bypass via sub-agent spawning | OPEN | #6527 |
| [#7473](https://github.com/anomalyco/opencode/pull/7473) | fix: prevent subagent permission bypass via tools field inheritance | OPEN | - |
| [#6532](https://github.com/anomalyco/opencode/pull/6532) | fix: inherit Plan mode permissions when spawning sub-agents | OPEN | #6527 |
| [#6073](https://github.com/anomalyco/opencode/pull/6073) | refactor(agent): set Explore subagent bash permissions to read-only | OPEN | - |
| [#13955](https://github.com/anomalyco/opencode/pull/13955) | fix: handle null/undefined in titlecase | OPEN | - |

## Pull Requests: Features

| # | Title | State | Related |
|---|-------|-------|---------|
| [#15738](https://github.com/anomalyco/opencode/pull/15738) | feat(tui): add Subagents section to session sidebar | OPEN | #12463 |
| [#14961](https://github.com/anomalyco/opencode/pull/14961) | feat: add model parameter to Task tool for dynamic subagent model selection | OPEN | #6651 |
| [#14814](https://github.com/anomalyco/opencode/pull/14814) | Change keybindings to navigate between child sessions | MERGED | - |
| [#14678](https://github.com/anomalyco/opencode/pull/14678) | feat: use subagent color as left border-color for InlineTool | OPEN | #7241 |
| [#14588](https://github.com/anomalyco/opencode/pull/14588) | feat(acp): surface tool metadata in in_progress notifications | OPEN | #14592 |
| [#14267](https://github.com/anomalyco/opencode/pull/14267) | fix: preserve per-session input drafts when switching sessions | OPEN | - |
| [#14043](https://github.com/anomalyco/opencode/pull/14043) | feat(web): show subagents under parent session, allow intuitive navigation | OPEN | - |
| [#14023](https://github.com/anomalyco/opencode/pull/14023) | feat(task): add runtime systemPrompt override for subtask agents | OPEN | - |
| [#13924](https://github.com/anomalyco/opencode/pull/13924) | feat: support individual subagent cancellation | OPEN | #13916 |
| [#13588](https://github.com/anomalyco/opencode/pull/13588) | feat: add sub-agent cost breakdown with recursive session walker | OPEN | #4925 |
| [#13480](https://github.com/anomalyco/opencode/pull/13480) | feat: subagent session pagination | OPEN | - |
| [#13261](https://github.com/anomalyco/opencode/pull/13261) | feat(opencode): support background subagents | OPEN | #5887 |
| [#12932](https://github.com/anomalyco/opencode/pull/12932) | feat: send x-session-id and x-parent-session-id headers in LLM API requests | OPEN | #12930 |
| [#12731](https://github.com/anomalyco/opencode/pull/12731) | feat: add team tools, HTTP routes, and tool registry integration | OPEN | #12711 |
| [#12567](https://github.com/anomalyco/opencode/pull/12567) | feat(task): pass variant to subagent so it inherits parent's thinking level | OPEN | #10320 |
| [#11588](https://github.com/anomalyco/opencode/pull/11588) | feat: support delegate_task tool in subagent UI view | OPEN | #11575 |
| [#11573](https://github.com/anomalyco/opencode/pull/11573) | feat(ui): support delegate_task tool for subagent view | OPEN | - |
| [#11377](https://github.com/anomalyco/opencode/pull/11377) | feat(agent): implement model tier selection with variant support for subagents | OPEN | - |
| [#11217](https://github.com/anomalyco/opencode/pull/11217) | feat(task): allow @agent:provider/model model overrides | OPEN | - |
| [#8721](https://github.com/anomalyco/opencode/pull/8721) | fix: prevent excessive Copilot premium request consumption | OPEN | - |
| [#7903](https://github.com/anomalyco/opencode/pull/7903) | feat: add sub-agent management, skills loading, debugging agent | OPEN | - |
| [#7756](https://github.com/anomalyco/opencode/pull/7756) | feat(task): subagent-to-subagent delegation with budgets, persistent sessions, and hierarchical navigation | OPEN | #7296, #2906 |
| [#7271](https://github.com/anomalyco/opencode/pull/7271) | feat(agent): add subagents config for per-agent task tool filtering | OPEN | - |
| [#7206](https://github.com/anomalyco/opencode/pull/7206) | feat(tui): fire-and-forget async subagent tasks | OPEN | - |
| [#7156](https://github.com/anomalyco/opencode/pull/7156) | feat: add variant support for subagents | OPEN | #7138 |
| [#6368](https://github.com/anomalyco/opencode/pull/6368) | Desktop: sidebar subsessions support | OPEN | - |
| [#4865](https://github.com/anomalyco/opencode/pull/4865) | feat: add subagents sidebar with clickable navigation and parent keybind | OPEN | - |

---

## Summary Statistics

| Category | Open | Closed/Merged | Total |
|----------|------|---------------|-------|
| Bugs: Execution and Lifecycle | 20 | 1 | 21 |
| Bugs: UI and Navigation | 16 | 2 | 18 |
| Bugs: Permissions and Security | 8 | 0 | 8 |
| Feature Requests: Core | 19 | 0 | 19 |
| Feature Requests: UI/UX | 13 | 0 | 13 |
| Feature Requests: Config and Model | 10 | 0 | 10 |
| Design Proposals | 2 | 0 | 2 |
| PRs: Bug Fixes | 18 | 2 | 20 |
| PRs: Features | 25 | 1 | 26 |
| **Total** | **131** | **6** | **137** |

---

## Critical Path Issues (Blocking Nested Sub-Agent Workflows)

These issues form the critical path for making nested sub-agent hierarchies work reliably:

1. **Execution**: [#16303](https://github.com/anomalyco/opencode/issues/16303) - Wrong agent dispatch at depth >= 2
2. **Execution**: [#16148](https://github.com/anomalyco/opencode/issues/16148) - Sub-agents get stuck (0 toolcalls)
3. **UI**: [#15972](https://github.com/anomalyco/opencode/issues/15972) - Navigation broken for nested sessions
4. **UI**: [#13715](https://github.com/anomalyco/opencode/issues/13715) - Permission asks from nested sessions silently hang
5. **UI**: [#7654](https://github.com/anomalyco/opencode/issues/7654) - Questions from nested sub-agents don't appear
6. **Core**: [#15080](https://github.com/anomalyco/opencode/issues/15080) - No timeout parameter for Task tool
7. **Core**: [#14195](https://github.com/anomalyco/opencode/issues/14195) - Parallel task calls execute sequentially
8. **ACP**: [#14592](https://github.com/anomalyco/opencode/issues/14592) - in_progress notifications missing metadata for live session peeking

## Key PRs to Watch

- [#7756](https://github.com/anomalyco/opencode/pull/7756) - **The big one**: subagent-to-subagent delegation with budgets and hierarchical navigation
- [#15993](https://github.com/anomalyco/opencode/pull/15993) - Fixes nested subagent navigation in TUI
- [#13321](https://github.com/anomalyco/opencode/pull/13321) - Robust subagent completion propagation (would prevent stuck sessions)
- [#13924](https://github.com/anomalyco/opencode/pull/13924) - Individual subagent cancellation
- [#14196](https://github.com/anomalyco/opencode/pull/14196) - Parallel subtask execution
- [#10539](https://github.com/anomalyco/opencode/pull/10539) - Sub-sub agent question forwarding