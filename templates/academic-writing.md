---
title: Academic writing
blurb: Sources, manuscript, citations, export.
creates: Folders for chapters, sources and notes, a chapter outline for the kind of work and the export settings, all from the answers on the next step.
workflows: literature-search, check-citations, export-manuscript, writing-progress
---
This project is a piece of academic writing, not software. PROJECT.md holds the topic, research question, language, citation style, output format, target length, deadline and where the sources live. Read it before you work on the text.

Layout: chapters in manuscript/ as numbered Markdown files, PDFs of the sources in sources/, excerpts and ideas in notes/, the bibliography in references.bib, the export settings in pandoc.yaml, exports in export/.

Sources:
- Never invent a source, an author, a year, a page or a quote. Cite only what is in references.bib, and add to it only works whose DOI or ISBN you have checked.
- Cite with Pandoc citekeys: [@key], [@key, p. 12], [-@key]. Give a page for every claim taken from a source when the PDF is in sources/.
- Mark direct quotes as quotes and copy them word for word.
- Say so when a claim needs a source you could not find, instead of weakening or dropping the citation.
- Savor keeps a text copy of each PDF in sources/text/<name>.txt, every page under a line like `--- page 3 (printed 347) ---`. Search and read those; open the PDF only when its copy is missing or nearly empty (a scan). Cite the printed page number, from the marker or printed on the page, and the PDF page only when the work has none.

Questions about the sources:
- Answer from sources/ and notes/. Cite every statement taken from them as [@key, p. N] and quote the sentence that supports it.
- When a message names the sources to use, answer only from those.
- If the sources don't answer the question, say so. Mark anything you add from your own knowledge or the web as such.

Writing:
- The text belongs to the author. Write or rewrite passages when asked, otherwise propose changes in your conclusion.
- Write in the language set in PROJECT.md, in an academic register, without filler.
- Log every substantial AI contribution (search, drafting, rewriting) with date and chapter in notes/ai-use.md, so the author can declare it.

Commit finished steps with a short message.
