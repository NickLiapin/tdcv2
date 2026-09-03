<a name="top"></a>

[English](../../getting-started/quick-api.md#top) · [Русский](../../ru/getting-started/quick-api.md#top) · **Español**

📖 **[Abrir en el sitio de documentación →](https://nickliapin.github.io/tdcv2/es/docs/getting-started/quick-api)**

← Anterior: [Instalación](./installation.md#top) · **[Contenido](../README.md#top)** · Siguiente: [Su primer conjunto de datos](./first-data.md#top) →

---

# Quick API — un valor a la vez

A veces no quiere un conjunto de datos. Quiere un apellido, aquí, en esta línea de una
prueba: el trabajo que hace una librería tipo faker. TDC lo responde desde los mismos
paquetes de datos que usan las configuraciones, así que el nombre de su prueba unitaria
y el de su fixture de un millón de filas salen de la misma lista.

Las cinco implementaciones lo tienen, y con la misma semilla cada una devuelve el mismo
valor:

#### TypeScript

```typescript
import { tdc } from 'tdcv2';

tdc.person.lastName(); // Jones
```

#### Python

```python
from tdcv2 import tdc

tdc.person.lastName()  # Jones
```

#### Java

```java
import io.github.nickliapin.tdc.quick.Quick;

Quick tdc = Quick.tdc();

tdc.get("person.lastName");  // Jones
```

#### C#

```csharp
using Tdcv2.Quick;

dynamic tdc = Quick.Tdc;

tdc.person.lastName();  // Jones
```

#### Rust

```rust
use tdcv2::quick::Quick;

let mut tdc = Quick::new();

tdc.get("person.lastName")?;  // Jones
```

Ese es todo el API. Lo que sigue es esa misma llamada con algo delante.

Cada valor de esta página se sorteó con la semilla `demo`, así que puede reproducirlo.
Sin semilla cada llamada es nueva; la semilla aparece en [Hacer que se
repita](#hacer-que-se-repita).

> [!NOTE]
> **Este es el cajón de valores sueltos**
>
> Cada llamada es independiente. Nada aquí ata un valor a otro: ni `parent=`, ni
> `<switch>` sobre una columna sorteada, ni `uniq`, ni `<compute>`. Un **registro
> coherente** es una configuración; vea [Su primer conjunto de
> datos](first-data.md#top). Use esto cuando los valores de verdad no
> necesiten concordar entre sí.

## Una regla: un punto es un punto

`person.male.firstName` en su código es `person.male.firstName` en una configuración y
en la referencia. No hay un segundo vocabulario que aprender.

#### TypeScript

```typescript
tdc.person.lastName(); // Jones
tdc.person.male.firstName(); // Robert
tdc.person.female.firstName(); // Linda
tdc.company.industry(); // Pharmaceuticals
tdc.color.name(); // Emerald
tdc.food.dish(); // Chicken Tikka Masala
```

#### Python

```python
tdc.person.lastName()          # Jones
tdc.person.male.firstName()    # Robert
tdc.person.female.firstName()  # Linda
tdc.company.industry()         # Pharmaceuticals
tdc.color.name()               # Emerald
tdc.food.dish()                # Chicken Tikka Masala
```

#### Java

```java
tdc.get("person.lastName");          // Jones
tdc.get("person.male.firstName");    // Robert
tdc.get("person.female.firstName");  // Linda
tdc.get("company.industry");         // Pharmaceuticals
tdc.get("color.name");               // Emerald
tdc.get("food.dish");                // Chicken Tikka Masala
```

#### C#

```csharp
tdc.person.lastName();          // Jones
tdc.person.male.firstName();    // Robert
tdc.person.female.firstName();  // Linda
tdc.company.industry();         // Pharmaceuticals
tdc.color.name();               // Emerald
tdc.food.dish();                // Chicken Tikka Masala
```

#### Rust

```rust
tdc.get("person.lastName")?;          // Jones
tdc.get("person.male.firstName")?;    // Robert
tdc.get("person.female.firstName")?;  // Linda
tdc.get("company.industry")?;         // Pharmaceuticals
tdc.get("color.name")?;               // Emerald
tdc.get("food.dish")?;                // Chicken Tikka Masala
```

Los segmentos se escriben como los escriben los paquetes, camelCase incluido, tanto en
Python y C# como en TypeScript. No son nombres que la librería eligiera; renombrarlos
por idioma sería un segundo vocabulario que mantener al día con la referencia, con una
configuración y con las otras cuatro implementaciones.

Una dirección sin prefijo se lee contra la **locale activa**, igual que en una
configuración. En `en` obtiene `Jones`; cambie la locale y la misma línea le da un
apellido ruso.

> [!NOTE]
> **Dos escrituras, una dirección**
>
> TypeScript, Python y C# recorren la dirección como miembros —`tdc.person.lastName()`—
> porque cada uno de esos lenguajes sabe responder por un miembro que no existe hasta que
> se lo piden. Java y Rust toman la dirección como cadena.
>
> Es una decisión, no una carencia. La forma con miembros necesita un método generado por
> dirección, y una superficie generada solo puede cubrir los paquetes que van dentro del
> artefacto. La mayoría de los paquetes se descarga en tiempo de ejecución, así que un
> `tdc.lang().ru()` generado no existiría para un paquete instalado hace un minuto,
> mientras que `get("ru.person.lastName")` funciona en cuanto termina la descarga.

## Nombrar un paquete directamente

Una dirección puede alcanzar más allá de la locale activa y nombrar un paquete. Java y
Rust escriben esa dirección tal cual. TypeScript, Python y C# le anteponen `common`,
`country` o `lang`: dentro de una dirección esas tres palabras no cargan significado, y
existen para que la lista de autocompletado en `tdc.` siga siendo una lista de
categorías y no un muro de 122 códigos de paquete.

| Alcanza                                           | TypeScript, Python, C#          | Java, Rust             |
| :------------------------------------------------ | :------------------------------ | :--------------------- |
| la locale activa                                  | `tdc.person.lastName()`         | `"person.lastName"`    |
| el paquete compartido, igual en todos los idiomas | `tdc.common.id.uuid()`          | `"common.id.uuid"`     |
| el paquete de un país                             | `tdc.country.usa.docs.ssn()`    | `"usa.docs.ssn"`       |
| el paquete de un idioma                           | `tdc.lang.ru.person.lastName()` | `"ru.person.lastName"` |

#### TypeScript

```typescript
tdc.common.id.uuid(); // 3ff6ff76-6ea7-4fad-8b99-3075a14cc7e9
tdc.common.internet.email(); // u99o89qpeo@test-qu8y3h.invalid
tdc.common.finance.iban(); // DE62299399441396459682
tdc.common.finance.currency(); // Swedish Krona

tdc.country.usa.docs.ssn(); // 699209702
tdc.country.usa.finance.aba_routing(); // 659939946
```

#### Python

```python
tdc.common.id.uuid()                   # 3ff6ff76-6ea7-4fad-8b99-3075a14cc7e9
tdc.common.internet.email()            # u99o89qpeo@test-qu8y3h.invalid
tdc.common.finance.iban()              # DE62299399441396459682
tdc.common.finance.currency()          # Swedish Krona

tdc.country.usa.docs.ssn()             # 699209702
tdc.country.usa.finance.aba_routing()  # 659939946
```

#### Java

```java
tdc.get("common.id.uuid");              // 3ff6ff76-6ea7-4fad-8b99-3075a14cc7e9
tdc.get("common.internet.email");       // u99o89qpeo@test-qu8y3h.invalid
tdc.get("common.finance.iban");         // DE62299399441396459682
tdc.get("common.finance.currency");     // Swedish Krona

tdc.get("usa.docs.ssn");                // 699209702
tdc.get("usa.finance.aba_routing");     // 659939946
```

#### C#

```csharp
tdc.common.id.uuid();                   // 3ff6ff76-6ea7-4fad-8b99-3075a14cc7e9
tdc.common.internet.email();            // u99o89qpeo@test-qu8y3h.invalid
tdc.common.finance.iban();              // DE62299399441396459682
tdc.common.finance.currency();          // Swedish Krona

tdc.country.usa.docs.ssn();             // 699209702
tdc.country.usa.finance.aba_routing();  // 659939946
```

#### Rust

```rust
tdc.get("common.id.uuid")?;             // 3ff6ff76-6ea7-4fad-8b99-3075a14cc7e9
tdc.get("common.internet.email")?;      // u99o89qpeo@test-qu8y3h.invalid
tdc.get("common.finance.iban")?;        // DE62299399441396459682
tdc.get("common.finance.currency")?;    // Swedish Krona

tdc.get("usa.docs.ssn")?;               // 699209702
tdc.get("usa.finance.aba_routing")?;    // 659939946
```

Esos dos identificadores no solo parecen reales: llevan dígitos de control de verdad,
los mismos que produciría una configuración.

## Una dirección no instalada lo dice

`common`, `en` y el paquete de EE. UU. vienen dentro de las cinco entregas. Todo lo
demás está a una descarga, y pedirlo antes de tenerlo devuelve un fallo con nombre, no
un vacío:

#### TypeScript

```typescript
tdc.lang.ru.person.lastName();
// TdcQuickError: the "ru" pack is not installed, so "ru.person.lastName" cannot be
// drawn. Install it with `tdcv2 pack add ru` (run `tdcv2 init` once first, to say
// where packs go).
```

#### Python

```python
tdc.lang.ru.person.lastName()
# TdcQuickError: the "ru" pack is not installed, so "ru.person.lastName" cannot be
# drawn. Install it with `tdcv2 pack add ru` (run `tdcv2 init` once first, to say
# where packs go).
```

#### Java

```java
tdc.get("ru.person.lastName");
// TdcQuickException: the "ru" pack is not installed, so "ru.person.lastName" cannot
// be drawn. Install it with `java -jar tdcv2-cli.jar pack add ru` — or `tdcv2 pack
// add ru` if you have aliased the CLI jar — after `java -jar tdcv2-cli.jar init`
// once, to say where packs go.
```

#### C#

```csharp
tdc.lang.ru.person.lastName();
// TdcQuickException: the "ru" pack is not installed, so "ru.person.lastName" cannot
// be drawn. Install it with `tdcv2 pack add ru` (run `tdcv2 init` once first, to say
// where packs go).
```

#### Rust

```rust
tdc.get("ru.person.lastName");
// Err(QuickError): the "ru" pack is not installed, so "ru.person.lastName" cannot be
// drawn. Install it with `tdcv2 pack add ru` (run `tdcv2 init` once first, to say
// where packs go).
```

Solo cambia la redacción de Java, y solo porque Maven no deja nada en el `PATH`:
aconsejar que ejecute `tdcv2` sería un consejo que un lector de Java no puede teclear.
La línea de comandos en sí es la misma en las cinco. Vea [Instalar
paquetes](../data-packs/installing-packs.md#top).

Un segmento mal escrito es otro fallo, y lo dice: `person.lastNam` vuelve como `unknown
address "person.lastNam" (locale "en"). Did you mean "en.person.lastName"?`

## Varios de una vez

Pida `n` valores en una sola llamada en lugar de llamar en un bucle: es un sorteo de `n`
valores, no `n` sorteos de uno.

#### TypeScript

```typescript
tdc.person.lastName.many(5);
// [ 'Jones', 'Bush', 'Armstrong', 'Andrews', 'Jimenez' ]
```

#### Python

```python
tdc.person.lastName.many(5)
# ['Jones', 'Bush', 'Armstrong', 'Andrews', 'Jimenez']
```

#### Java

```java
List<String> names = tdc.many("person.lastName", 5);
// [Jones, Bush, Armstrong, Andrews, Jimenez]
```

#### C#

```csharp
IReadOnlyList<string> names = tdc.person.lastName.many(5);
// Jones, Bush, Armstrong, Andrews, Jimenez
```

#### Rust

```rust
let names = tdc.many("person.lastName", 5)?;
// ["Jones", "Bush", "Armstrong", "Andrews", "Jimenez"]
```

## Hacer que se repita

Por defecto cada llamada es nueva, que es lo que quiere en un script de borrador. Fije
una semilla y los valores pasan a ser parte de la prueba en vez de una variable dentro
de ella. Fijar una semilla además devuelve un objeto **nuevo** en lugar de cambiar aquel
sobre el que la llamó, así que dos pruebas pueden sostener semillas distintas a la vez.

#### TypeScript

```typescript
const t = tdc.seed('demo');
t.person.lastName(); // Jones, hoy y el año que viene

const ru = tdc.seed('fixtures').locale('ru');
const en = tdc.seed('fixtures').locale('en');
ru.person.lastName(); // Романенко
en.person.lastName(); // Pearson
```

#### Python

```python
t = tdc.seed("demo")
t.person.lastName()   # Jones, hoy y el año que viene

ru = tdc.seed("fixtures").locale("ru")
en = tdc.seed("fixtures").locale("en")
ru.person.lastName()  # Романенко
en.person.lastName()  # Pearson
```

#### Java

```java
Quick t = Quick.seeded("demo");
t.get("person.lastName");   // Jones, hoy y el año que viene

Quick ru = Quick.seeded("fixtures").locale("ru");
Quick en = Quick.seeded("fixtures").locale("en");
ru.get("person.lastName");  // Романенко
en.get("person.lastName");  // Pearson
```

#### C#

```csharp
dynamic t = Quick.Seed("demo");
t.person.lastName();   // Jones, hoy y el año que viene

dynamic ru = Quick.Seed("fixtures").locale("ru");
dynamic en = Quick.Seed("fixtures").locale("en");
ru.person.lastName();  // Романенко
en.person.lastName();  // Pearson
```

#### Rust

```rust
let mut t = Quick::seeded("demo");
t.get("person.lastName")?;   // Jones, hoy y el año que viene

let mut ru = Quick::seeded("fixtures").locale("ru");
let mut en = Quick::seeded("fixtures").locale("en");
ru.get("person.lastName")?;  // Романенко
en.get("person.lastName")?;  // Pearson
```

## Generadores sin paquete

Los generadores propios del motor también están al alcance, para los valores que salen
de una regla y no de una lista. Toman atributos en vez de una dirección, así que viven
bajo un nombre propio: las categorías de los paquetes ya se llaman `date`, `text` y
`word`, con lo que el nivel superior está ocupado.

#### TypeScript

```typescript
tdc.gen.number('18..80'); // 66
tdc.gen.regex('[A-Z]{2}-[0-9]{4}'); // FZ-3994
```

#### Python

```python
tdc.gen.number("18..80")             # 66
tdc.gen.regex("[A-Z]{2}-[0-9]{4}")   # FZ-3994
```

#### Java

```java
tdc.gen("number", "18..80");            // 66
tdc.gen("regex", "[A-Z]{2}-[0-9]{4}");  // FZ-3994
```

#### C#

```csharp
tdc.gen.number("18..80");            // 66
tdc.gen.regex("[A-Z]{2}-[0-9]{4}");  // FZ-3994
```

#### Rust

```rust
tdc.gen("number", &[("value", "18..80")])?;            // 66
tdc.gen("regex", &[("value", "[A-Z]{2}-[0-9]{4}")])?;  // FZ-3994
```

La cadena es una forma corta de `value=`. Pase un **objeto** para llegar a todos los demás
atributos, y `.many(n, …)` funciona en generadores igual que en direcciones:

```typescript
tdc.gen.date({ from: '2020-01-01', to: '2020-12-31', format: 'DD.MM.YYYY' }); // 11.10.2020
tdc.gen.number({ distribution: 'normal', mean: '170', sd: '10' }); // 172
tdc.gen.number.many(5, '1..9'); // [ '7', '6', '8', '6', '3' ]
tdc.gen.number('50'); // siempre '50' — un número es un valor, no un rango
tdc.gen.number('10,20,35'); // uno de los tres
```

Una dirección toma parámetros de la misma forma, cuando el paquete declara alguno — `tdc.country.usa.finance.aba_routing({ prefix: '12' })` fija los dos primeros dígitos y deja que el paquete genere y verifique el resto. Una dirección que no declara ninguno rechaza un parámetro desconocido por su nombre en lugar de ignorarlo.

Cada generador y sus atributos están en [la referencia de
generadores](../generators/number.md#top).

## Los valores siempre son cadenas

Números y fechas incluidos. El mundo del motor es texto — eso es lo que permite que una
configuración produzca CSV, SQL y JSON sin cambiar — y un tipo de retorno que variara
con la dirección sería un contrato distinto en cada una de las cinco. Convierta en el
sitio de la llamada cuando necesite un número:

#### TypeScript

```typescript
const age = Number(tdc.gen.number('18..80'));
```

#### Python

```python
age = int(tdc.gen.number("18..80"))
```

#### Java

```java
int age = Integer.parseInt(tdc.gen("number", "18..80"));
```

#### C#

```csharp
int age = int.Parse(tdc.gen.number("18..80"));
```

#### Rust

```rust
let age: u32 = tdc.gen("number", &[("value", "18..80")])?.parse()?;
```

## Cuándo usar una configuración

Recurra a una configuración en cuanto dos valores tengan que concordar: una ciudad que
pertenece a su país, un total de pedido que cuadra con sus líneas, un 30% que tiene que
ser exactamente 30%. De eso trata el resto de esta documentación, y empieza en [Su
primer conjunto de datos](first-data.md#top).

## Vea también

- **[TypeScript](../bindings/typescript.md#top)**, **[Python](../bindings/python.md#top)**, **[Java](../bindings/java.md#top)**, **[C#](../bindings/csharp.md#top)**, **[Rust](../bindings/rust.md#top)** — los mismos cinco paquetes, para conjuntos completos.
- **[Paquetes de datos](../data-packs/overview.md#top)** — qué es un paquete y cómo se organizan las direcciones.
- **[Instalar paquetes](../data-packs/installing-packs.md#top)** — cómo añadir los otros 120.

---

← Anterior: [Instalación](./installation.md#top) · **[Contenido](../README.md#top)** · Siguiente: [Su primer conjunto de datos](./first-data.md#top) →

📖 **[Abrir en el sitio de documentación →](https://nickliapin.github.io/tdcv2/es/docs/getting-started/quick-api)**
