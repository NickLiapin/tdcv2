# ro text corpus — provenance

Filler text for posts, reviews, bios, notes — any field that needs plausible
prose in ro.

## Source

All text is **public domain**, from [Project Gutenberg](https://www.gutenberg.org).
The Gutenberg header and licence footer are stripped; only the public-domain body
is kept. Quotes and dashes are normalised to ASCII.

| Gutenberg id | title                         | author                  |
| ------------ | ----------------------------- | ----------------------- |
| 64597        | Nuvele                        | I. L. Caragiale         |
| 62916        | Povesti                       | Ioan Slavici            |
| 65565        | Tara mea                      | Maria, Queen of Romania |
| 11756        | Creierul, o enigma descifrata | Dorin Teodor Moisa      |

## Files

- `sentences.txt` — 7270 sentences
- `paragraphs.txt` — 2189 paragraphs

Rebuild with `node data/scripts/build-text-corpus.mjs --locale ro`. The raw books are not committed.
