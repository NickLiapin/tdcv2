# cs text corpus — provenance

Filler text for posts, reviews, bios, notes — any field that needs plausible
prose in cs.

## Source

All text is **public domain**, from [Project Gutenberg](https://www.gutenberg.org).
The Gutenberg header and licence footer are stripped; only the public-domain body
is kept. Quotes and dashes are normalised to ASCII.

| Gutenberg id | title                | author               |
| ------------ | -------------------- | -------------------- |
| 13083        | R.U.R.               | Karel Capek          |
| 27960        | Hore dedinu          | Josef Uher           |
| 47754        | Blesky nad Beskydami | Frantisek Sokol-Tuma |

## Files

- `sentences.txt` — 3403 sentences
- `paragraphs.txt` — 417 paragraphs

Rebuild with `node data/scripts/build-text-corpus.mjs --locale cs`. The raw books are not committed.
