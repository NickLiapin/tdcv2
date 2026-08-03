<a name="top"></a>

[English](../../core-concepts/quick-api.md#top) · [Русский](../../ru/core-concepts/quick-api.md#top) · **Español**

📖 **[Abrir en el sitio de documentación →](https://nickliapin.github.io/tdcv2/es/docs/core-concepts/quick-api)**

← Anterior: [Determinismo y proporciones](./determinism.md#top) · **[Contenido](../README.md#top)** · Siguiente: [Descripción general](../generators/overview.md#top) →

---

# Un valor a la vez

A veces no quiere un conjunto de datos. Quiere un apellido, aquí, en esta línea de una
prueba: el trabajo que hace una librería tipo faker. TDC lo responde desde los mismos
paquetes de datos que usan las configuraciones, así que el nombre de su prueba unitaria
y el de su fixture de un millón de filas salen de la misma lista.

```ts
import { tdc } from 'tdcv2';

tdc.person.lastName(); // Jones
```

Ese es todo el API. Lo que sigue es esa misma llamada con algo delante.

> [!NOTE]
> **Este es el cajón de valores sueltos**
>
> Cada llamada es independiente. Nada aquí ata un valor a otro: ni `parent=`, ni
> `<switch>` sobre una columna sorteada, ni `uniq`, ni `<compute>`. Un **registro
> coherente** es una configuración; vea [Su primer conjunto de
> datos](../getting-started/first-data.md#top). Use esto cuando los valores de verdad no
> necesiten concordar entre sí.

## Una regla: un punto es un punto

`person.male.firstName` en su código es `person.male.firstName` en una configuración y
en la referencia. No hay un segundo vocabulario que aprender.

```ts
tdc.person.lastName(); // Jones
tdc.person.male.firstName(); // Robert
tdc.person.female.firstName(); // Linda
tdc.company.industry(); // Pharmaceuticals
tdc.color.name(); // Emerald
tdc.food.dish(); // Chicken Tikka Masala
```

Una dirección sin prefijo se lee contra la **configuración regional activa**, igual que
en una configuración. En `en` obtiene `Jones`; cambie la locale y la misma línea le da
un apellido ruso.

## Nombrar un paquete directamente

Tres prefijos alcanzan más allá de la locale activa. Son las mismas palabras que usa una
configuración y no cargan significado propio: existen para que la lista de autocompletado
en `tdc.` siga siendo una lista de categorías y no un muro de 122 códigos.

| Prefijo             | Alcanza                                           | Ejemplo                         |
| :------------------ | :------------------------------------------------ | :------------------------------ |
| _(ninguno)_         | la locale activa                                  | `tdc.person.lastName()`         |
| `common.`           | el paquete compartido, igual en todos los idiomas | `tdc.common.id.uuid()`          |
| `country.<código>.` | el paquete de un país                             | `tdc.country.usa.docs.ssn()`    |
| `lang.<código>.`    | el paquete de un idioma                           | `tdc.lang.ru.person.lastName()` |

```ts
tdc.common.id.uuid(); // 3ff6ff76-6ea7-4fad-8b99-3075a14cc7e9
tdc.common.internet.email(); // u99o89qpeo@test-qu8y3h.invalid
tdc.common.finance.iban(); // DE62299399441396459682
tdc.common.finance.currency(); // Swedish Krona

tdc.country.usa.docs.ssn(); // 699209702
tdc.country.usa.finance.aba_routing(); // 659939946
```

Esos dos identificadores no solo parecen reales: llevan dígitos de control de verdad,
los mismos que produciría una configuración.

> [!TIP]
> **Una dirección no instalada lo dice**
>
> `common`, `en` y el paquete de EE. UU. vienen con el paquete npm. Todo lo demás está a
> una descarga, y pedirlo antes de tenerlo devuelve un error con nombre, no un vacío:
>
> ```ts
> tdc.lang.ru.person.lastName();
> // TdcQuickError: unknown address "ru.person.lastName" (locale "en")
> ```
>
> ```bash
> npx tdcv2 init
> npx tdcv2 pack add ru
> ```
>
> Vea [Instalar paquetes](../data-packs/installing-packs.md#top).

## Varios de una vez

Añada `.many(n)` en lugar de llamar en un bucle: es un sorteo de `n` valores, no `n`
sorteos de uno.

```ts
tdc.person.lastName.many(5);
// [ 'Bush', 'Armstrong', 'Andrews', 'Jimenez', 'Long' ]
```

## Hacer que se repita

Por defecto cada llamada es nueva, que es lo que quiere en un script de borrador. Fije
una semilla y los valores pasan a ser parte de la prueba en vez de una variable dentro
de ella:

```ts
const t = tdc.seed('demo');
t.person.lastName(); // Jones, hoy y el año que viene
```

`seed()` y `locale()` devuelven un objeto **nuevo** en lugar de cambiar aquel sobre el
que los llamó, así que dos pruebas pueden sostener semillas distintas a la vez:

```ts
const ru = tdc.seed('fixtures').locale('ru');
const en = tdc.seed('fixtures').locale('en');
```

## Generadores sin paquete

`tdc.gen.<tipo>` llega a los generadores directamente, para los valores que salen de una
regla y no de una lista.

```ts
tdc.gen.number('18..80'); // 66
tdc.gen.regex('[A-Z]{2}-[0-9]{4}'); // FZ-3994
```

Cada generador y sus atributos están en [la referencia de
generadores](../generators/number.md#top).

## Los valores siempre son cadenas

Números y fechas incluidos. El mundo del motor es texto — eso es lo que permite que una
configuración produzca CSV, SQL y JSON sin cambiar — y un tipo de retorno que variara con
la dirección rompería tanto el autocompletado como las otras cuatro implementaciones.
Convierta en el sitio de la llamada:

```ts
const age = Number(tdc.gen.number('18..80'));
```

## Cuándo usar una configuración

Recurra a una configuración en cuanto dos valores tengan que concordar: una ciudad que
pertenece a su país, un total de pedido que cuadra con sus líneas, un 30% que tiene que
ser exactamente 30%. De eso trata el resto de esta documentación, y empieza en [Su
primer conjunto de datos](../getting-started/first-data.md#top).

## Vea también

- **[TypeScript](../bindings/typescript.md#top)** — la clase `TDC`, para conjuntos completos.
- **[Paquetes de datos](../data-packs/overview.md#top)** — qué es un paquete y cómo se organizan las direcciones.
- **[Instalar paquetes](../data-packs/installing-packs.md#top)** — cómo añadir los otros 120.

---

← Anterior: [Determinismo y proporciones](./determinism.md#top) · **[Contenido](../README.md#top)** · Siguiente: [Descripción general](../generators/overview.md#top) →

📖 **[Abrir en el sitio de documentación →](https://nickliapin.github.io/tdcv2/es/docs/core-concepts/quick-api)**
