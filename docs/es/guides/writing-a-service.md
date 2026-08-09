<a name="top"></a>

[English](../../guides/writing-a-service.md#top) · [Русский](../../ru/guides/writing-a-service.md#top) · **Español**

📖 **[Abrir en el sitio de documentación →](https://nickliapin.github.io/tdcv2/es/docs/guides/writing-a-service)**

← Anterior: [Salidas grandes y streaming](./large-outputs.md#top) · **[Contenido](../README.md#top)** · Siguiente: [Rendimiento](./performance.md#top) →

---

# Escribir un generador de servicio

El [generador `http`](../generators/http.md#top) deja que un servicio escrito por usted
decida los valores. Esta página es la otra mitad: **cómo escribir ese servicio**, en
cualquiera de cinco lenguajes, de modo que sea rápido, correcto y — la parte que todos
fallan — **reproducible**.

Abajo hay un servicio funcionando por lenguaje. Cada uno cubre los dos modos: inventa
números de cuenta cuando le piden valores, y agrega un dígito de control de Luhn cuando le
entregan valores para procesar.

## Qué debe hacer el servicio

El contrato completo está en la [página del generador](../generators/http.md#el-contrato-que-implementa-su-servicio).
Para escribir uno bastan cuatro líneas de él:

- llega un **`POST`** con `X-TDC-Count: N` y `X-TDC-Seed: <hex>`;
- el **cuerpo** son `N` valores, uno por línea — o está **vacío**, lo que significa «invéntelos»;
- responda con exactamente **`N` líneas**, en el mismo orden;
- texto plano, no hace falta JSON en ninguna parte.

## El servicio, en cinco lenguajes

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

Ejecútelo con `node service.mjs` y apunte `src` a `http://127.0.0.1:5701/`.

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

Ejecútelo con `python3 service.py` y apunte `src` a `http://127.0.0.1:5702/`.

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

Ejecútelo con `javac Service.java && java Service` y apunte `src` a
`http://127.0.0.1:5703/`.

#### C#

```csharp
using System.Net;
using System.Text;

// FNV-1a (32 bits). C# necesita `unchecked`: su int no se desborda solo.
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

// Modo fuente: una cuenta de 8 dígitos para la fila `i`, decidida solo por (seed, i).
static string AccountFor(string seed, int i) =>
    ((uint)Fnv1a($"{seed}#{i}") % 100000000L).ToString("D8");

// Modo manejador: el dígito de control de Luhn de lo que llegó.
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
        ? Enumerable.Range(0, count).Select(i => AccountFor(seed, i))   // fuente
        : body.Split('\n').Select(line => line + Luhn(line));           // manejador

    byte[] payload = Encoding.UTF8.GetBytes(string.Join("\n", lines));
    ctx.Response.ContentType = "text/plain";
    ctx.Response.ContentLength64 = payload.Length;
    ctx.Response.OutputStream.Write(payload);
    ctx.Response.Close();
}
```

Ejecútelo con `dotnet run` y apunte `src` a `http://127.0.0.1:5704/`.

#### Rust

```rust
use std::io::{BufRead, BufReader, Read, Write};
use std::net::TcpListener;

/// FNV-1a (32-bit). The same three lines in every language — that is the point.
fn fnv1a(text: &str) -> u32 {
    let mut h: u32 = 0x811c9dc5;
    for b in text.bytes() {
        h ^= u32::from(b);
        h = h.wrapping_mul(0x01000193); // wrapping_mul keeps it 32-bit
    }
    h
}

/// Source mode: an 8-digit account for row `i`, decided only by (seed, i).
fn account_for(seed: &str, i: usize) -> String {
    format!("{:08}", fnv1a(&format!("{seed}#{i}")) % 100_000_000)
}

/// Handler mode: the Luhn check digit of what was sent.
fn luhn(number: &str) -> String {
    let (mut sum, mut dbl) = (0u32, true);
    for ch in number.chars().rev() {
        let Some(d) = ch.to_digit(10) else { continue };
        let d = if dbl && d * 2 > 9 {
            d * 2 - 9
        } else if dbl {
            d * 2
        } else {
            d
        };
        sum += d;
        dbl = !dbl;
    }
    ((10 - sum % 10) % 10).to_string()
}

fn main() -> std::io::Result<()> {
    let listener = TcpListener::bind("127.0.0.1:5705")?;
    for stream in listener.incoming() {
        let mut stream = stream?;
        let mut reader = BufReader::new(stream.try_clone()?);

        let (mut length, mut count, mut seed) = (0usize, 0usize, String::new());
        loop {
            let mut line = String::new();
            if reader.read_line(&mut line)? == 0 || line == "\r\n" {
                break;
            }
            let Some((name, value)) = line.split_once(':') else { continue };
            match name.to_ascii_lowercase().as_str() {
                "content-length" => length = value.trim().parse().unwrap_or(0),
                "x-tdc-count" => count = value.trim().parse().unwrap_or(0),
                "x-tdc-seed" => seed = value.trim().to_string(),
                _ => {}
            }
        }

        let mut body = vec![0u8; length];
        reader.read_exact(&mut body)?;
        let body = String::from_utf8_lossy(&body);

        let out: Vec<String> = if body.is_empty() {
            (0..count).map(|i| account_for(&seed, i)).collect()  // source
        } else {
            body.split('\n')
                .map(|line| format!("{line}{}", luhn(line)))     // handler
                .collect()
        };

        let payload = out.join("\n");
        write!(
            stream,
            "HTTP/1.1 200 OK\r\nContent-Type: text/plain\r\nContent-Length: {}\r\n\r\n{payload}",
            payload.len()
        )?;
    }
    Ok(())
}
```

Ejecútelo con `cargo run` y apunte `src` a `http://127.0.0.1:5705/`. Sin ninguna
dependencia: `wrapping_mul` da la aritmética de 32 bits que FNV-1a necesita.

Cualquiera de los cinco, contra el mismo config:

<!-- doc-check: skip needs one of this page's own services listening on 127.0.0.1:5701 -->

```xml
<tdc>
  <env count="3" seed="demo">
    <sequence name="Payload"><gen type="number" value="10000000..99999999"/></sequence>
    <sequence name="Card"><gen type="http" src="http://127.0.0.1:5701/" in="Payload"/></sequence>
    <sequence name="Acct"><gen type="http" src="http://127.0.0.1:5701/"/></sequence>
  </env>
  <block>
    <line><data>${{Payload}} -> ${{Card}}   |  cuenta: ${{Acct}}</data></line>
  </block>
</tdc>
```

`./run demo.tdc`

```
10047634 -> 100476340   |  cuenta: 71102997
48577070 -> 485770705   |  cuenta: 54325378
44149883 -> 441498839   |  cuenta: 37547759
```

`Card` pasó por el manejador — la carga volvió con su dígito de control. `Acct` se inventó
solo a partir de la semilla. Cambie el puerto por 5702, 5703, 5704 o 5705 y la salida es
carácter por carácter la misma.

## Reproducibilidad: para qué sirve la semilla

El generador `http` es el único lugar donde TDC [cede su garantía](../generators/http.md#lo-que-no-promete):
el servicio decide los valores, así que el motor no puede prometer que volver a correr
reproduzca. **Su servicio sí puede prometerlo**, y `X-TDC-Seed` es lo que lo hace posible.

La regla cabe en una línea: **derive cada valor de la semilla, nunca de un reloj ni de un
generador de números aleatorios.**

```js
accountFor(seed, i); // reproducible — same seed, same row, same answer
Math.random(); // not
new Date(); // not
```

La semilla que envía TDC es estable entre corridas y **distinta para cada secuencia**, así
que dos secuencias `http` apuntadas al mismo servicio nunca reciben el mismo flujo.

Escrito así, la corrida se reproduce:

`./run demo.tdc — dos veces`

```
corrida 1:  71102997  54325378  37547759
corrida 2:  71102997  54325378  37547759
```

### Calcule cada fila directamente, no itere

Fíjese en la forma de `accountFor(seed, i)`: toma el **índice de fila** y devuelve el
valor de esa fila, sin arrastrar estado entre llamadas. Es deliberado, y conviene copiarlo.

Un generador que recorre una secuencia — «llame a `next()` N veces» — tiene que llamarse
en el orden correcto, desde el principio, exactamente una vez. Un servicio no está en
posición de garantizar nada de eso: el motor puede reintentar una petición, y las
peticiones pueden llegar a la vez. Una función sin estado de `(seed, i)` es inmune a todo
ello, y no cuesta más escribirla.

### La trampa: 32 bits en cinco lenguajes

Para que los cinco coincidan, tiene que coincidir la aritmética. Aquí es donde se rompe un
port ingenuo, y se arregla con una línea por lenguaje:

| Lenguaje | Qué mantiene el hash en 32 bits                                                                     |
| :------- | :-------------------------------------------------------------------------------------------------- |
| Node     | `Math.imul(h, prime) >>> 0` — un `*` normal pasaría por un double y perdería los bits bajos         |
| Python   | `& 0xFFFFFFFF` — los enteros son de precisión arbitraria, nada se desborda solo                     |
| Java     | nada — la multiplicación de `int` ya da la vuelta                                                   |
| C#       | `unchecked { … }` — fuera de ahí, .NET _lanza una excepción_ al desbordarse en vez de dar la vuelta |
| Rust     | `wrapping_mul` — un `*` normal _entra en pánico_ al desbordar en una compilación de depuración      |

Olvídelo en Python y los números crecen sin fin, produciendo en silencio valores distintos
de los demás. El propio motor de TDC tiene que resolver exactamente este problema — su
PRNG está escrito con `Math.imul` y operaciones de 32 bits justamente para que las cinco
implementaciones coincidan — así que la restricción no es un invento de este ejemplo.

Los cinco servicios de arriba se arrancaron y recibieron la misma pregunta — ocho
valores, una semilla — y sus respuestas se compararon:

```bash
for p in 5701 5702 5703 5704 5705; do
  curl -s -X POST -H "X-TDC-Count: 8" -H "X-TDC-Seed: demo" --data-binary "" \
    http://127.0.0.1:$p/ > out.$p.txt
done
```

`shasum -a 256 out.*.txt`

```
1d7bf9b2a4ef1ded8558cc0afd0ef18d15321a9da2398dc72c87cb8629c2ca2d  out.node.txt
1d7bf9b2a4ef1ded8558cc0afd0ef18d15321a9da2398dc72c87cb8629c2ca2d  out.py.txt
1d7bf9b2a4ef1ded8558cc0afd0ef18d15321a9da2398dc72c87cb8629c2ca2d  out.java.txt
1d7bf9b2a4ef1ded8558cc0afd0ef18d15321a9da2398dc72c87cb8629c2ca2d  out.cs.txt
1d7bf9b2a4ef1ded8558cc0afd0ef18d15321a9da2398dc72c87cb8629c2ca2d  out.rs.txt
```

Idénticas, no meramente parecidas. Si lo lleva a un sexto lenguaje, haga la misma
comprobación antes de confiar en él.

### El manejador ya suele ser reproducible

Vale la pena notarlo: `luhn()` nunca toca la semilla. Un manejador calcula su respuesta **a
partir del valor que usted le mandó**, así que es una función pura por naturaleza: misma
entrada, misma salida, en cada corrida. Trabajar por la reproducibilidad le toca solo al
modo **fuente**.

## Antes de apuntarle TDC

Una lista corta, y cada punto sale de cómo falla este generador en la práctica:

- **Responda con exactamente `N` líneas.** Una de más o de menos y la corrida se detiene
  con `returned N line(s) for a batch of M`. Esa comprobación existe porque un desajuste de
  longitud significa que las respuestas ya no cuadran con las filas — si no, sería
  corrupción silenciosa.
- **Conserve el orden.** La línea _i_ de la respuesta debe responder a la línea _i_ de la
  petición. TDC no puede detectar un barajado; usted simplemente obtendría datos erróneos.
- **Los valores no deben contener un salto de línea**, en ninguna dirección: el protocolo
  va por líneas, así que un salto incrustado rompe el conteo. Falla ruidosamente en vez de
  corromper, pero falla.
- **Sea seguro ante llamadas concurrentes**, o corra la generación con `--jobs 1`. TDC no
  coordina a sus workers por usted.
- **Atienda todo el lote en una petición.** No lo despliegue internamente en una llamada
  por valor; el lote es lo que mantiene esto rápido.

## Vea también

- [El generador `http`](../generators/http.md#top) — los atributos, el contrato, los modos de fallo
- [Códigos de error](../reference/errors.md#top) — `TDC065`–`TDC068`

---

← Anterior: [Salidas grandes y streaming](./large-outputs.md#top) · **[Contenido](../README.md#top)** · Siguiente: [Rendimiento](./performance.md#top) →

📖 **[Abrir en el sitio de documentación →](https://nickliapin.github.io/tdcv2/es/docs/guides/writing-a-service)**
