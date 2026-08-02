<a name="top"></a>

[English](../../generators/http.md#top) · [Русский](../../ru/generators/http.md#top) · **Español**

← Anterior: [Pattern (dibujo)](./pattern.md#top) · **[Contenido](../README.md#top)** · Siguiente: [Total acumulado](./running.md#top) →

---

# El generador `http`

**Úselo cuando** el valor tiene que venir de una lógica que TDC no tiene: un algoritmo
de dígito de control real que usted ya escribió, una consulta a su propia base, cualquier
cálculo que sería doloroso expresar en el config. Usted levanta un pequeño servicio y TDC
lo llama: el motor se vuelve **cliente** de su servicio, no anfitrión de su código. Ese
es el punto de extensión — cualquier cosa que ponga detrás de un endpoint HTTP se vuelve
parte de sus datos.

## Dos modos: genera, o procesa

Un solo atributo decide cuál, y son trabajos genuinamente distintos:

| | `in` | qué recibe su servicio | qué hace |
| :-- | :-- | :-- | :-- |
| **Fuente** | ausente | nada más que un conteo | inventa los valores él mismo — actúa como generador |
| **Manejador** | presente | sus valores, uno por línea | transforma lo que envió y lo devuelve |

Los dos a la vez, contra el mismo servicio — la primera columna se entrega y vuelve
cambiada, la segunda se saca de la nada:

```xml
<sequence name="City">
  <gen type="text" value="Paris,Berlin,Tokyo" order="sequential"/>
</sequence>

<sequence name="Handled">
  <gen type="http" src="http://127.0.0.1:5599/gen" in="City"/>   <!-- manejador -->
</sequence>

<sequence name="Made">
  <gen type="http" src="http://127.0.0.1:5599/gen"/>             <!-- fuente -->
</sequence>
```

`./run modes.tdc`

```
Paris  ->  [Paris ok]    |  Made: SRC-000
Berlin ->  [Berlin ok]   |  Made: SRC-001
Tokyo  ->  [Tokyo ok]    |  Made: SRC-002
```

El modo manejador es el más útil de los dos, y el más fácil de pasar por alto: deja que
un servicio que usted ya tiene **termine** un valor que TDC empezó — validarlo, agregarle
un dígito de control, buscarlo, traducirlo — en vez de reemplazar el generador entero.

Su servicio distingue los modos por el cuerpo de la petición: **cuerpo vacío es modo
fuente**, y la cabecera `X-TDC-Count` dice cuántos valores inventar.

> [!TIP]
> **Cómo escribir el servicio**
>
> Un servicio completo y funcionando — en **Node, Python y Java**, con ambos modos — y cómo
> hacerlo reproducible a partir del seed, viven en su propia página:
> **[Escribir un generador de servicio](../guides/writing-a-service.md#top)**.

![](../../img/generators/http-flow.svg)

*La columna de entradas se envía en una sola petición; la respuesta vuelve un valor por fila, en el mismo orden. Aquí el servicio pasa cada valor a mayúsculas (a → A).*

- **A** — la columna de entrada — los valores que produjo su secuencia
- **B** — su servicio: TDC solo habla con él, nunca lo ejecuta
- **C** — la respuesta — un valor por fila, en el orden enviado

## Atributos

| Atributo   | Qué define |
| :--------- | :--------- |
| `src`      | la URL del servicio — `http://127.0.0.1:5566/gen` (local, rápido) o un host público. `https` también sirve |
| `in`       | la secuencia cuyo valor se envía en cada fila — esto es lo que convierte al servicio en **manejador**. Omítalo y el servicio es una **fuente**: no recibe nada e inventa cada valor |
| `on_error` | `fail` (por omisión) — detenerse con un mensaje claro; o `empty` — dejar la celda vacía y seguir |
| `timeout`  | segundos a esperar por una respuesta antes de rendirse. Por omisión 30 |

`in` nombra una secuencia **anterior** — se envía el valor que produjo en cada fila.

## El contrato que implementa su servicio

El motor habla un protocolo pequeño y no espera nada más de vuelta:

- **`POST`** a `src`, con una cabecera **`X-TDC-Count: N`** — cuántos valores se quieren.
- El **cuerpo** son los `N` valores de entrada, **uno por línea**, en orden de fila. Sin
  `in`, el cuerpo está vacío y `N` viene de la cabecera.
- La **respuesta** debe ser exactamente **`N` líneas**, en el mismo orden — la línea _i_
  responde a la entrada _i_. Texto plano.

Todo lo estructurado es trabajo de su servicio. Si por dentro trabaja con JSON, devuelve
el único campo que usted quiere, como texto — TDC mantiene todo como cadenas por dentro.

**Una petición por columna, no por fila.** El motor envía todo el lote de una vez, así
que mil filas es una petición. Un servicio escrito «una línea entra, una línea sale»
también funciona: solo recorre en bucle las líneas de la única petición que recibe.

![](../../img/generators/http-batch.svg)

*Por qué mil filas es una petición. La forma por fila (izquierda) serían mil viajes de ida y vuelta; TDC envía toda la columna en uno (derecha).*

- **A** — una petición por fila — lo que TDC NO hace; sería una llamada por valor
- **B** — una petición para toda la columna — todo el lote, un viaje de ida y vuelta

Esto es lo que lo mantiene rápido: el costo es un viaje de ida y vuelta más el trabajo
del propio servicio, no un viaje por valor. También por eso `http` corre en el motor en
memoria y conviene reservarlo para un servicio en su propia máquina, o una corrida que
usted dimensionó a propósito — no mil millones de filas contra un endpoint lejano.

## Un servicio entero, en cuatro lenguajes

Cada uno está completo y responde a **ambos** modos: envuelve lo que usted manda e
inventa valores cuando el cuerpo viene vacío. Elija su lenguaje — se comportan igual.

#### Node.js

```js
import { createServer } from 'node:http';

createServer((req, res) => {
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => {
    const count = Number(req.headers['x-tdc-count'] ?? '0');
    const sent = Buffer.concat(chunks).toString('utf8');

    const out =
      sent === ''
        ? Array.from({ length: count }, (_, i) => 'SRC-' + String(i).padStart(3, '0')) // source
        : sent.split('\n').map((line) => '[' + line + ' ok]'); // handler

    const body = out.join('\n');
    res.writeHead(200, { 'Content-Type': 'text/plain', 'Content-Length': Buffer.byteLength(body) });
    res.end(body);
  });
}).listen(5801, '127.0.0.1');
```

#### Python

```python
from http.server import BaseHTTPRequestHandler, HTTPServer


class H(BaseHTTPRequestHandler):
    def do_POST(self):
        n = int(self.headers.get("Content-Length", 0))
        sent = self.rfile.read(n).decode() if n else ""
        count = int(self.headers.get("X-TDC-Count", "0"))

        if sent == "":
            out = [f"SRC-{i:03d}" for i in range(count)]          # source
        else:
            out = [f"[{line} ok]" for line in sent.split("\n")]   # handler

        body = "\n".join(out).encode()
        self.send_response(200)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)


HTTPServer(("127.0.0.1", 5802), H).serve_forever()
```

#### Java

```java
import com.sun.net.httpserver.HttpServer;
import java.io.OutputStream;
import java.net.InetSocketAddress;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.List;

public class S3 {
    public static void main(String[] args) throws Exception {
        HttpServer server = HttpServer.create(new InetSocketAddress("127.0.0.1", 5803), 0);
        server.createContext("/", exchange -> {
            String sent = new String(exchange.getRequestBody().readAllBytes(),
                                     StandardCharsets.UTF_8);
            String raw = exchange.getRequestHeaders().getFirst("X-TDC-Count");
            int count = Integer.parseInt(raw == null ? "0" : raw);

            List<String> out = new ArrayList<>();
            if (sent.isEmpty()) {
                for (int i = 0; i < count; i++) out.add(String.format("SRC-%03d", i));  // source
            } else {
                for (String line : sent.split("\n", -1)) out.add("[" + line + " ok]");  // handler
            }

            byte[] body = String.join("\n", out).getBytes(StandardCharsets.UTF_8);
            exchange.sendResponseHeaders(200, body.length);
            try (OutputStream os = exchange.getResponseBody()) { os.write(body); }
        });
        server.start();
    }
}
```

#### C#

```csharp
using System.Net;
using System.Text;

var server = new HttpListener();
server.Prefixes.Add("http://127.0.0.1:5804/");
server.Start();

while (true)
{
    HttpListenerContext ctx = server.GetContext();
    using var reader = new StreamReader(ctx.Request.InputStream, Encoding.UTF8);
    string sent = reader.ReadToEnd();
    int count = int.Parse(ctx.Request.Headers["X-TDC-Count"] ?? "0");

    IEnumerable<string> lines = sent.Length == 0
        ? Enumerable.Range(0, count).Select(i => $"SRC-{i:D3}")     // fuente
        : sent.Split('\n').Select(line => $"[{line} ok]");          // manejador

    byte[] body = Encoding.UTF8.GetBytes(string.Join("\n", lines));
    ctx.Response.ContentLength64 = body.Length;
    ctx.Response.OutputStream.Write(body);
    ctx.Response.Close();
}
```

Arranque uno, apunte `src` a su puerto y corra el config de
[Dos modos](#dos-modos-genera-o-procesa) — los cuatro producen la misma salida.

> [!CAUTION]
> **Lea esto antes de escribir el suyo — no es opcional**
>
> Los servicios de arriba son lo más corto que funciona. **No son reproducibles**: corra el
> config dos veces y los valores inventados serán los que al servicio se le ocurran.
>
> **[→ Escribir un generador de servicio](../guides/writing-a-service.md#top)** es la página que
> importa. Allí, con código funcionando en los cuatro lenguajes:
>
> - **cómo hacer que una corrida se reproduzca** usando el `X-TDC-Seed` que TDC le envía —
>   lo único que le devuelve a este generador su garantía;
> - **por qué `valor(seed, i)` y nunca `next()`** — un servicio no puede prometer el orden de
>   las llamadas, y un iterador se rompe en silencio ante reintentos y concurrencia;
> - **la trampa de los 32 bits** que hace que un port ingenuo a Python discrepe de Node y Java;
> - la lista previa al vuelo: conteo exacto de líneas, orden, saltos de línea, concurrencia, lote.
>
> Sáltesela y sus datos se verán bien y no serán reproducibles. Ese es el tipo caro de estar
> equivocado.

## Cuando algo falla

El servicio está fuera del control de TDC, así que los fallos se manejan, no se ocultan:

- **`on_error="fail"`** (el valor por omisión) detiene la corrida con un mensaje que
  nombra la secuencia y el servicio — `http service for sequence "Checked" at … returned
  500`. Una columna en blanco en un archivo terminado es peor sorpresa que una parada
  clara.
- **`on_error="empty"`** deja en blanco la columna afectada y termina, para cuando lo que
  quiere es una salida de mejor esfuerzo. Los huecos los revisa usted.
- **`429` (límite de tasa) siempre detiene**, incluso con `empty`. «Más despacio» y
  «transmitir una columna entera» no se pueden reconciliar, y seguir truncaría los datos
  en silencio.
- Un servicio que **nunca responde** se corta por `timeout` en vez de colgar la corrida.
- Un servicio que **inunda** — respondiendo mucho más que un valor por línea — se corta
  a los 64 MB con un error, en vez de leerse en memoria hasta el final.

## Lo que no promete

Este es el único generador que cede garantías que el resto de TDC mantiene. Dígaselas a
sí mismo antes de recurrir a él:

- **No reproducible.** El servicio decide los valores, así que `seed` no garantiza nada y
  **volver a correr da datos distintos**. Un config que usa `http` nunca se trata como
  reproducible.
- **El orden sigue al servicio**, no al seed.
- **Local o volúmenes modestos.** Por internet, una corrida grande es una gran cantidad
  de llamadas salientes; esto es para un servicio en su propia máquina, o una corrida que
  usted dimensionó a propósito. No para mil millones de filas contra un endpoint público.

## Vea también

- [Escribir un generador de servicio](../guides/writing-a-service.md#top) — servicios funcionando en Node, Python y Java
- [Visión general de generadores](../generators/overview.md#top)
- [Códigos de error](../reference/errors.md#top) — `TDC065`–`TDC068` y los fallos en corrida

---

← Anterior: [Pattern (dibujo)](./pattern.md#top) · **[Contenido](../README.md#top)** · Siguiente: [Total acumulado](./running.md#top) →
