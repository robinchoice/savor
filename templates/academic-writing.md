---
title: Academic writing
blurb: Sources, manuscript, citations, export.
creates: manuscript/, sources/, notes/, references.bib and a Pandoc export. Then the agent asks for topic, citation style, format and where your sources live.
workflows: literature-search, check-citations, export-manuscript, writing-progress
---
This project is a piece of academic writing, not software. PROJECT.md holds the topic, research question, language, citation style, output format, target length, deadline and where the sources live. Read it before you work on the text.

Layout: chapters in manuscript/ as numbered Markdown files, PDFs of the sources in sources/, excerpts and ideas in notes/, the bibliography in references.bib, the export settings in pandoc.yaml, exports in export/.

Sources:
- Never invent a source, an author, a year, a page or a quote. Cite only what is in references.bib, and add to it only works whose DOI or ISBN you have checked.
- Cite with Pandoc citekeys: [@key], [@key, p. 12], [-@key]. Give a page for every claim taken from a source when the PDF is in sources/.
- Mark direct quotes as quotes and copy them word for word.
- Say so when a claim needs a source you could not find, instead of weakening or dropping the citation.

Writing:
- The text belongs to the author. Write or rewrite passages when asked, otherwise propose changes in your conclusion.
- Write in the language set in PROJECT.md, in an academic register, without filler.
- Log every substantial AI contribution (search, drafting, rewriting) with date and chapter in notes/ai-use.md, so the author can declare it.

Commit finished steps with a short message.
<!-- setup -->
Set up this project for a piece of academic writing.

1. Create the layout: manuscript/ with 01-introduction.md as a start, sources/, notes/ with an empty ai-use.md, export/ (ignored by git), an empty references.bib and PROJECT.md.
2. Check whether pandoc is installed, and for PDF output a LaTeX engine or typst. Note what is missing and how to install it on this system.
3. Ask me, with options where they make sense:
   - topic, working title and research question (free text)
   - the kind of work: term paper, bachelor's thesis, master's thesis, article, other
   - citation style: APA 7, DIN ISO 690, Harvard, IEEE, Chicago author-date, or the CSL file of my university
   - what I hand in: DOCX, PDF via LaTeX, PDF via typst
   - where my sources live: Zotero with Better BibTeX auto-export (then I give you the path of the exported .bib), PDFs I put in sources/, or Open Notebook
   - language, target length and deadline
   - whether there is a template from my university

After my answers: write PROJECT.md with a line `Target length: <number> words`, fetch the CSL style from the official repository (github.com/citation-style-language/styles) into styles/, write pandoc.yaml with the top-level keys `to` (docx, latex or typst), `bibliography`, `csl`, `citeproc: true` and, if there is one, `reference-doc` or `template`, but without `input-files`: Savor's Export tab passes the chapters of manuscript/ in name order, link or copy the Zotero export to references.bib, rename and outline the chapters for the kind of work and language, try an export, and commit.
