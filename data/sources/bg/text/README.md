# bg text corpus — provenance

Filler text for posts, reviews, bios, notes — any field that needs plausible
prose in bg.

## Source

All text is **public domain**, from [Project Gutenberg](https://www.gutenberg.org).
The Gutenberg header and licence footer are stripped; only the public-domain body
is kept. Quotes and dashes are normalised to ASCII.

| Gutenberg id | title             | author           |
| ------------ | ----------------- | ---------------- |
| 2894         | Short Stories     | Hristo Botev     |
| 4909         | Olaf van Geldern  | Pencho Slaveykov |
| 10752        | Mislite v glavite | Harry Stojan     |

## Files

- `sentences.txt` — 1804 sentences
- `paragraphs.txt` — 22 paragraphs

Rebuild with `node data/scripts/build-text-corpus.mjs --locale bg`. The raw books are not committed.
