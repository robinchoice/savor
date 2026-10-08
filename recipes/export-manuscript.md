---
title: Export manuscript
blurb: Builds the hand-in version with Pandoc, in the citation style and format set up for the project.
category: Academic writing
schedule:
---
Export the manuscript with the Pandoc settings in pandoc.yaml: chapters from manuscript/ in order, references.bib, the CSL style and template named there. Write the result to export/ with today's date in the file name.

Before exporting, check that every [@citekey] resolves and that no chapter is empty. Report problems, but export anyway unless a citation fails to resolve.

Open the result and check the bibliography, the headings and the page count. Conclude with the path of the file, the word count without the bibliography, and what looked wrong.
