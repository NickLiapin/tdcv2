# pt text corpus — provenance

Filler text for posts, reviews, bios, notes — any field that needs plausible
prose in pt.

## Source

All text is **public domain**, from [Project Gutenberg](https://www.gutenberg.org).
The Gutenberg header and licence footer are stripped; only the public-domain body
is kept. Quotes and dashes are normalised to ASCII.

| Gutenberg id | title        | author           |
| ------------ | ------------ | ---------------- |
| 55752        | Dom Casmurro | Machado de Assis |

## Files

- `sentences.txt` — 2592 sentences
- `paragraphs.txt` — 448 paragraphs

Rebuild with `node data/scripts/build-text-corpus.mjs --locale pt`. The raw books are not committed.
