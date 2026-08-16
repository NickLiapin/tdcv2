# hu text corpus — provenance

Filler text for posts, reviews, bios, notes — any field that needs plausible
prose in hu.

## Source

All text is **public domain**, from [Project Gutenberg](https://www.gutenberg.org).
The Gutenberg header and licence footer are stripped; only the public-domain body
is kept. Quotes and dashes are normalised to ASCII.

| Gutenberg id | title            | author        |
| ------------ | ---------------- | ------------- |
| 43777        | Az uj foldesur   | Mor Jokai     |
| 69689        | A Pal-utcai fiuk | Ferenc Molnar |
| 40685        | Timar Virgil fia | Mihaly Babits |

## Files

- `sentences.txt` — 4985 sentences
- `paragraphs.txt` — 884 paragraphs

Rebuild with `node data/scripts/build-text-corpus.mjs --locale hu`. The raw books are not committed.
