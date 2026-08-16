# pl text corpus — provenance

Filler text for posts, reviews, bios, notes — any field that needs plausible
prose in pl.

## Source

All text is **public domain**, from [Project Gutenberg](https://www.gutenberg.org).
The Gutenberg header and licence footer are stripped; only the public-domain body
is kept. Quotes and dashes are normalised to ASCII.

| Gutenberg id | title                    | author              |
| ------------ | ------------------------ | ------------------- |
| 34079        | Tajemnica Baskerville'ow | Arthur Conan Doyle  |
| 6000         | Ironia Pozorow           | Waclaw Sieroszewski |

## Files

- `sentences.txt` — 5264 sentences
- `paragraphs.txt` — 1362 paragraphs

Rebuild with `node data/scripts/build-text-corpus.mjs --locale pl`. The raw books are not committed.
