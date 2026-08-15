# de text corpus — provenance

Filler text for posts, reviews, bios, notes — any field that needs plausible
prose in de.

## Source

All text is **public domain**, from [Project Gutenberg](https://www.gutenberg.org).
The Gutenberg header and licence footer are stripped; only the public-domain body
is kept. Quotes and dashes are normalised to ASCII.

| Gutenberg id | title              | author          |
| ------------ | ------------------ | --------------- |
| 12108        | Der Tod in Venedig | Thomas Mann     |
| 5323         | Effi Briest        | Theodor Fontane |

## Files

- `sentences.txt` — 2526 sentences
- `paragraphs.txt` — 654 paragraphs

Rebuild with `node data/scripts/build-text-corpus.mjs --locale de`. The raw books are not committed.
