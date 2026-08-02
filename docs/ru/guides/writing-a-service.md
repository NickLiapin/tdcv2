<a name="top"></a>

[English](../../guides/writing-a-service.md#top) · **Русский** · [Español](../../es/guides/writing-a-service.md#top)

← Назад: [Большие объёмы](./large-outputs.md#top) · **[Оглавление](../README.md#top)** · Вперёд: [Обзор](../data-packs/overview.md#top) →

---

# Как написать сервис-генератор

[Генератор `http`](../generators/http.md#top) отдаёт решение о значениях сервису, который
написали вы. Эта страница — вторая половина: **как написать такой сервис** на Node,
Python или Java, чтобы он был быстрым, корректным и — вот это упускают все —
**воспроизводимым**.

Ниже по одному рабочему сервису на язык. Каждый закрывает оба режима: придумывает номера
счетов, когда у него просят значения, и приписывает контрольную цифру Луна, когда ему
значения присылают.

## Что сервис обязан делать

Полный контракт — на [странице генератора](../generators/http.md#контракт-который-реализует-ваш-сервис).
Чтобы написать сервис, хватает четырёх строк из него:

- приходит **`POST`** с заголовками `X-TDC-Count: N` и `X-TDC-Seed: <hex>`;
- **тело** — это `N` значений, по одному на строку, либо **пустое**, что значит «придумай их»;
- ответить нужно ровно **`N` строками**, в том же порядке;
- обычный текст, никакого JSON нигде не требуется.

## Сервис на четырёх языках

#### Node.js

```js
import { createServer } from 'node:http';

/** FNV-1a (32-bit). The same three lines in every language — that is the point. */
function fnv1a(text) {
  let h = 0x811c9dc5;
  for (const ch of Buffer.from(text, 'utf8')) {
    h ^= ch;
    h = Math.imul(h, 0x01000193) >>> 0; // Math.imul keeps it 32-bit
  }
  return h >>> 0;
}

/** Source mode: an 8-digit account for row `i`, decided only by (seed, i). */
function accountFor(seed, i) {
  return String(fnv1a(`${seed}#${i}`) % 100000000).padStart(8, '0');
}

/** Handler mode: the Luhn check digit of what was sent. */
function luhn(number) {
  let sum = 0;
  let dbl = true;
  for (let i = number.length - 1; i >= 0; i--) {
    let d = number.charCodeAt(i) - 48;
    if (d < 0 || d > 9) continue;
    if (dbl) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
    dbl = !dbl;
  }
  return String((10 - (sum % 10)) % 10);
}

createServer((req, res) => {
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => {
    const count = Number(req.headers['x-tdc-count'] ?? '0');
    const seed = String(req.headers['x-tdc-seed'] ?? '');
    const body = Buffer.concat(chunks).toString('utf8');

    const out =
      body.length === 0
        ? Array.from({ length: count }, (_, i) => accountFor(seed, i)) // source
        : body.split('\n').map((line) => line + luhn(line)); // handler

    const payload = out.join('\n');
    res.writeHead(200, {
      'Content-Type': 'text/plain',
      'Content-Length': Buffer.byteLength(payload),
    });
    res.end(payload);
  });
}).listen(5701, '127.0.0.1');
```

Запуск: `node service.mjs`, затем направьте `src` на `http://127.0.0.1:5701/`.

#### Python

```python
import sys
from http.server import BaseHTTPRequestHandler, HTTPServer


def fnv1a(text: str) -> int:
    """FNV-1a (32-bit). The mask is what keeps Python's big ints 32-bit."""
    h = 0x811C9DC5
    for byte in text.encode("utf-8"):
        h ^= byte
        h = (h * 0x01000193) & 0xFFFFFFFF
    return h


def account_for(seed: str, i: int) -> str:
    """Source mode: an 8-digit account for row `i`, decided only by (seed, i)."""
    return f"{fnv1a(f'{seed}#{i}') % 100000000:08d}"


def luhn(number: str) -> str:
    """Handler mode: the Luhn check digit of what was sent."""
    total, dbl = 0, True
    for ch in reversed(number):
        if not ch.isdigit():
            continue
        d = int(ch)
        if dbl:
            d *= 2
            if d > 9:
                d -= 9
        total += d
        dbl = not dbl
    return str((10 - total % 10) % 10)


class Handler(BaseHTTPRequestHandler):
    def do_POST(self):
        n = int(self.headers.get("Content-Length", 0))
        body = self.rfile.read(n).decode("utf-8") if n else ""
        count = int(self.headers.get("X-TDC-Count", "0"))
        seed = self.headers.get("X-TDC-Seed", "")

        if body == "":
            out = [account_for(seed, i) for i in range(count)]   # source
        else:
            out = [line + luhn(line) for line in body.split("\n")]  # handler

        payload = "\n".join(out).encode("utf-8")
        self.send_response(200)
        self.send_header("Content-Type", "text/plain")
        self.send_header("Content-Length", str(len(payload)))
        self.end_headers()
        self.wfile.write(payload)


HTTPServer(("127.0.0.1", 5702), Handler).serve_forever()
```

Запуск: `python3 service.py`, затем направьте `src` на `http://127.0.0.1:5702/`.

#### Java

```java
import com.sun.net.httpserver.HttpServer;
import java.io.IOException;
import java.io.OutputStream;
import java.net.InetSocketAddress;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.List;

public class Service {

    /** FNV-1a (32-bit). Java's int overflow already wraps — no mask needed. */
    static int fnv1a(String text) {
        int h = 0x811C9DC5;
        for (byte b : text.getBytes(StandardCharsets.UTF_8)) {
            h ^= (b & 0xFF);
            h *= 0x01000193;
        }
        return h;
    }

    /** Source mode: an 8-digit account for row `i`, decided only by (seed, i). */
    static String accountFor(String seed, int i) {
        long h = fnv1a(seed + "#" + i) & 0xFFFFFFFFL;   // read the 32 bits as unsigned
        return String.format("%08d", h % 100000000L);
    }

    /** Handler mode: the Luhn check digit of what was sent. */
    static String luhn(String number) {
        int sum = 0;
        boolean dbl = true;
        for (int i = number.length() - 1; i >= 0; i--) {
            char c = number.charAt(i);
            if (c < '0' || c > '9') continue;
            int d = c - '0';
            if (dbl) {
                d *= 2;
                if (d > 9) d -= 9;
            }
            sum += d;
            dbl = !dbl;
        }
        return String.valueOf((10 - sum % 10) % 10);
    }

    public static void main(String[] args) throws IOException {
        HttpServer server = HttpServer.create(new InetSocketAddress("127.0.0.1", 5703), 0);
        server.createContext("/", exchange -> {
            String body = new String(exchange.getRequestBody().readAllBytes(),
                                     StandardCharsets.UTF_8);
            String rawCount = exchange.getRequestHeaders().getFirst("X-TDC-Count");
            int count = Integer.parseInt(rawCount == null ? "0" : rawCount);
            String seed = exchange.getRequestHeaders().getFirst("X-TDC-Seed");
            if (seed == null) seed = "";

            List<String> out = new ArrayList<>();
            if (body.isEmpty()) {
                for (int i = 0; i < count; i++) out.add(accountFor(seed, i));  // source
            } else {
                for (String line : body.split("\n", -1)) out.add(line + luhn(line));  // handler
            }

            byte[] payload = String.join("\n", out).getBytes(StandardCharsets.UTF_8);
            exchange.getResponseHeaders().set("Content-Type", "text/plain");
            exchange.sendResponseHeaders(200, payload.length);
            try (OutputStream os = exchange.getResponseBody()) {
                os.write(payload);
            }
        });
        server.start();
    }
}
```

Запуск: `javac Service.java && java Service`, затем направьте `src` на
`http://127.0.0.1:5703/`.

#### C#

```csharp
using System.Net;
using System.Text;

// FNV-1a (32 бита). C# нужен `unchecked` — его int по умолчанию не заворачивается.
static int Fnv1a(string text)
{
    unchecked
    {
        int h = (int)0x811C9DC5;
        foreach (byte b in Encoding.UTF8.GetBytes(text))
        {
            h ^= b;
            h *= 0x01000193;
        }

        return h;
    }
}

// Режим источника: восьмизначный счёт для строки `i`, зависящий только от (seed, i).
static string AccountFor(string seed, int i) =>
    ((uint)Fnv1a($"{seed}#{i}") % 100000000L).ToString("D8");

// Режим обработчика: контрольная цифра Луна от присланного.
static string Luhn(string number)
{
    int sum = 0;
    bool dbl = true;
    for (int i = number.Length - 1; i >= 0; i--)
    {
        if (number[i] is < '0' or > '9') continue;
        int d = number[i] - '0';
        if (dbl) { d *= 2; if (d > 9) d -= 9; }
        sum += d;
        dbl = !dbl;
    }

    return ((10 - (sum % 10)) % 10).ToString();
}

var server = new HttpListener();
server.Prefixes.Add("http://127.0.0.1:5704/");
server.Start();

while (true)
{
    HttpListenerContext ctx = server.GetContext();
    using var reader = new StreamReader(ctx.Request.InputStream, Encoding.UTF8);
    string body = reader.ReadToEnd();
    int count = int.Parse(ctx.Request.Headers["X-TDC-Count"] ?? "0");
    string seed = ctx.Request.Headers["X-TDC-Seed"] ?? "";

    IEnumerable<string> lines = body.Length == 0
        ? Enumerable.Range(0, count).Select(i => AccountFor(seed, i))   // источник
        : body.Split('\n').Select(line => line + Luhn(line));           // обработчик

    byte[] payload = Encoding.UTF8.GetBytes(string.Join("\n", lines));
    ctx.Response.ContentType = "text/plain";
    ctx.Response.ContentLength64 = payload.Length;
    ctx.Response.OutputStream.Write(payload);
    ctx.Response.Close();
}
```

Запуск: `dotnet run`, затем направьте `src` на `http://127.0.0.1:5704/`.

Любой из четырёх, на одном и том же конфиге:

```xml
<env count="3" seed="demo">
  <sequence name="Payload"><gen type="number" value="10000000..99999999"/></sequence>
  <sequence name="Card"><gen type="http" src="http://127.0.0.1:5701/" in="Payload"/></sequence>
  <sequence name="Acct"><gen type="http" src="http://127.0.0.1:5701/"/></sequence>
</env>
```

`./run demo.tdc`

```
77737493 -> 777374935   |  счёт: 71102997
14850763 -> 148507635   |  счёт: 54325378
87262332 -> 872623327   |  счёт: 37547759
```

`Card` прошла через обработчик — полезная часть вернулась с контрольной цифрой. `Acct`
придумана из одного лишь сида. Поменяйте порт на 5702, 5703 или 5704 — вывод будет символ в
символ тем же.

## Воспроизводимость: зачем нужен сид

Генератор `http` — единственное место, где TDC [жертвует своей гарантией](../generators/http.md#чего-он-не-обещает):
значения решает сервис, поэтому движок не может обещать, что повторный прогон
воспроизведётся. **Ваш сервис — может**, и `X-TDC-Seed` это и делает возможным.

Правило в одну строку: **выводите каждое значение из сида, никогда — из часов или
генератора случайных чисел.**

```js
accountFor(seed, i); // reproducible — same seed, same row, same answer
Math.random(); // not
new Date(); // not
```

Сид, который шлёт TDC, стабилен между прогонами и **разный для каждой
последовательности**, поэтому две `http`-последовательности к одному сервису никогда не
получат один и тот же поток.

Написанный так прогон воспроизводится:

`./run demo.tdc — дважды`

```
прогон 1:  71102997  54325378  37547759
прогон 2:  71102997  54325378  37547759
```

### Считайте строку напрямую, а не перебором

Обратите внимание на форму `accountFor(seed, i)`: она принимает **номер строки** и
возвращает значение этой строки, не таща состояние между вызовами. Это сделано нарочно, и
это стоит перенять.

Генератор, который идёт по последовательности — «вызови `next()` N раз», — обязан
вызываться в правильном порядке, с начала и ровно один раз. Сервис не в том положении,
чтобы это гарантировать: движок может повторить запрос, а запросы могут прийти
одновременно. Функция без состояния от `(сид, i)` ко всему этому невосприимчива, а писать
её не сложнее.

### Ловушка: 32 бита на четырёх языках

Чтобы все четыре сошлись, должна сойтись арифметика. Именно здесь ломается наивный перенос,
и лечится это одной строкой на язык:

| Язык | Что удерживает хеш в 32 битах |
| :--- | :--- |
| Node | `Math.imul(h, prime) >>> 0` — обычное `*` прошло бы через double и потеряло младшие биты |
| Python | `& 0xFFFFFFFF` — целые здесь неограниченной длины, само ничего не переполнится |
| Java | ничего — умножение `int` уже заворачивается |
| C# | `unchecked { … }` — вне него .NET на переполнении *бросает исключение*, а не заворачивает |

Пропустите это в Python — числа будут расти бесконечно и тихо дадут значения, отличные от
остальных. Движку TDC приходится решать ровно ту же задачу: его генератор случайных
чисел написан через `Math.imul` и 32-битные операции именно ради того, чтобы биндинги на
все реализации совпадали, — так что ограничение это не выдумка примера.

Четыре реализации выше были запущены и сверены:

`shasum -a 256 out.*.txt`

```
875cd44fe86e15d7  out.cs.txt
875cd44fe86e15d7  out.java.txt
875cd44fe86e15d7  out.node.txt
875cd44fe86e15d7  out.py.txt
```

Идентичны, а не «похожи». Если переносите это на пятый язык — сделайте ту же
проверку, прежде чем доверять.

### Обработчик обычно воспроизводим и так

Стоит заметить: `luhn()` вообще не трогает сид. Обработчик считает ответ **из того
значения, что вы ему прислали**, то есть он чистая функция по своей природе: тот же вход —
тот же выход, в любом прогоне. Работать ради воспроизводимости приходится только режиму
**источника**.

## Прежде чем направлять на него TDC

Короткий список, и каждый пункт взят из того, как этот генератор ломается на деле:

- **Отвечайте ровно `N` строками.** Одной больше или меньше — и прогон встанет с
  `returned N line(s) for a batch of M`. Проверка существует потому, что расхождение в
  длине означает: ответы больше не совпадают со строками, иначе была бы тихая порча.
- **Держите порядок.** Строка _i_ ответа должна отвечать строке _i_ запроса. Перестановку
  TDC обнаружить не может — вы просто получите неверные данные.
- **В значениях не должно быть перевода строки**, ни туда, ни обратно: протокол
  построчный, и перенос внутри значения ломает счёт. Падает громко, а не портит, — но
  падает.
- **Будьте безопасны при одновременных вызовах** либо запускайте генерацию с `--jobs 1`.
  Своих воркеров TDC за вас не согласует.
- **Обрабатывайте всю пачку одним запросом.** Не разворачивайте её внутри в вызов на
  каждое значение — именно пачка держит скорость.

## См. также

- [Генератор `http`](../generators/http.md#top) — атрибуты, контракт, режимы отказа
- [Коды ошибок](../reference/errors.md#top) — `TDC065`–`TDC068`

---

← Назад: [Большие объёмы](./large-outputs.md#top) · **[Оглавление](../README.md#top)** · Вперёд: [Обзор](../data-packs/overview.md#top) →
