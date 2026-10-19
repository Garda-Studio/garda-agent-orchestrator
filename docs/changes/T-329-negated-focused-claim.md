# Preserve negated execution statements in substantive review findings

A real upgrade-regression finding explicitly said it was a test-design gap,
"not a claim that a particular focused execution was missing." The findings
validator treated those negated words as an affirmative missing-execution claim
and rejected the report. This also blocked output correction, which must retain
the original substantive findings.

The keyword check now inspects each claim separately and recognizes an adjacent,
bounded explicit negation of reporting that claim. It still rejects affirmative
claims elsewhere in the same field or in the title. Canonical F-000 ownership,
attempt requirements and all existing finding/evidence contracts are retained.
Overlapping candidate starts prevent an ignored negated phrase from consuming a
later affirmative subject, including when the first phrase says execution ran
or succeeded rather than containing its own missing-execution keyword.

Regression cases cover the original design-finding wording, negated design risks,
and affirmative claims before or after a negation, across period, semicolon and
contrast boundaries in both ordinary findings and residual risks.
The original reviewer report is retained unchanged; this repair supplies no PASS
and does not resolve its three substantive T-329 findings.
