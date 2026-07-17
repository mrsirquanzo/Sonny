#!/bin/sh

# Acquire and normalize the three frozen TACSTD2 inputs used by the reviewed
# Slice-1 template. This script requires network access and is intentionally not
# invoked by tests or by the sandboxed analysis template.

set -eu

SCRIPT_DIR=$(CDPATH= cd "$(dirname "$0")" && pwd)
MANIFEST=$SCRIPT_DIR/datasets.json
FROZEN_DIR=$SCRIPT_DIR/frozen
RAW_ROOT=$SCRIPT_DIR/raw
GTEX_URL='https://gtexportal.org/api/v2/expression/medianGeneExpression?gencodeId=ENSG00000184292.7&datasetId=gtex_v8'
CBIO_BASE_URL=${CBIO_BASE_URL:-https://www.cbioportal.org/api}
CBIO_STUDY_ID=brca_tcga_pan_can_atlas_2018
CBIO_PROFILE_ID=brca_tcga_pan_can_atlas_2018_rna_seq_v2_mrna
CBIO_SAMPLE_LIST_ID=brca_tcga_pan_can_atlas_2018_all

# TODO(claude): Validate the exact release and the two release-matched URLs.
# DepMap's canonical landing page is https://depmap.org/portal/download/all/.
# Known release files have historically been published below
# https://depmap-public.s3.amazonaws.com/Portal/<release>/, but a full
# CRISPRGeneEffect.csv must NOT be downloaded by this script. Supply URLs for a
# TACSTD2-only CSV export and the small release-matched Model metadata slice.
: "${DEPMAP_RELEASE:?TODO(claude): set DEPMAP_RELEASE to the validated frozen DepMap Public release}"
: "${DEPMAP_TACSTD2_SLICE_URL:?TODO(claude): set a validated URL returning only ModelID plus TACSTD2 (4070) gene effect}"
: "${DEPMAP_MODEL_METADATA_SLICE_URL:?TODO(claude): set a same-release URL returning ModelID, CellLineName, OncotreeLineage, and OncotreePrimaryDisease}"
: "${PREPROCESSING_IMAGE_DIGEST:?TODO(claude): set the pinned preprocessing image digest in name@sha256:<64 hex> form}"

IMAGE_DIGEST_HEX=${PREPROCESSING_IMAGE_DIGEST##*@sha256:}
case "$PREPROCESSING_IMAGE_DIGEST:$IMAGE_DIGEST_HEX" in
    *@sha256:*:*[!0-9a-f]*)
        printf '%s\n' 'PREPROCESSING_IMAGE_DIGEST must be name@sha256:<64 lowercase hex>; mutable tags are rejected' >&2
        exit 2
        ;;
esac
if [ "${#IMAGE_DIGEST_HEX}" -ne 64 ] || [ "$IMAGE_DIGEST_HEX" = "$PREPROCESSING_IMAGE_DIGEST" ]; then
    printf '%s\n' 'PREPROCESSING_IMAGE_DIGEST must be name@sha256:<64 lowercase hex>; mutable tags are rejected' >&2
    exit 2
fi

for tool in curl node; do
    if ! command -v "$tool" >/dev/null 2>&1; then
        printf 'required tool is unavailable: %s\n' "$tool" >&2
        exit 2
    fi
done

sha256_file() {
    if command -v sha256sum >/dev/null 2>&1; then
        sha256sum "$1" | awk '{print $1}'
    elif command -v shasum >/dev/null 2>&1; then
        shasum -a 256 "$1" | awk '{print $1}'
    else
        printf '%s\n' 'sha256sum or shasum is required' >&2
        return 2
    fi
}

fetch_get() {
    url=$1
    destination=$2
    curl --fail --silent --show-error --location --retry 3 \
        --header 'Accept: application/json, text/csv;q=0.9' \
        --output "$destination" \
        "$url"
}

RETRIEVED_AT=$(date -u '+%Y-%m-%dT%H:%M:%SZ')
SNAPSHOT_ID=$(date -u '+%Y%m%dT%H%M%SZ')
mkdir -p "$FROZEN_DIR" "$RAW_ROOT"
TEMP_DIR=$(mktemp -d "$SCRIPT_DIR/.fetch-trop2.XXXXXX")
RAW_DIR=$RAW_ROOT/$SNAPSHOT_ID

cleanup() {
    rm -rf "$TEMP_DIR"
}
trap cleanup 0 HUP INT TERM

printf '%s\n' 'Fetching release-matched DepMap TACSTD2 slices...'
fetch_get "$DEPMAP_TACSTD2_SLICE_URL" "$TEMP_DIR/depmap-gene-effect.raw.csv"
fetch_get "$DEPMAP_MODEL_METADATA_SLICE_URL" "$TEMP_DIR/depmap-model-metadata.raw.csv"

printf '%s\n' 'Fetching GTEx V8 median TPM for TACSTD2...'
fetch_get "$GTEX_URL" "$TEMP_DIR/gtex-median-gene-expression.raw.json"

printf '%s\n' 'Fetching cBioPortal sample list and sample-type metadata...'
fetch_get \
    "$CBIO_BASE_URL/sample-lists/$CBIO_SAMPLE_LIST_ID" \
    "$TEMP_DIR/cbioportal-sample-list.raw.json"
fetch_get \
    "$CBIO_BASE_URL/studies/$CBIO_STUDY_ID/clinical-data?clinicalDataType=SAMPLE&projection=DETAILED&pageSize=10000000&pageNumber=0" \
    "$TEMP_DIR/cbioportal-sample-clinical.raw.json"

node --input-type=module - \
    "$TEMP_DIR/cbioportal-sample-list.raw.json" \
    "$TEMP_DIR/cbioportal-molecular-filter.json" <<'NODE'
import { readFileSync, writeFileSync } from 'node:fs';

const [sampleListPath, outputPath] = process.argv.slice(2);
const response = JSON.parse(readFileSync(sampleListPath, 'utf8'));
const sampleIds = response.sampleIds ?? response.data?.sampleIds;
if (!Array.isArray(sampleIds) || sampleIds.length === 0) {
  throw new Error('cBioPortal sample-list response contains no sampleIds');
}
writeFileSync(
  outputPath,
  `${JSON.stringify({ entrezGeneIds: [4070], sampleIds })}\n`,
  'utf8',
);
NODE

printf '%s\n' 'Fetching cBioPortal TACSTD2 molecular data...'
curl --fail --silent --show-error --location --retry 3 \
    --request POST \
    --header 'Accept: application/json' \
    --header 'Content-Type: application/json' \
    --data-binary "@$TEMP_DIR/cbioportal-molecular-filter.json" \
    --output "$TEMP_DIR/cbioportal-molecular-data.raw.json" \
    "$CBIO_BASE_URL/molecular-profiles/$CBIO_PROFILE_ID/molecular-data/fetch"

printf '%s\n' 'Normalizing frozen CSV contracts...'
node --input-type=module - \
    "$TEMP_DIR/depmap-gene-effect.raw.csv" \
    "$TEMP_DIR/depmap-model-metadata.raw.csv" \
    "$TEMP_DIR/gtex-median-gene-expression.raw.json" \
    "$TEMP_DIR/cbioportal-sample-list.raw.json" \
    "$TEMP_DIR/cbioportal-sample-clinical.raw.json" \
    "$TEMP_DIR/cbioportal-molecular-data.raw.json" \
    "$TEMP_DIR/depmap_crispr_gene_effect_tacstd2.csv" \
    "$TEMP_DIR/gtex_median_tpm_tacstd2.csv" \
    "$TEMP_DIR/cbioportal_tumor_expression_tacstd2.csv" <<'NODE'
import { readFileSync, writeFileSync } from 'node:fs';

const [
  depmapGenePath,
  depmapModelPath,
  gtexPath,
  cbioSampleListPath,
  cbioClinicalPath,
  cbioMolecularPath,
  depmapOutputPath,
  gtexOutputPath,
  cbioOutputPath,
] = process.argv.slice(2);

function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    if (quoted) {
      if (character === '"' && text[index + 1] === '"') {
        field += '"';
        index += 1;
      } else if (character === '"') {
        quoted = false;
      } else {
        field += character;
      }
    } else if (character === '"') {
      quoted = true;
    } else if (character === ',') {
      row.push(field);
      field = '';
    } else if (character === '\n') {
      row.push(field.replace(/\r$/, ''));
      rows.push(row);
      row = [];
      field = '';
    } else {
      field += character;
    }
  }
  if (quoted) throw new Error('unterminated quoted CSV field');
  if (field !== '' || row.length > 0) {
    row.push(field.replace(/\r$/, ''));
    rows.push(row);
  }
  if (rows.length < 2) throw new Error('CSV contains no data rows');
  const headers = rows[0];
  if (new Set(headers).size !== headers.length) throw new Error('CSV has duplicate headers');
  return rows.slice(1).filter((values) => values.some((value) => value !== '')).map((values) => {
    if (values.length !== headers.length) throw new Error('CSV row width differs from header');
    return Object.fromEntries(headers.map((header, index) => [header, values[index]]));
  });
}

