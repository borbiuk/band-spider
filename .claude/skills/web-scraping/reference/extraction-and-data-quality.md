# Extraction and data quality

Use this file when you write selectors or parsers, validate records, handle missing fields or paginated lists, dedup records, write exports, or when output looks wrong or incomplete.

Highest impact first: validate data (R086), null for missing (R087), silent breakage detection (R088), completeness (R090, R091).

## Validate data, not status (R086)

A 200 can carry garbage, so check every record before you save it:
- Required fields are present.
- Types are right (number is a number, date parses).
- Values are in plausible ranges.
- Duplicates are flagged.

Page-level content checks (block pages, empty bodies, soft 404) live in [error-classification.md](error-classification.md).

Done when: every saved record passed a validator, and a record that fails is saved with its issues listed, not dropped silently.

## Missing data rule (R087, R089)

Write a missing value as explicit null plus a recorded error or validation issue. Never write a plausible default or a guess (currency, locale, zero price, empty string for unknown), because a plausible wrong value is silent corruption that nobody finds later.

Store the issues inside each record (R089), for example a list of field plus issue key. Track the share of records with issues per run, because a sudden jump is the first sign of a structure change.

Done when: no field holds a made-up value, and each null has an issue entry explaining it.

## Quality signals for silent breakage (R088)

Broken selectors keep returning 200 and empty fields, so watch the output:
- Fill rate per field, per run and per page type.
- Items per page against the expected count.
- Share of records with issues.

Alert on a drop against the recent baseline. Alert routing and failure-rate shapes are in [observability.md](observability.md). Re-validate old assumptions on every run, because sites change.

Done when: you can name the fill-rate numbers for the last run, and a selector that goes dead trips an alert in one run.

## Completeness and pagination (R090, R091, R097)

### Totals (R090)

Check the count you read against the total the source reports (result count, page count, API total). When the read is far below it, fail loudly, because redesigns move data behind new calls and lists get truncated. Start with a loose tolerance, then tighten from observed gaps.

### Pagination (R091)

End a list read when any of these holds: the cursor stops moving, no new records arrive, or "more" is false. Verify the page size the server honors, because a silently capped page size makes page-number math wrong. Set a hard page cap as a safety net. When the cap triggers, mark the read incomplete and never save it as complete.

### Scrolled lists (R097)

A stable item count in a scrolled list is not proof of completeness, because virtualized lists keep the DOM size constant. Prefer the underlying data call. Otherwise use a bounded loop with a no-new-items stop, and check against the reported total. Access-path choice is in [recon-and-access-path.md](recon-and-access-path.md).

Done when: every list read ends with a recorded reason (total reached, cursor ended, cap hit) and the cap case is flagged incomplete.

## Selector stability and testing (R092, R093)

Prefer, in this order:
1. Test IDs and stable IDs.
2. Accessibility and itemprop attributes.
3. Semantic structure (headings, lists, labelled sections).

Avoid generated class names, deep paths and positions, because hashed classes and layouts change on every deploy.

A field counts as found only with a tested extraction path (R093). Test it on several pages and page types, and check count and value against what a person sees. Text that appears in the HTML is not an extraction path, because it may sit in a script blob, a template or a hidden element.

Done when: each field has a selector from the list above and a recorded test on several pages.

## Field-level errors (R094, R095)

Guard every lookup and handle errors per field, so one missing element never loses the rest of the page. Page-level error handling throws away good data.

Decide by the goal what a field failure does (R095):
- A field that is the whole point aborts the record, or the run when the failure is systemic.
- An optional field becomes null plus an issue, and the record continues.

Log field errors either way, with field name and issue key. A missing optional element is not a scrape failure for the URL (see [error-classification.md](error-classification.md)).

Done when: each field is marked required or optional, and a missing optional element yields a saved record with a logged issue.

## Rendering traps (R096)

Server-rendered values can be placeholders until scripts run. Compare the server-rendered value with the hydrated value, because a raw-HTML check passes on a placeholder. If they differ, take the value from the data source the page uses (embedded JSON or the internal endpoint), not from the placeholder.

Done when: for each field, you know whether the raw value equals the hydrated one.

## Normalization and dedup (R098, R099)

Normalize, but keep the raw value next to the normalized one, because early normalization loses information.
- Dates to ISO-8601.
- URLs to absolute.
- Text to UTF-8.

Dedup exact copies. Keep conflicting near-duplicates, unless a verified identity rule merges them, because a silent merge discards conflicting data. Report how many records you removed and how many conflicts you kept.

Done when: every normalized field has its raw twin, and the run report lists dedup counts.

## Model-based extraction (R100)

Use a language model to extract only after deterministic paths fail. Require a strict output schema, null for missing values, and a count check against the page or source, because model extractors truncate lists and invent values. Treat the output as data to validate like any other record.

Done when: the model path is used only for fields with no deterministic path, and every output passes the schema and count check.

## Safe exports and honest coverage (R101, R102)

### Exports (R101)

Scraped text can execute or break files, so:
- Neutralize spreadsheet formulas in cells that start with `=`, `+`, `-` or `@` (prefix them so they read as text).
- Escape markup in HTML or XML output.
- Keep machine formats valid (escaping in CSV, valid JSON, real encoding).
- Put metadata (run time, counts, coverage) in a sidecar file or an envelope, not mixed into data rows.

### Coverage (R102)

Report coverage honestly. A confidence label measures capture coverage, not truth. List the fields, pages or filters you did not cover. Never claim "complete" without a checked total (see Completeness above). The full run report is in [observability.md](observability.md).

Done when: the export opens in a spreadsheet with no formula running, and the report names what was not covered.
