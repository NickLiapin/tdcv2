# es text corpus — provenance

Filler text for posts, reviews, bios, notes — any field that needs plausible
prose in es.

## Source

All text is **public domain**, from [Project Gutenberg](https://www.gutenberg.org).
The Gutenberg header and licence footer are stripped; only the public-domain body
is kept. Quotes and dashes are normalised to ASCII.

| Gutenberg id | title       | author              |
| ------------ | ----------- | ------------------- |
| 2000         | Don Quijote | Miguel de Cervantes |

## Files

- `sentences.txt` — 4169 sentences
- `paragraphs.txt` — 2010 paragraphs

Rebuild with `node data/scripts/build-text-corpus.mjs --locale es`. The raw books are not committed.
