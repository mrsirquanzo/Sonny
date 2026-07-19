# Spec: Sonny Data Analysis Workbook skill

Date: 2026-07-17
Status: proposed
Author: Quan (with Claude)
Reference: Science Machine "Sam" workbook (app.sciencemachine.ai) - the flow Quan tested and wants for Sonny.
Builds on: 2026-07-16-sonny-analysis-toolbox.md (Slices 0-5: hardened sandbox, grounded computed claims, `sonny analyze`).

## 1. One-line goal

A systematic, scientist-style data-analysis agent for Sonny: given uploaded scientific data + a question, it explores the data, declares its assumptions (with impact + alternatives), preregisters a plan, executes each step as sandboxed code, and returns a grounded, reproducible report - every figure and number traceable to code that ran in the hardened sandbox.

## 2. Why

Science Machine's "Sam" (a "24/7 AI bioinformatician") automates raw-data -> report for biologists who aren't bioinformaticians. Its flow reads like a scientist working: explore -> declare assumptions -> confirm the high-impact calls -> preregister a plan -> execute step by step with inline figures -> structured report.
Sonny already has the hard part they are catching up to: sandboxed execution (Slice 3) and grounded, literature-cited claims. This skill adds the missing methodology + presentation layer on top - and Sonny's edge is that its assumptions and results are GROUNDED and VERIFIED, not just declared.

## 3. The scientist-loop flow (faithful to the reference)

The workbook is a vertical, collapsible "working steps" trace ("Hide working steps"), then durable output blocks. Stages, in order:

### 3.1 Explore (working steps)
A live trace of the agent's actions:
- narrative thoughts ("I'll start by exploring the workspace to understand what data files are available.")
- tool calls (`glob`, file inspection)
- `Code execution` blocks with an expandable `Output >`
Purpose: understand what the data IS before acting ("I see an FCS file (flow cytometry data)...").

### 3.2 Declare assumptions (the standout block)
An `Assumptions` block: header `N checked / M inferred` + a `K needs input` badge. Each assumption is a row:
- name (e.g. "Gating strategy")
- impact: `high | medium | low`
- source: `user_specified | agent_inferred`
- needsUserInput: boolean (surfaced only for high-impact inferred ones)
- chosen: the value the agent will proceed with
- alternatives: the other defensible options it considered (may be empty for user-specified)
This is Sonny's philosophy made concrete (global instruction: "state assumptions before acting"). Sonny extension: where an assumption is checkable against data or literature, mark it `verified` with the grounding evidence, not merely `inferred`.

### 3.3 Response required (human-in-the-loop gate)
`The agent needs your input`. One or more single-choice questions, each with:
- the question + context (data summary)
- the recommended default (pre-selected) + "Write a custom answer"
Controls: `Accept` (uses defaults) or `Something else`. "Defaults are included when you accept."
Only high-impact, agent-inferred assumptions become questions; everything else proceeds on defaults. Non-interactive runs (CI, cron) auto-accept defaults and record that they did.

### 3.4 Preregistered analysis plan
An `Analysis Plan` block: `X/N steps`, an ordered checklist (e.g. Load and inspect -> FSC/SSC gating -> singlet -> viability -> lineage -> marker analysis -> heatmap -> summary). Shown BEFORE execution. The current step is highlighted; completed steps get a checkmark and their generated figure thumbnails inline.

### 3.5 Execute step by step
Each plan step: the agent writes Python, runs it in the hardened sandbox over the uploaded data, captures stdout + figures, and marks the step done with its figures attached. Failures degrade the step (RED), never abort the run.

### 3.6 Structured report
A durable report card:
- a bullet summary with hard numbers ("10,765 B cells (55.6% of total); 91.0% viability")
- captioned figures with quantitative captions ("Figure 1... retaining 92.4% of events")
- expandable sections: `Detailed Answer`, `Methods` (reproducibility), `Assumptions Made`
Exportable (PDF/Markdown), and - Sonny's edge - literature-referenced interpretation with citations.

## 4. Data model (packages/shared, Zod)

