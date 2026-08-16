# ja text corpus — provenance

Filler text for posts, reviews, bios, notes — any field that needs plausible
prose in ja.

## Source

All text is **public domain**, from [Project Gutenberg](https://www.gutenberg.org).
The Gutenberg header and licence footer are stripped; only the public-domain body
is kept. Quotes and dashes are normalised to ASCII.

| Gutenberg id | title              | author               |
| ------------ | ------------------ | -------------------- |
| 33307        | Yujo               | Saneatsu Mushanokoji |
| 35327        | Amerika monogatari | Kafu Nagai           |
| 31757        | Omedetaki hito     | Saneatsu Mushanokoji |

## Files

- `sentences.txt` — 5037 sentences
- `paragraphs.txt` — 1302 paragraphs

Rebuild with `node data/scripts/build-text-corpus.mjs --locale ja`. The raw books are not committed.
