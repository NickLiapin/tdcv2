# he text corpus — provenance

Filler text for posts, reviews, bios, notes — any field that needs plausible
prose in he.

## Source

All text is **public domain**, from [Project Gutenberg](https://www.gutenberg.org).
The Gutenberg header and licence footer are stripped; only the public-domain body
is kept. Quotes and dashes are normalised to ASCII.

| Gutenberg id | title            | author      |
| ------------ | ---------------- | ----------- |
| 18291        | Hunger, Book One | Knut Hamsun |
| 5139         | Tales            | Carl Ewald  |

## Files

- `sentences.txt` — 4798 sentences
- `paragraphs.txt` — 241 paragraphs

Rebuild with `node data/scripts/build-text-corpus.mjs --locale he`. The raw books are not committed.
