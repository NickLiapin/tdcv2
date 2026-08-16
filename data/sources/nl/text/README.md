# nl text corpus — provenance

Filler text for posts, reviews, bios, notes — any field that needs plausible
prose in nl.

## Source

All text is **public domain**, from [Project Gutenberg](https://www.gutenberg.org).
The Gutenberg header and licence footer are stripped; only the public-domain body
is kept. Quotes and dashes are normalised to ASCII.

| Gutenberg id | title              | author             |
| ------------ | ------------------ | ------------------ |
| 11024        | Max Havelaar       | Multatuli          |
| 15975        | Camera Obscura     | Hildebrand         |
| 10819        | De kleine Johannes | Frederik van Eeden |

## Files

- `sentences.txt` — 8631 sentences
- `paragraphs.txt` — 1611 paragraphs

Rebuild with `node data/scripts/build-text-corpus.mjs --locale nl`. The raw books are not committed.
