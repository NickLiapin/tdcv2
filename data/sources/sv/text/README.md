# sv text corpus — provenance

Filler text for posts, reviews, bios, notes — any field that needs plausible
prose in sv.

## Source

All text is **public domain**, from [Project Gutenberg](https://www.gutenberg.org).
The Gutenberg header and licence footer are stripped; only the public-domain body
is kept. Quotes and dashes are normalised to ASCII.

| Gutenberg id | title             | author            |
| ------------ | ----------------- | ----------------- |
| 57052        | Roda rummet       | August Strindberg |
| 39147        | Bannlyst          | Selma Lagerlof    |
| 51440        | Valda Berattelser | Selma Lagerlof    |

## Files

- `sentences.txt` — 6747 sentences
- `paragraphs.txt` — 1344 paragraphs

Rebuild with `node data/scripts/build-text-corpus.mjs --locale sv`. The raw books are not committed.
