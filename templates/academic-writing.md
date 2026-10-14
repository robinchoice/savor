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
2. Check whether pandoc is installed. Without it there is no export: offer to install it for me (on Windows with `winget install --exact --id JohnMacFarlane.Pandoc`, on macOS with Homebrew if it is there, otherwise the .pkg from github.com/jgm/pandoc/releases, on Linux with the package manager) and do it once I agree. LaTeX or typst are needed only for PDF output; check them only if I choose that.
3. Assume I have never used a terminal, Markdown, git or a reference manager. Explain each term you need in half a sentence, and recommend the simplest choice. Ask me, with options where they make sense:
   - topic, working title and research question (free text)
   - the kind of work: term paper, bachelor's thesis, master's thesis, article, other
   - citation style: APA 7, DIN ISO 690, Harvard, IEEE, Chicago author-date, or the CSL file of my university
   - what I hand in: DOCX (recommended: opens in Word, which also saves it as PDF), PDF via LaTeX, PDF via typst
   - where my sources live: PDFs I put in sources/ (recommended without a reference manager), Zotero with Better BibTeX auto-export (then I give you the path of the exported .bib), or Open Notebook
   - language, target length and deadline
   - whether there is a template from my university

After my answers: write PROJECT.md with a line `Target length: <number> words`, fetch the CSL style from the official repository (github.com/citation-style-language/styles) into styles/, write pandoc.yaml with the top-level keys `to` (docx, latex or typst), `bibliography`, `csl`, `citeproc: true`, if there is one `reference-doc` or `template`, and `lang`, `title`, `author` and `reference-section-title` (the bibliography's heading in the work's language) under `metadata:`, since pandoc rejects them as top-level keys; but without `input-files`: Savor's Export tab passes the chapters of manuscript/ in name order, link or copy the Zotero export to references.bib, rename and outline the chapters for the kind of work and language, try an export, and commit.
<!-- setup de -->
Richte dieses Projekt für eine wissenschaftliche Arbeit ein.

1. Lege die Struktur an: manuscript/ mit 01-einleitung.md als Anfang, sources/, notes/ mit einer leeren ai-use.md, export/ (von git ignoriert), eine leere references.bib und PROJECT.md.
2. Prüfe, ob pandoc installiert ist. Ohne pandoc gibt es keinen Export: Biete mir an, es zu installieren (unter Windows mit `winget install --exact --id JohnMacFarlane.Pandoc`, unter macOS mit Homebrew, falls vorhanden, sonst das .pkg von github.com/jgm/pandoc/releases, unter Linux mit dem Paketmanager), und tu es, sobald ich zustimme. LaTeX oder typst braucht es nur für PDF; prüfe sie nur, wenn ich das wähle.
3. Geh davon aus, dass ich noch nie mit Terminal, Markdown, git oder einer Literaturverwaltung gearbeitet habe. Erkläre jeden Begriff, den du brauchst, in einem halben Satz, und empfiehl die einfachste Wahl. Frag mich, mit Optionen, wo es passt:
   - Thema, Arbeitstitel und Forschungsfrage (freier Text)
   - Art der Arbeit: Hausarbeit, Bachelorarbeit, Masterarbeit, Artikel, anderes
   - Zitierstil: APA 7, DIN ISO 690, Harvard, IEEE, Chicago author-date oder die CSL-Datei meiner Uni
   - was ich abgebe: DOCX (empfohlen: öffnet sich in Word, das auch als PDF speichert), PDF über LaTeX, PDF über typst
   - wo meine Quellen liegen: PDFs, die ich in sources/ lege (empfohlen ohne Literaturverwaltung), Zotero mit Better-BibTeX-Auto-Export (dann gebe ich dir den Pfad der exportierten .bib) oder Open Notebook
   - Sprache, Umfang und Abgabetermin
   - ob es eine Vorlage meiner Uni gibt

Sprich mit mir auf Deutsch, solange ich nicht in einer anderen Sprache schreibe. Nach meinen Antworten: Schreib PROJECT.md mit einer Zeile `Target length: <Zahl> words`, hol den CSL-Stil aus dem offiziellen Repository (github.com/citation-style-language/styles) nach styles/, schreib pandoc.yaml mit den Schlüsseln `to` (docx, latex oder typst), `bibliography`, `csl`, `citeproc: true`, falls vorhanden `reference-doc` oder `template` auf oberster Ebene, und `lang`, `title`, `author` und `reference-section-title` (die Überschrift des Literaturverzeichnisses in der Sprache der Arbeit) unter `metadata:`, weil pandoc sie auf oberster Ebene ablehnt; aber ohne `input-files`: Der Export-Tab von Savor übergibt die Kapitel aus manuscript/ nach Namen sortiert. Verlinke oder kopiere den Zotero-Export nach references.bib, benenne und gliedere die Kapitel passend zu Art und Sprache der Arbeit, probiere einen Export und committe.
