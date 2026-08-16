# fa text corpus — provenance

Filler text for posts, reviews, bios, notes — any field that needs plausible
prose in fa.

## Source

All text is **public domain**, from [Project Gutenberg](https://www.gutenberg.org).
The Gutenberg header and licence footer are stripped; only the public-domain body
is kept. Quotes and dashes are normalised to ASCII.

| Gutenberg id | title                       | author         |
| ------------ | --------------------------- | -------------- |
| 46740        | Five Selected Short Stories | D. H. Lawrence |

## Files

- `sentences.txt` — 645 sentences
- `paragraphs.txt` — 146 paragraphs

Rebuild with `node data/scripts/build-text-corpus.mjs --locale fa`. The raw books are not committed.
