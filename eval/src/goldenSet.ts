import { z } from "zod";

/**
 * Golden-set schema for Sonny's output-quality evals.
 *
 * A golden target is a fixed, curated benchmark case: a target symbol plus the
 * ground truth a correct dossier should satisfy. The runner executes `deep
 * <target>` against each of these and scores the Briefing + trace against it.
 *
 * Design notes:
 * - Verdict labels are a BAND, not a point. Sonny is nondeterministic and the
 *   real world is contested, so we grade `verdict in allowedVerdicts`, not
 *   strict equality. `label` is the primary expected verdict for reporting.
 * - Trap targets carry `trap`. The correct behavior on a trap is abstention
 *   (`insufficient-evidence`). This is only measurable once Slice 2 (the
 *   abstention verdict) lands; until then traps are expected to fail loudly,
 *   which is itself the signal that abstention is missing.
 * - Every ground-truth list mirrors something Sonny already emits (seminal
 *   PMIDs -> evidence store; expectedKols -> KOLCluster; knownDevelopability
 *   -> DevelopabilityRisk), so metrics are a comparison, not new machinery.
 */

// Mirror @mrsirquanzo/sonny-shared. Kept local so the eval package has no runtime coupling
// to core internals beyond the public Briefing shape.
export const VerdictLabel = z.enum([
  "go",
  "watch",
  "no-go",
  "insufficient-evidence",
]);
export type VerdictLabel = z.infer<typeof VerdictLabel>;

export const DevelopabilityCategory = z.enum([
  "immunogenicity",
  "half_life",
  "dosing",
  "off_target_toxicity",
  "fc_engineering",
  "manufacturability",
]);

export const DevelopabilitySeverity = z.enum([
  "manageable",
  "significant",
  "severe",
]);

/**
 * An atomic factual probe. The runner extracts Sonny's claims that match this
 * statement (by embedding/judge similarity) and checks that Sonny's verdict on
 * it agrees with `expected`. `refuted` means the literature contradicts the
 * statement and a grounded agent should not assert it; `unsupported` means
 * there is no evidence either way and a grounded agent should stay silent.
 */
export const ClaimProbe = z.object({
  statement: z.string().min(1),
  expected: z.enum(["supported", "refuted", "unsupported"]),
  /** Optional PMIDs the judge may use as the reference passage. */
  citationsHint: z.array(z.string()).optional(),
  note: z.string().optional(),
});
export type ClaimProbe = z.infer<typeof ClaimProbe>;

export const ExpectedKol = z.object({
  /** Last-author surname + initials, e.g. "Hooper JD". */
  investigator: z.string().min(1),
  institution: z.string().optional(),
  /** If true, absence from Sonny's top-3 is a miss. Default true. */
  mustAppear: z.boolean().default(true),
});
export type ExpectedKol = z.infer<typeof ExpectedKol>;

export const KnownDevelopabilityRisk = z.object({
  category: DevelopabilityCategory,
  /** The weakest severity that still counts as "caught". */
  minSeverity: DevelopabilitySeverity,
  note: z.string().optional(),
});
export type KnownDevelopabilityRisk = z.infer<typeof KnownDevelopabilityRisk>;

export const TrapSpec = z.object({
  kind: z.enum(["fictional", "evidence-poor"]),
  /** Human note on why this target should trigger abstention. */
  reason: z.string().min(1),
});

export const GoldenTarget = z
  .object({
    /** Gene / target symbol passed to `deep <target>`. */
    target: z.string().min(1),
    ensemblId: z.string().optional(),

    /** Primary expected verdict, used for headline reporting. */
    label: VerdictLabel,
    /** The acceptable band. Must include `label`. */
    allowedVerdicts: z.array(VerdictLabel).min(1),
    /** Why this label. Curation rationale, not shipped to Sonny. */
    rationale: z.string().min(1),

    /** Present iff this is a trap target (abstention expected). */
    trap: TrapSpec.optional(),

    /** Papers a correct run MUST pull into the evidence store. */
    seminalPmids: z.array(z.string()).default([]),
    /** Labs a correct KOL map SHOULD surface. */
    expectedKols: z.array(ExpectedKol).default([]),
    /** Liabilities the developability assessor SHOULD flag. */
    knownDevelopabilityRisks: z.array(KnownDevelopabilityRisk).default([]),
    /** Atomic faithfulness probes. */
    claimProbes: z.array(ClaimProbe).default([]),

    curator: z.string().min(1),
    curatedAt: z.string(), // ISO date
  })
  .superRefine((t, ctx) => {
    if (!t.allowedVerdicts.includes(t.label)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "allowedVerdicts must include label",
        path: ["allowedVerdicts"],
      });
    }
    if (t.trap && !t.allowedVerdicts.includes("insufficient-evidence")) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "trap targets must allow 'insufficient-evidence'",
        path: ["allowedVerdicts"],
      });
    }
  });
export type GoldenTarget = z.infer<typeof GoldenTarget>;

export const GoldenSet = z.array(GoldenTarget);
export type GoldenSet = z.infer<typeof GoldenSet>;

/** Which slice of the golden set to run. `fast` is the cheap PR subset. */
export const EvalSubset = z.enum(["fast", "full"]);
export type EvalSubset = z.infer<typeof EvalSubset>;

/** Optional tag file to mark which targets are in the `fast` subset. */
export const SubsetConfig = z.object({
  fast: z.array(z.string()).min(1), // target symbols
});
export type SubsetConfig = z.infer<typeof SubsetConfig>;
