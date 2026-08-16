# it text corpus — provenance

Filler text for posts, reviews, bios, notes — any field that needs plausible
prose in it.

## Source

All text is **public domain**, from [Project Gutenberg](https://www.gutenberg.org).
The Gutenberg header and licence footer are stripped; only the public-domain body
is kept. Quotes and dashes are normalised to ASCII.

| Gutenberg id | title                                  | author               |
| ------------ | -------------------------------------- | -------------------- |
| 25178        | Damiano: Storia di una povera famiglia | Anton Giulio Barrili |
| 38720        | L'amore che torna: romanzo             | Guido da Verona      |

## Files

- `sentences.txt` — 6653 sentences
- `paragraphs.txt` — 1669 paragraphs

Rebuild with `node data/scripts/build-text-corpus.mjs --locale it`. The raw books are not committed.