- `WorkingStep` = discriminated union: `{kind:'thought', text}` | `{kind:'tool_call', tool, args, output?}` | `{kind:'code', code, stdout?, artifacts?, exitCode?}`.
- `Assumption` = `{ name, impact, source, needsUserInput, chosen, alternatives[], verification? }` where `verification` is optional grounding (`{status:'verified'|'unverified', evidenceIds[]}`).
- `InputRequest` = `{ questions: Array<{ id, prompt, context, choices[], default, allowCustom }> }`; `InputResponse` = `{ answers: Record<id, string> }`.
- `AnalysisPlanStep` = `{ id, title, status:'pending'|'running'|'done'|'failed', figures[] }`.
- `WorkbookReport` = `{ summaryBullets[], figures: Array<{path, caption}>, detailedAnswer, methods, assumptionsMade[], references[] }`.
- `Workbook` = the whole session artifact (steps + assumptions + plan + report + provenance), shareable read-only by id (like Science Machine's workbook URL).

## 5. Architecture

Build on the analysis toolbox. The distinction from the toolbox: the toolbox runs REVIEWED TEMPLATES (Phase 1) for locked grounding; the workbook runs MODEL-AUTHORED code (Phase 2) over arbitrary uploaded data.

### 5.1 Phase-2 sandboxed codegen (the new capability)
- Reuse the hardened Docker executor (Slice 3): `--network none`, read-only rootfs, cap-drop, non-root, resource caps, allowlisted mounts. The uploaded dataset is mounted read-only; the model-written cell is the code.
- Trust mechanism (Phase 2 requires more than reproducible re-run, per the toolbox spec): (a) the sandbox isolation itself; (b) full transparency - every code cell + output + figure is inspectable (the Science Machine "Files tab" idea = the workbook is the audit trail); (c) a persisted notebook (cells + outputs) as the reproducible record; (d) figures carry quantitative captions derived from the same code that made them. This is honest grounding: "this number/figure came from this code over this data," not "reproducibly re-derived from a locked template."
- Package availability: a curated scientific image (extend the Slice-0 image with domain libs per data type - flow: FlowKit/FlowCytometryTools; omics: scanpy/pydeseq2; etc.). Digest-pinned, no runtime pip.

### 5.2 The agentic loop (packages/core)
A `runWorkbook` orchestrator mirroring `runDeepResearch` but for data analysis: explore -> infer assumptions -> emit InputRequest (gate) -> plan -> for each step {codegen -> sandbox exec -> attach figures} -> assemble report. Emits `TraceEvent`s (working steps) over the existing SSE bus so LUMINA/CLI render live.

### 5.3 Grounding + verification (Sonny's edge over Science Machine)
- Assumptions that are checkable get verified against the data or literature (evidence ids), labeled `verified` not just `inferred`.
- Report claims with numbers bind to the code cell + output that produced them (reuse Slice-2 computation evidence where applicable).
- Literature-referenced interpretation reuses Sonny's existing grounding/retrieval.

## 6. Scope: two tracks

### Track A - Interview taste (buildable now, low risk, ~1-2 slices)
The scientist-loop PRESENTATION over the EXISTING reviewed TROP2 template (Slices 1-4) - NOT arbitrary codegen:
- Render the flow: working steps (already have the glass-box), an Assumptions block (the template's locked thresholds/tissue-sets ARE the assumptions - surface them with impact + alternatives), a preregistered plan (the template's fixed steps), execution (the existing sandbox run), and a structured report (the existing analysis section + captioned figure).
- Zero new codegen risk; reuses done infrastructure; demo-able before July 23. Shows the Science Machine methodology with Sonny's grounding underneath.

### Track B - Full workbook skill (post-interview flagship)
Phase-2 model-authored codegen over arbitrary uploaded data (flow, RNA-seq, etc.), the full human-in-the-loop loop, domain images, exportable reports. This is the differentiated product. Spec it fully, adversarially review it, build after the interview.

## 7. Slices (Track B; Track A is a thin subset)

Slice 0 - workbook data model + report schema (packages/shared) + tests.
Slice 1 - Phase-2 sandboxed codegen: generalize the Slice-3 executor to run a model-authored cell over an uploaded dataset; persist the notebook (cells+outputs); domain image with curated libs. Docker integration test.
Slice 2 - assumption inference + verification: infer assumptions from the data, mark verifiable ones verified with evidence; the InputRequest gate + default-accept.
Slice 3 - the plan+execute loop: preregister plan, execute steps, attach figures, resilient failures.
Slice 4 - report assembly: summary bullets, captioned figures, Methods/Assumptions/Detailed sections, literature-referenced interpretation; export.
Slice 5 - surfaces: `sonny workbook <data> "<question>"` CLI + LUMINA workbook view (working-steps trace, assumptions block, plan, report) + read-only share.

## 8. Risks

- Phase-2 arbitrary codegen is the core new risk: mitigated by the already-proven hardened sandbox (network-off, capped) + transparency. Do NOT relax the sandbox.
- Scope vs interview timeline: Track B is a multi-week build; attempting it before July 23 risks the finished analysis-toolbox demo. Track A is the interview-safe path.
- Domain breadth: one data type first (flow cytometry, to match the reference), not all of omics at once.
- Honesty of grounding: be explicit that Phase-2 grounding is "computed by inspectable sandboxed code," a different guarantee than Phase-1 locked-template reproducibility. Do not overclaim.

## 9. The pitch (why this wins)

Science Machine declares assumptions and exposes code. Sonny does the scientist loop AND grounds it: assumptions verified where checkable, every figure from sandboxed reproducible code, interpretation cited to literature. Same legible scientist flow, stronger epistemics underneath.
