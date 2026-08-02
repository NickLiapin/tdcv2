# English text corpus — provenance

Filler English text ("lorem ipsum" made of real prose) for posts, replies,
reviews, bios, notes, product descriptions, and any field that needs plausible
English sentences or paragraphs.

## Source

All text is **public domain**, from [Project Gutenberg](https://www.gutenberg.org).
Gutenberg header/footer and licence boilerplate were stripped; only the
public-domain body text is kept. Curly quotes, dashes and emphasis underscores
were normalised to ASCII.

| Gutenberg id | title                             | author                  |
| ------------ | --------------------------------- | ----------------------- |
| 11           | Alice's Adventures in Wonderland  | Lewis Carroll           |
| 2591         | Grimms' Fairy Tales               | Jacob and Wilhelm Grimm |
| 1661         | The Adventures of Sherlock Holmes | Arthur Conan Doyle      |
| 1342         | Pride and Prejudice               | Jane Austen             |

Four books span registers (whimsical, fairy tale, detective, social novel) so the
"voice" of the filler varies.

## Files

- `sentences.txt` — every clean sentence (9313), the source for a future downloadable
  `en-text` bundle.
- `paragraphs.txt` — every clean paragraph (2673).

The default `en` bundle ships a curated subset (`data/packs/en/text/`): 500
sentences, 150 paragraphs, 400 words — enough for realistic output offline, small
enough to bundle.
