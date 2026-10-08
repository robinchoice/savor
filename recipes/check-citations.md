---
title: Check citations
blurb: Every [@key] resolves, every DOI exists, and the cited source says what the text claims.
category: Academic writing
schedule: 0 2 * * *
---
Check the citations in manuscript/.

1. Every [@citekey] has an entry in references.bib.
2. Every DOI in references.bib resolves at doi.org, and title, authors and year match the entry.
3. For claims cited with a page, open the PDF in sources/ and check that the page supports the claim. Spot-check the rest, starting with the chapters changed since the last run.
4. Direct quotes are marked as quotes and match the source word for word.
5. Statements of fact without any citation.

Do not change the text. Conclude with a list ordered by severity: file, line, citekey, what is wrong, and a proposed fix. If everything holds, say so in one sentence.