function csvCell(value) {
  const stringValue = value === null || value === undefined ? '' : String(value);
  return /[",\r\n]/.test(stringValue) ? `"${stringValue.replaceAll('"', '""')}"` : stringValue;
}

function writeCsv(path, headers, rows) {
  const lines = [headers.map(csvCell).join(',')];
  for (const row of rows) lines.push(headers.map((header) => csvCell(row[header])).join(','));
  writeFileSync(path, `${lines.join('\n')}\n`, 'utf8');
}

function firstValue(record, aliases) {
  for (const alias of aliases) {
    if (record[alias] !== undefined) return record[alias];
  }
  return undefined;
}

function assertUnique(rows, key, label) {
  const seen = new Set();
  for (const row of rows) {
    const value = String(row[key] ?? '').trim();
    if (!value) throw new Error(`${label} has a missing ${key}`);
    if (seen.has(value)) throw new Error(`${label} has duplicate ${key}: ${value}`);
    seen.add(value);
  }
}

const depmapGeneRows = parseCsv(readFileSync(depmapGenePath, 'utf8'));
const depmapModelRows = parseCsv(readFileSync(depmapModelPath, 'utf8'));
const geneByModel = new Map();
for (const row of depmapGeneRows) {
  const modelId = firstValue(row, ['ModelID', 'model_id', 'DepMap_ID']);
  const value = firstValue(row, ['TACSTD2 (4070)', 'TACSTD2', 'gene_effect']);
  if (modelId === undefined || value === undefined) {
    throw new Error('DepMap TACSTD2 slice must contain ModelID and TACSTD2 (4070)');
  }
  if (geneByModel.has(modelId)) throw new Error(`duplicate DepMap gene-effect ModelID: ${modelId}`);
  geneByModel.set(modelId, value);
}
const normalizedDepmap = depmapModelRows.map((row) => {
  const modelId = firstValue(row, ['ModelID', 'model_id', 'DepMap_ID']);
  if (modelId === undefined) throw new Error('DepMap model metadata has no ModelID column');
  return {
    model_id: modelId,
    cell_line_name: firstValue(row, ['CellLineName', 'cell_line_name']) ?? '',
    lineage: firstValue(row, ['OncotreeLineage', 'lineage']) ?? 'Unknown',
    primary_disease: firstValue(row, ['OncotreePrimaryDisease', 'primary_disease']) ?? '',
    gene_effect: geneByModel.get(modelId) ?? '',
  };
}).sort((left, right) => left.model_id.localeCompare(right.model_id));
assertUnique(normalizedDepmap, 'model_id', 'normalized DepMap');
writeCsv(
  depmapOutputPath,
  ['model_id', 'cell_line_name', 'lineage', 'primary_disease', 'gene_effect'],
  normalizedDepmap,
);

const gtexResponse = JSON.parse(readFileSync(gtexPath, 'utf8'));
const gtexData = Array.isArray(gtexResponse) ? gtexResponse : gtexResponse.data;
if (!Array.isArray(gtexData) || gtexData.length === 0) {
  throw new Error('GTEx medianGeneExpression response contains no data');
}
const normalizedGtex = gtexData.map((row) => {
  const tissueId = firstValue(row, ['tissueSiteDetailId', 'tissue_id']);
  const tissueName = firstValue(row, ['tissueSiteDetail', 'tissueSiteDetailId', 'tissue_name']);
  const medianTpm = firstValue(row, ['median', 'medianTpm', 'median_tpm']);
  if (tissueId === undefined || medianTpm === undefined) {
    throw new Error('unexpected GTEx response fields; expected tissueSiteDetailId and median');
  }
  return { tissue_id: tissueId, tissue_name: tissueName ?? tissueId, median_tpm: medianTpm };
}).sort((left, right) => String(left.tissue_id).localeCompare(String(right.tissue_id)));
assertUnique(normalizedGtex, 'tissue_id', 'normalized GTEx');
writeCsv(gtexOutputPath, ['tissue_id', 'tissue_name', 'median_tpm'], normalizedGtex);

const sampleListResponse = JSON.parse(readFileSync(cbioSampleListPath, 'utf8'));
const sampleIds = sampleListResponse.sampleIds ?? sampleListResponse.data?.sampleIds;
if (!Array.isArray(sampleIds) || sampleIds.length === 0) {
  throw new Error('cBioPortal sample list contains no sampleIds');
}
const clinicalResponse = JSON.parse(readFileSync(cbioClinicalPath, 'utf8'));
const clinicalData = Array.isArray(clinicalResponse) ? clinicalResponse : clinicalResponse.data;
if (!Array.isArray(clinicalData)) throw new Error('unexpected cBioPortal clinical-data response');
const sampleTypeById = new Map();
for (const row of clinicalData) {
  const attribute = row.clinicalAttributeId ?? row.attributeId;
  if (attribute === 'SAMPLE_TYPE') sampleTypeById.set(row.sampleId, row.value ?? '');
}
const molecularResponse = JSON.parse(readFileSync(cbioMolecularPath, 'utf8'));
const molecularData = Array.isArray(molecularResponse) ? molecularResponse : molecularResponse.data;
if (!Array.isArray(molecularData)) throw new Error('unexpected cBioPortal molecular-data response');
const expressionBySample = new Map();
for (const row of molecularData) {
  if (Number(row.entrezGeneId) !== 4070) continue;
  if (expressionBySample.has(row.sampleId)) {
    throw new Error(`duplicate cBioPortal TACSTD2 sampleId: ${row.sampleId}`);
  }
  expressionBySample.set(row.sampleId, row.value ?? '');
}
const tumorTypes = new Set(['Primary Solid Tumor', 'Recurrent Solid Tumor', 'Metastatic']);
const normalTypes = new Set(['Solid Tissue Normal']);
const normalizedCbio = sampleIds.map((sampleId) => {
  const sampleType = sampleTypeById.get(sampleId) ?? '';
  const sampleClass = tumorTypes.has(sampleType)
    ? 'tumor'
    : normalTypes.has(sampleType)
      ? 'normal'
      : 'unknown';
  return {
    study_id: 'brca_tcga_pan_can_atlas_2018',
    molecular_profile_id: 'brca_tcga_pan_can_atlas_2018_rna_seq_v2_mrna',
    sample_id: sampleId,
    sample_type: sampleType,
    sample_class: sampleClass,
    expression_value: expressionBySample.get(sampleId) ?? '',
  };
}).sort((left, right) => left.sample_id.localeCompare(right.sample_id));
assertUnique(normalizedCbio, 'sample_id', 'normalized cBioPortal');
writeCsv(
  cbioOutputPath,
  ['study_id', 'molecular_profile_id', 'sample_id', 'sample_type', 'sample_class', 'expression_value'],
  normalizedCbio,
);
NODE

mkdir "$RAW_DIR"
cp "$TEMP_DIR/depmap-gene-effect.raw.csv" "$RAW_DIR/"
cp "$TEMP_DIR/depmap-model-metadata.raw.csv" "$RAW_DIR/"
cp "$TEMP_DIR/gtex-median-gene-expression.raw.json" "$RAW_DIR/"
cp "$TEMP_DIR/cbioportal-sample-list.raw.json" "$RAW_DIR/"
cp "$TEMP_DIR/cbioportal-sample-clinical.raw.json" "$RAW_DIR/"
cp "$TEMP_DIR/cbioportal-molecular-data.raw.json" "$RAW_DIR/"

mv "$TEMP_DIR/depmap_crispr_gene_effect_tacstd2.csv" "$FROZEN_DIR/"
mv "$TEMP_DIR/gtex_median_tpm_tacstd2.csv" "$FROZEN_DIR/"
mv "$TEMP_DIR/cbioportal_tumor_expression_tacstd2.csv" "$FROZEN_DIR/"

DEPMAP_GENE_RAW_SHA=$(sha256_file "$RAW_DIR/depmap-gene-effect.raw.csv")
DEPMAP_MODEL_RAW_SHA=$(sha256_file "$RAW_DIR/depmap-model-metadata.raw.csv")
GTEX_RAW_SHA=$(sha256_file "$RAW_DIR/gtex-median-gene-expression.raw.json")
CBIO_SAMPLE_LIST_RAW_SHA=$(sha256_file "$RAW_DIR/cbioportal-sample-list.raw.json")
CBIO_CLINICAL_RAW_SHA=$(sha256_file "$RAW_DIR/cbioportal-sample-clinical.raw.json")
CBIO_MOLECULAR_RAW_SHA=$(sha256_file "$RAW_DIR/cbioportal-molecular-data.raw.json")
DEPMAP_OUTPUT_SHA=$(sha256_file "$FROZEN_DIR/depmap_crispr_gene_effect_tacstd2.csv")
GTEX_OUTPUT_SHA=$(sha256_file "$FROZEN_DIR/gtex_median_tpm_tacstd2.csv")
CBIO_OUTPUT_SHA=$(sha256_file "$FROZEN_DIR/cbioportal_tumor_expression_tacstd2.csv")
PREPROCESSING_CODE_HASH=$(sha256_file "$SCRIPT_DIR/fetch-trop2.sh")

export RETRIEVED_AT RAW_DIR DEPMAP_RELEASE DEPMAP_TACSTD2_SLICE_URL CBIO_BASE_URL
export DEPMAP_MODEL_METADATA_SLICE_URL PREPROCESSING_IMAGE_DIGEST PREPROCESSING_CODE_HASH
export DEPMAP_GENE_RAW_SHA DEPMAP_MODEL_RAW_SHA GTEX_RAW_SHA
export CBIO_SAMPLE_LIST_RAW_SHA CBIO_CLINICAL_RAW_SHA CBIO_MOLECULAR_RAW_SHA
export DEPMAP_OUTPUT_SHA GTEX_OUTPUT_SHA CBIO_OUTPUT_SHA

node --input-type=module - "$MANIFEST" "$RAW_DIR/acquisition-provenance.json" <<'NODE'
import { readFileSync, writeFileSync } from 'node:fs';

const [manifestPath, provenancePath] = process.argv.slice(2);
const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
const byId = new Map(manifest.datasets.map((dataset) => [dataset.id, dataset]));
const depmap = byId.get('depmap.crispr_gene_effect');
const gtex = byId.get('gtex.median_tpm');
const tumor = byId.get('expr.tumor');
if (!depmap || !gtex || !tumor) throw new Error('datasets.json is missing a required Slice-1 dataset');

depmap.sourceIds.release = process.env.DEPMAP_RELEASE;
depmap.acquisitionQuery.resolvedUrls = {
  geneEffect: process.env.DEPMAP_TACSTD2_SLICE_URL,
  modelMetadata: process.env.DEPMAP_MODEL_METADATA_SLICE_URL,
};
depmap.retrievedAt = process.env.RETRIEVED_AT;
depmap.rawSourceHashes = {
  geneEffectSliceSha256: process.env.DEPMAP_GENE_RAW_SHA,
  modelMetadataSliceSha256: process.env.DEPMAP_MODEL_RAW_SHA,
};
depmap.preprocessingCodeHash = process.env.PREPROCESSING_CODE_HASH;
depmap.preprocessingImageDigest = process.env.PREPROCESSING_IMAGE_DIGEST;
depmap.outputSha256 = process.env.DEPMAP_OUTPUT_SHA;

gtex.retrievedAt = process.env.RETRIEVED_AT;
gtex.rawSourceHashes = { apiResponseSha256: process.env.GTEX_RAW_SHA };
gtex.preprocessingCodeHash = process.env.PREPROCESSING_CODE_HASH;
gtex.preprocessingImageDigest = process.env.PREPROCESSING_IMAGE_DIGEST;
gtex.outputSha256 = process.env.GTEX_OUTPUT_SHA;

tumor.retrievedAt = process.env.RETRIEVED_AT;
tumor.rawSourceHashes = {
  sampleListResponseSha256: process.env.CBIO_SAMPLE_LIST_RAW_SHA,
  molecularDataResponseSha256: process.env.CBIO_MOLECULAR_RAW_SHA,
  sampleClinicalResponseSha256: process.env.CBIO_CLINICAL_RAW_SHA,
};
tumor.preprocessingCodeHash = process.env.PREPROCESSING_CODE_HASH;
tumor.preprocessingImageDigest = process.env.PREPROCESSING_IMAGE_DIGEST;
tumor.outputSha256 = process.env.CBIO_OUTPUT_SHA;

writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');

const provenance = {
  retrievedAt: process.env.RETRIEVED_AT,
  preprocessingCodeHash: process.env.PREPROCESSING_CODE_HASH,
  preprocessingImageDigest: process.env.PREPROCESSING_IMAGE_DIGEST,
  sources: {
    depmap: {
      release: process.env.DEPMAP_RELEASE,
      geneEffectUrl: process.env.DEPMAP_TACSTD2_SLICE_URL,
      modelMetadataUrl: process.env.DEPMAP_MODEL_METADATA_SLICE_URL,
      rawSha256: {
        geneEffect: process.env.DEPMAP_GENE_RAW_SHA,
        modelMetadata: process.env.DEPMAP_MODEL_RAW_SHA,
      },
      outputSha256: process.env.DEPMAP_OUTPUT_SHA,
    },
    gtex: {
      method: 'GET',
      url: 'https://gtexportal.org/api/v2/expression/medianGeneExpression?gencodeId=ENSG00000184292.7&datasetId=gtex_v8',
      rawSha256: process.env.GTEX_RAW_SHA,
      outputSha256: process.env.GTEX_OUTPUT_SHA,
    },
    cbioportal: {
      baseUrl: process.env.CBIO_BASE_URL,
      studyId: 'brca_tcga_pan_can_atlas_2018',
      molecularProfileId: 'brca_tcga_pan_can_atlas_2018_rna_seq_v2_mrna',
      sampleListId: 'brca_tcga_pan_can_atlas_2018_all',
      molecularDataFilter: { entrezGeneIds: [4070], sampleIds: '<captured in raw sample-list response>' },
      rawSha256: {
        sampleList: process.env.CBIO_SAMPLE_LIST_RAW_SHA,
        sampleClinical: process.env.CBIO_CLINICAL_RAW_SHA,
        molecularData: process.env.CBIO_MOLECULAR_RAW_SHA,
      },
      outputSha256: process.env.CBIO_OUTPUT_SHA,
    },
  },
};
writeFileSync(provenancePath, `${JSON.stringify(provenance, null, 2)}\n`, 'utf8');
NODE

printf 'Frozen TACSTD2 datasets written under %s\n' "$FROZEN_DIR"
printf 'Raw provenance captured under %s\n' "$RAW_DIR"
printf '%s\n' 'TODO(claude): review every license.redistributionStatus entry before committing or shipping data.'
printf '%s\n' 'TODO(claude): validate cBioPortal profile units and whether normal samples are present; record a null normal result if absent.'
