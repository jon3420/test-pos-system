# scripts/fixtures/phase3a4-pristine-line-order.html

Committed fixture required by `scripts/smoke-h1-4-12-popup-frontend.js`
(case group "3-ab-parity") to run the real A/B comparison between the
Phase 3A.4 baseline `public/line-order.html` and the current one.

Required source and hash chain (traced from project history, not invented):

- Origin checkpoint: fix18-10-hotfix30-B5-R5.4-G1.6-GA4-H1.4.12-POPUP-PICKUP-PHASE3A.4-CHECKPOINT-full.zip
- Origin checkpoint bytes: 4,984,739
- Origin checkpoint SHA-256: 546471ce7df708095d4b706b80a172fd030508c2e231a1d22ac0eb9e5b10a266
- public/line-order.html extracted from that checkpoint must hash to:
  f314269c197b7ef594a1457838e04a72693676ffcaa059ffce72ab33bfbf28cc

STATUS: NOT YET PRESENT. Do not synthesize this file by copying the
current public/line-order.html (that would make the A/B test meaningless)
and do not hand-write a substitute. It must come from the Phase 3A.4
checkpoint above, and its hash must be verified against
f314269c197b7ef594a1457838e04a72693676ffcaa059ffce72ab33bfbf28cc before
the smoke test is allowed to treat it as valid.
