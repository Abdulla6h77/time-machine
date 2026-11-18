# Time Machine tasks

Criterion and requirement IDs refer to [SPEC.md](SPEC.md). This checklist plans implementation and validation.

## Prerequisites

- [x] Record the official submission requirements, approval criteria, and judging priorities.
- [x] Confirm Monitor and Browser access and verify live registration responses. Check remaining wallet balance and account limits before extending collection.
- [x] Keep setup, configuration, dependencies, and verification project-local.

## Implementation and approval checks

- [x] **A1** Register 20 live Page Monitors and confirm each through the authenticated Monitor API. Persist initial runs and capture initial views. The worker depends on Monitor results for every capture decision.
- [x] **A2** Return added, removed, and changed content for any two captured date selections. Test unchanged versions, meaningful edits, and cosmetic noise such as ads or tracking codes.
- [x] **A3** Support registering an eligible page dynamically. Test a newly added URL and its timeline without a code change.
- [ ] **A4** Persist a screenshot and source link per detected version. Run live for at least three days and inspect logs for real changes and matching screenshots. Test duplicate events, capture failures, and out-of-order arrivals separately.
- [x] **A5** Expose a reusable API or JSON export. Test as-of lookup before the first capture, between versions, and on a version boundary, plus valid chronological timeline and diff output.

## Live evidence remaining

- [ ] Complete the 72-hour live window and verify meaningful observed changes with their screenshots and logs.
- [ ] For hosted operation, connect an HTTPS webhook and verify an authentic scheduled delivery.

## Demo and submission

- [ ] Monitor at least 20 real pages, run live for at least three days before submission, and provide logs of actual captured changes. Show an as-of lookup, a structured diff, and a timeline with screenshots and source links.
- [ ] Run the edge-case and security checks in SPEC.md. Capture reproducible live evidence separately from fixture results.
- [ ] Review every submission requirement (S1, S2, S3, S4, S5, S6) and approval criterion before marking the build ready.
- [ ] Prepare setup instructions, the working build link, notes explaining TinyFish's role, the required LinkedIn post tagging TinyFish, and the Discord #showcase share. Obtain publication authorization before posting.
- [ ] Verify the evidence and submit by Tuesday, November 17, 2026 at 11:59 PM Pacific (Wednesday, November 18 at 12:59 PM Pakistan time).
