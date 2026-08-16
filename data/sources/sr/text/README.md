# sr text corpus — provenance

Filler text for posts, reviews, bios, notes — any field that needs plausible
prose in sr.

## Source

All text is **public domain**, from [Project Gutenberg](https://www.gutenberg.org).
The Gutenberg header and licence footer are stripped; only the public-domain body
is kept. Quotes and dashes are normalised to ASCII.

| Gutenberg id | title           | author           |
| ------------ | --------------- | ---------------- |
| 11292        | Sekund vecnosti | Dragutin J. Ilic |
| 11291        | Kameno doba     | Jovan Zujovic    |

## Files

- `sentences.txt` — 1821 sentences
- `paragraphs.txt` — 341 paragraphs

Rebuild with `node data/scripts/build-text-corpus.mjs --locale sr`. The raw books are not committed.
