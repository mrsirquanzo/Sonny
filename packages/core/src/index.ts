export { EvidenceStore } from './evidenceStore.js';
export { MODEL_ROUTER, AnthropicModel, makeModel, currentBackend, routerFor, modelFamily, resolveVerifier, pinVerifierModel, type ResolvedVerifier, type StructuredModel, type Backend, type UsageRecorder } from './model.js';
export { OllamaModel } from './ollamaModel.js';
export { groundClaims } from './grounding.js';
export { verifyClaims } from './verifier.js';
export { computeRag, createSourceIdentityResolver, type SourceIdentityResolver } from './rag.js';
export {
  reproducibilityGate,
  type ReproducibilityGateInput,
  type ReproducibilityGateResult,
  type ReproducibilityDrop,
} from './reproducibilityGate.js';
export { SPECIALISTS, type Specialist } from './specialists.js';
export { planResearchQuestions, extractClaims, reflectOnGaps, runResearcher,
  type ThreadBrief, type ThreadFindings, type ResearchBudget, type ResearchContext } from './researcher.js';
export { produceResearchSection } from './produceResearchSection.js';
export { RESEARCH_ROSTER } from './researchRoster.js';
export { composeRoster, inferModality, isAntibodyModality, CANONICAL_CATEGORIES } from './planner.js';
export { seedStructuredEvidence } from './leadSeed.js';
export { parseResearchQuery, resolveQueryScope, looksLikeFreeText, type ParsedResearchQuery } from './parseQuery.js';
export { createUsageMeter, type UsageMeter } from './usageMeter.js';
export { PRICE_PER_MTOK, costFor } from './pricing.js';
export { runDeepResearch, type DeepResearchResult } from './runDeepResearch.js';
export { deriveStructuredClaims, mergeStructuredClaims } from './structuredClaims.js';
export { assessCompleteness, fillGap, mergeGapClaims, type ResearchGap } from './completeness.js';
export { weighAcrossThreads } from './weighing.js';
export { synthesizeRecommendation } from './synthesize.js';
export { assembleReferences, produceBriefing } from './briefing.js';
export {
  ANALYSIS_SPECIALIST,
  TROP2_DATASET_IDS,
  TROP2_RESULT_KEYS,
  attachAnalysisToDeepResearch,
  mapTrop2ResultsToClaims,
  runAnalysisSpecialist,
  selectAnalysisPlan,
  type AnalysisExecutor,
  type AnalysisPlan,
  type AnalysisQuestion,
  type AnalysisSection,
  type AnalysisSpecialistResult,
  type VerifiedAnalysisRun,
  type RunAnalysisSpecialistInput,
} from './analysisSpecialist.js';
export {
  CachedAnalysisBundleError,
  createSignedCachedAnalysisBundle,
  loadSignedCachedAnalysisBundle,
  type CreateSignedCachedAnalysisBundleInput,
  type LoadSignedCachedAnalysisBundleInput,
} from './cachedAnalysis.js';
export { ANALYSIS_RELEASE_PUBLIC_KEY_PEM } from './releasePublicKey.js';
export { safeToolCall, isTransient } from './safeToolCall.js';
export { targetTerms, relevanceGate } from './relevance.js';
export {
  rewriteResearchQuery,
  clearQueryRewriteCache,
  type RewriteQueryOptions,
  type ResearchQueryVariant,
} from './queryRewrite.js';
export { OllamaEmbeddings, cosineSimilarity, type OllamaEmbeddingOptions } from './embeddings.js';
export {
  hybridRetrievalEnabled,
  reciprocalRankFusion,
  retrieveResearchHits,
  type RankedList,
  type RetrieveResearchHitsOptions,
} from './hybridRetrieval.js';
export { extractPatentData, extractAssociations, type ExtractedPatent, type RegionAssociation, type ExtractionCompleteness } from './patentData.js';
export { extractPatentSequences, type ExtractPatentDeps } from './extractPatentSequences.js';
export { reconcilePatent, type PatentReconciliation, type VerifiedSequence, type BlastHit, type ReconcileDeps } from './patentReconcile.js';
export {
  groupConstructs, buildWorkup, synthesizeCompetitiveIP, graphRelationships,
  matchCdrCompetitors,
  type AntibodyConstruct, type ConstructMember, type WorkedConstruct, type WorkedRegion,
  type SpeciesCall, type SpeciesClass, type CdrConfirmation, type CompetitiveIP, type IpPoint,
  type Relationship, type EdgePredicate, type PatentWorkup,
  type ClaimVerdict, type CdrBlast,
} from './patentWorkup.js';
export { makeDecorrelatedVerifier, verifyNarrative, type Verifier } from './narrativeVerify.js';
export { runPatentWorkup, type WorkupDeps } from './runPatentWorkup.js';
