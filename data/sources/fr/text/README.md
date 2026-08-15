# fr text corpus — provenance

Filler text for posts, reviews, bios, notes — any field that needs plausible
prose in fr.

## Source

All text is **public domain**, from [Project Gutenberg](https://www.gutenberg.org).
The Gutenberg header and licence footer are stripped; only the public-domain body
is kept. Quotes and dashes are normalised to ASCII.

| Gutenberg id | title                                   | author           |
| ------------ | --------------------------------------- | ---------------- |
| 800          | Le tour du monde en quatre-vingts jours | Jules Verne      |
| 14155        | Madame Bovary                           | Gustave Flaubert |

## Files

- `sentences.txt` — 6017 sentences
- `paragraphs.txt` — 1487 paragraphs

Rebuild with `node data/scripts/build-text-corpus.mjs --locale fr`. The raw books are not committed.
