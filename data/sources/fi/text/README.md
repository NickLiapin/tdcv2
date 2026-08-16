# fi text corpus — provenance

Filler text for posts, reviews, bios, notes — any field that needs plausible
prose in fi.

## Source

All text is **public domain**, from [Project Gutenberg](https://www.gutenberg.org).
The Gutenberg header and licence footer are stripped; only the public-domain body
is kept. Quotes and dashes are normalised to ASCII.

| Gutenberg id | title                           | author         |
| ------------ | ------------------------------- | -------------- |
| 78018        | Karavaani ja muita juttuja      | Pentti Haanpaa |
| 78058        | Lintukoto                       | Joel Lehtonen  |
| 78096        | Hajamuistelmia pakolaiselamasta | Aatto Siren    |

## Files

- `sentences.txt` — 4305 sentences
- `paragraphs.txt` — 774 paragraphs

Rebuild with `node data/scripts/build-text-corpus.mjs --locale fi`. The raw books are not committed.
