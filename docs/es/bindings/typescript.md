<a name="top"></a>

[English](../../bindings/typescript.md#top) · [Русский](../../ru/bindings/typescript.md#top) · **Español**

📖 **[Abrir en el sitio de documentación →](https://nickliapin.github.io/tdcv2/es/docs/bindings/typescript)**

← Anterior: [Comparación y verdad](../reference/comparison.md#top) · **[Contenido](../README.md#top)** · Siguiente: [Python](./python.md#top) →

---

# TypeScript

El paquete de TypeScript es la implementación de referencia de TDC. El CLI es
estupendo cuando lo que quiere es un archivo; la biblioteca es para obtener datos
**dentro de su código** —como una cadena o como objetos JS vivos— sin lanzar un proceso
ni leer un archivo.

```ts
import { TDC } from "tdcv2";
```

## Cómo crear un `TDC`

El constructor recibe o bien una ruta a un archivo DSL (`configFile`), o bien una
cadena DSL (`configString`). Desde el código se pueden anular los parámetros de
ejecución `seed`, `count`, `locale` y `now`: le ganan a los valores de `<env>`.

```ts
const tdc = new TDC({
  configString: `<tdc>
    <env count="4" seed="demo" local="en">
      <sequence name="Gender"><gen type="text" value="Male,Female"/></sequence>
      <sequence name="MaleName" parent="Gender.Male"><gen type="template" value="person.male.firstName"/></sequence>
      <sequence name="FemaleName" parent="Gender.Female"><gen type="template" value="person.female.firstName"/></sequence>
      <before><line><data>Gender,Name</data></line></before>
    </env>
    <block><line><data>\${{Gender}},\${{MaleName}}\${{FemaleName}}</data></line></block>
  </tdc>`,
});

console.log(tdc.toString());
```

El nombre queda atado al género mediante `parent`: dos secuencias, una por rama — si no,
el nombre se sortearía por su cuenta y a un hombre le tocaría un nombre de mujer. En cada
fila se rellena exactamente una, así que en la salida van simplemente una junto a otra.

`node example.js`

```
Gender,Name
Female,Mary
Male,James
Male,John
Female,Elizabeth
```

Anular desde el código — estos le ganan a `<env>`:

```ts
const tdc = new TDC({
  configFile: "./patients.tdc",
  seed: "test-seed",
  count: 100,
  locale: "ru",
});
```

Para fuentes en archivos externos, indique las carpetas de datos (y un directorio base
para `configString`):

```ts
const tdc = new TDC({
  configFile: "./configs/users.tdc",
  dataPaths: ["./data", "./private-data"],
});
```

Con `configFile`, las rutas `src` relativas dentro del `.tdc` se resuelven desde la
carpeta de ese archivo; con `configString`, fije `baseDir` usted mismo.

El resto de las opciones del constructor son menos comunes, pero no menos reales:

| Opción          | Qué hace                                                                            |
| :-------------- | :----------------------------------------------------------------------------------- |
| `locale`        | **Anula** `<env local=…>` — la configuración pierde                                   |
| `defaultLocale` | Solo se aplica cuando `<env>` no declara ningún locale. La clave `locale` de `tdcv2.config.json` va a **esta**, no a la anulación |
| `mode`          | `"memory"` o `"disk"` — la misma elección que [`--mode`](../reference/cli.md#top)         |
| `engine`        | `1`, `2` o `3` — fuerza un motor, y falla en vez de caer a otro                        |
| `stream`        | Alias heredado de `engine: 2`                                                          |

Esa división entre `locale` y `defaultLocale` merece una segunda mirada: un
`"locale": "ru"` en la configuración del proyecto **no** le gana a un `local="en"` del
archivo de configuración, y nada lo reporta. Solo anulan el `locale` del propio
constructor y el `--locale` de la CLI.

`preflight(opts?)` tiene una opción propia: `output`, que es `"materialized"` (por
omisión — toda la corrida sostenida a la vez, lo que hace `toArray()`) o `"streaming"`.

## Métodos terminales

| Método             | Devuelve                                     | Para                                     |
| :----------------- | :------------------------------------------- | :--------------------------------------- |
| `toString()`       | toda la salida como una sola cadena          | resultados chicos o medianos             |
| `writeFile(path)`  | escribe la salida en un archivo (por trozos) | un archivo de cualquier tamaño           |
| `toIterator()`     | un generador de líneas (una por registro)    | texto grande, sin cadena entera          |
| `toStream()`       | un `Readable` de Node.js                     | `pipe` a archivo / HTTP / gzip           |
| `toColumns()`      | columnas; números como `Float64Array` | flujos numéricos, muchas ejecuciones |
| `toArray()`        | un arreglo de objetos-fila                   | fixtures chicos de objetos               |
| `iterate()`        | un generador de objetos-fila                 | salida de objetos, sin arreglo           |
| `getAt(index)`     | un objeto-fila por índice                    | acceso puntual                           |
| `preflight(opts?)` | un diagnóstico de memoria, o `undefined`     | una revisión antes de una corrida grande |
| `seedInfo()`       | `{ seed, generated }`                        | leer o registrar la semilla              |
| `toStringAsync()`  | toda la salida, como promesa                 | una configuración con `type="http"`      |
| `writeFileAsync(path)` | escribe la salida, como promesa          | una configuración con `type="http"`      |
| `usesHttp()`       | `true` si la configuración llama a la red    | elegir entre los dos pares               |

`toString`/`writeFile`/`toIterator`/`toStream` son salida de texto a través del disco,
con memoria O(cantidad de campos). Vea
**[Salidas grandes](../guides/large-outputs.md#top)** para las mediciones.

Sobre el par asíncrono hay una regla: una configuración con
[`<gen type="http">`](../generators/http.md#top) **tiene que** usarlo. Una llamada de red no
se puede hacer desde una función síncrona, así que `toString()` sobre esa configuración
lanza en vez de devolver medio dataset:

```ts
const tdc = new TDC({ configFile: "./enriched.tdc" });
const text = tdc.usesHttp() ? await tdc.toStringAsync() : tdc.toString();
```

`usesHttp()` responde eso sin ejecutar nada, que es justo lo que hace la CLI. En todo lo
demás los dos caminos se comportan igual: para una configuración sin generador `http`,
`toStringAsync()` es `toString()` envuelto en una promesa. Lo que sí cambia es la
reproducibilidad: una corrida que llama a un servicio es tan repetible como lo sea el
servicio.

## Salida en objetos

En las pruebas suele ser más cómodo trabajar con objetos vivos que analizar CSV o JSON:
se puede revisar `row.Gender` directamente. `toArray()`, `iterate()` y `getAt(index)` le
dan eso. La salida en objetos **ignora** `<block>` y los envoltorios de texto: solo lee
las `<sequence>` materializadas:

- una secuencia simple se vuelve una propiedad escalar;
- una secuencia compuesta se vuelve un objeto **anidado**;
- una secuencia filtrada por `parent` queda como `undefined` en las filas donde no
  aplica.

`getAt(index)` es el trabajo de **una sola fila**, y el índice da igual: en una
configuración de 200 000 filas, `getAt(0)` y `getAt(199999)` vuelven en unos 2 ms, mientras
que `toArray()` tarda unos 210 ms en la misma corrida. `iterate()` cuesta lo mismo en
total que `toArray()`, pero nunca sostiene el arreglo.

```ts
const tdc = new TDC({
  configString: `<tdc>
    <env count="4" seed="demo" local="en">
      <sequence name="Gender"><gen type="text" value="Male,Female"/></sequence>
      <sequence name="Person">
        <gen name="Code" type="regex" value="[0-9]{4}"/>
      </sequence>
      <sequence name="MaleName" parent="Gender.Male"><gen type="template" value="person.male.firstName"/></sequence>
      <sequence name="FemaleName" parent="Gender.Female"><gen type="template" value="person.female.firstName"/></sequence>
          </env>
    <block><line><data>ignored</data></line></block>
  </tdc>`,
});

console.log(tdc.getAt(0)); // una fila Female
console.log(tdc.getAt(1)); // una fila Male
```

`node objects.js`

```
{
  Gender: 'Female',
  Person: { Code: '7541' },
  MaleName: undefined,
  FemaleName: 'Mary'
}
{
  Gender: 'Male',
  Person: { Code: '1506' },
  MaleName: 'James',
  FemaleName: undefined
}
```

`Person` es un objeto anidado. `MaleName` y `FemaleName` están las dos presentes, pero en
cada fila se rellena exactamente una: la otra vale `undefined`, porque su `parent` no
coincidió allí. Así se ve un filtro por padre en la salida de objetos.

> [!NOTE]
> **Los mismos valores, de a una fila**
>
> Los métodos de objetos leen del motor al que el enrutador manda la configuración — el
> mismo que usa `toString()` — así que los valores coinciden, y `getAt(index)` cuesta una
> fila en vez de todo lo que va antes: pedir la fila nueve millones de una configuración
> de diez millones es el trabajo de una sola fila.

## Un valor sin configuración

El paquete exporta además `tdc`, que sortea un solo valor desde los mismos paquetes de
datos que lee una configuración: sin archivo, sin `<env>`, una llamada.

```ts
import { tdc } from "tdcv2";

tdc.person.lastName(); // Jones
tdc.country.usa.docs.ssn(); // 699209702, con sus dígitos de control reales
tdc.person.lastName.many(5); // cinco de ellos
tdc.seed("demo").locale("ru").person.lastName(); // fijado y en ruso
```

Cada dirección incluida es una propiedad real del tipo, así que un error de escritura es
un error de compilación y el autocompletado funciona sin ningún plugin. Toda la
superficie está en [Un valor a la vez](../getting-started/quick-api.md#top).

## Los mismos nombres en todos los lenguajes

El objeto que devuelve una ejecución terminada responde a los mismos nombres en los
cinco paquetes, escritos según la costumbre de cada lenguaje. [La tabla está aquí](same-names.md#top),
y los conjuntos de pruebas la comprueban en vez de darla por buena.

## Vea también

- **[CLI](../reference/cli.md#top)** — el mismo motor desde la línea de comandos.
- **[Salidas grandes](../guides/large-outputs.md#top)** — métodos de streaming y memoria.

---

← Anterior: [Comparación y verdad](../reference/comparison.md#top) · **[Contenido](../README.md#top)** · Siguiente: [Python](./python.md#top) →

📖 **[Abrir en el sitio de documentación →](https://nickliapin.github.io/tdcv2/es/docs/bindings/typescript)**
