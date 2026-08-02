Wall clock is the best of the repeats; the small figure under it is peak RSS.

## `customers.tdc`

### short — 10 000 rows

Output 0.7 MB.

| Engine            |                  TypeScript |                        Java |                     Python | vs fastest                |
| ----------------- | --------------------------: | --------------------------: | -------------------------: | :------------------------ |
| 1 — in memory     | 0.33 s<br><sub>122 MB</sub> |  0.24 s<br><sub>93 MB</sub> | 0.28 s<br><sub>37 MB</sub> | Ty ×1.3, Ja ×1.0, Py ×1.1 |
| 2 — streaming     | 0.36 s<br><sub>128 MB</sub> | 0.28 s<br><sub>112 MB</sub> | 0.61 s<br><sub>30 MB</sub> | Ty ×1.3, Ja ×1.0, Py ×2.2 |
| 3 — exact on disk | 0.37 s<br><sub>125 MB</sub> | 0.29 s<br><sub>106 MB</sub> | 0.61 s<br><sub>31 MB</sub> | Ty ×1.2, Ja ×1.0, Py ×2.1 |

### medium — 1 000 000 rows

Output 69.9 MB.

| Engine            |                  TypeScript |                          Java |                       Python | vs fastest                 |
| ----------------- | --------------------------: | ----------------------------: | ---------------------------: | :------------------------- |
| 1 — in memory     | 2.94 s<br><sub>485 MB</sub> | 2.88 s<br><sub>2 957 MB</sub> | 15.52 s<br><sub>581 MB</sub> | Ty ×1.0, Ja ×1.0, Py ×5.4  |
| 2 — streaming     | 6.42 s<br><sub>282 MB</sub> |   4.50 s<br><sub>399 MB</sub> |  45.82 s<br><sub>31 MB</sub> | Ty ×1.4, Ja ×1.0, Py ×10.2 |
| 3 — exact on disk | 6.12 s<br><sub>284 MB</sub> |   4.57 s<br><sub>396 MB</sub> |  45.67 s<br><sub>30 MB</sub> | Ty ×1.3, Ja ×1.0, Py ×10.0 |

### large — 14 900 000 rows

Output 1 060.9 MB.

| Engine            |                      TypeScript |                            Java |                            Python | vs fastest                 |
| ----------------- | ------------------------------: | ------------------------------: | --------------------------------: | :------------------------- |
| 1 — in memory     |  50.89 s<br><sub>3 573 MB</sub> |  40.82 s<br><sub>8 246 MB</sub> | 3 m 57.1 s<br><sub>8 247 MB</sub> | Ty ×1.2, Ja ×1.0, Py ×5.8  |
| 2 — streaming     | 1 m 26.7 s<br><sub>290 MB</sub> | 1 m 03.9 s<br><sub>396 MB</sub> |   11 m 41.3 s<br><sub>31 MB</sub> | Ty ×1.4, Ja ×1.0, Py ×11.0 |
| 3 — exact on disk | 1 m 29.8 s<br><sub>286 MB</sub> | 1 m 05.0 s<br><sub>398 MB</sub> |   11 m 56.3 s<br><sub>31 MB</sub> | Ty ×1.4, Ja ×1.0, Py ×11.0 |

## `uniq.tdc`

### short — 10 000 rows

Output 0.2 MB.

| Engine            |                  TypeScript |                        Java |                     Python | vs fastest                |
| ----------------- | --------------------------: | --------------------------: | -------------------------: | :------------------------ |
| 1 — in memory     | 0.45 s<br><sub>125 MB</sub> | 0.34 s<br><sub>183 MB</sub> | 0.89 s<br><sub>36 MB</sub> | Ty ×1.3, Ja ×1.0, Py ×2.6 |
| 2 — streaming     | 0.30 s<br><sub>119 MB</sub> |  0.15 s<br><sub>77 MB</sub> | 0.21 s<br><sub>30 MB</sub> | Ty ×2.0, Ja ×1.0, Py ×1.4 |
| 3 — exact on disk | 0.36 s<br><sub>119 MB</sub> |  0.23 s<br><sub>86 MB</sub> | 0.46 s<br><sub>31 MB</sub> | Ty ×1.6, Ja ×1.0, Py ×2.1 |

### medium — 1 000 000 rows

Output 20.9 MB.

| Engine            |                  TypeScript |                          Java |                       Python | vs fastest                |
| ----------------- | --------------------------: | ----------------------------: | ---------------------------: | :------------------------ |
| 1 — in memory     | 3.70 s<br><sub>819 MB</sub> | 2.64 s<br><sub>1 910 MB</sub> |  9.33 s<br><sub>545 MB</sub> | Ty ×1.4, Ja ×1.0, Py ×3.5 |
| 2 — streaming     | 2.28 s<br><sub>211 MB</sub> |   1.32 s<br><sub>400 MB</sub> |  10.07 s<br><sub>30 MB</sub> | Ty ×1.7, Ja ×1.0, Py ×7.6 |
| 3 — exact on disk | 6.52 s<br><sub>985 MB</sub> | 4.22 s<br><sub>1 697 MB</sub> | 18.73 s<br><sub>550 MB</sub> | Ty ×1.5, Ja ×1.0, Py ×4.4 |
