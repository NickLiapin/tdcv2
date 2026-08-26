<a name="top"></a>

[English](../intro.md#top) · [Русский](../ru/intro.md#top) · **Español**

📖 **[Abrir en el sitio de documentación →](https://nickliapin.github.io/tdcv2/es/docs/intro)**

**[Contenido](./README.md#top)** · Siguiente: [Instalación](./getting-started/installation.md#top) →

---

# TDC — The Data Constructor

> [!NOTE]
> **TDC y `tdcv2` — dos nombres, dos cosas**
>
> **TDC** es el lenguaje: lo que contiene un archivo `.tdc`, a lo que se refieren los
> códigos del tipo `TDC001` en los mensajes de error, y lo que enseña esta
> documentación.
>
> **`tdcv2`** es el paquete y el comando que lo ejecutan — `npm install tdcv2`,
> `pip install tdcv2`, `npx tdcv2 …`. El `v2` está ahí por una razón aburrida:
> `tdc` ya estaba ocupado en npm y PyPI por paquetes ajenos. No es la versión del
> lenguaje y no cambia cuando cambia la versión: en 1.0 el paquete se seguirá
> llamando `tdcv2`.

> [!IMPORTANT]
> **Sobre esta documentación**
>
> Cubre TDC **0.2.2**, última actualización **26 de agosto de 2026** — la fecha del
> cambio más reciente en cualquier página, no la fecha en que se compiló este sitio.

TDC genera datos de prueba coherentes dentro de cada registro. En una misma fila, los
nombres corresponden a la categoría de sexo, las ciudades pertenecen al país correcto y
los diagnósticos encajan con el perfil del paciente. Ejecute TDC de nuevo con la misma
semilla y la misma versión del núcleo y producirá las mismas filas, byte por byte.

Una librería convencional de datos falsos genera cada campo de forma independiente. Esa
distinción es la base de todo lo que sigue.

## El problema de los campos independientes

Cuando los campos se generan de forma independiente, cada valor puede ser válido por
separado mientras el registro que forman es inválido en conjunto. En la práctica, esto
produce varios tipos de problemas:

- Una paciente generada es mujer de 34 años, pero se le asigna «hiperplasia prostática
  benigna»: un diagnóstico que contradice los datos demográficos del mismo registro. El
  fallo parece un error de la aplicación hasta que alguien revisa el fixture.
- Un generador con semilla fija crea un millón de pedidos emparejando ciudades y países al
  azar. El validador de direcciones rechaza un tercio, así que la prueba de carga mide la
  ruta de error en lugar de la funcionalidad.
- Una prueba falla en CI. Al reintentarla, el generador produce datos distintos y la prueba
  pasa. No hay forma de saber si el error se corrigió de verdad.

Los campos generados de forma independiente no tienen contexto compartido.

![](../img/intro/flat-vs-linked.svg)

*Las mismas tres fuentes, conectadas de dos maneras distintas.*

- **A** — tres fuentes, cada una con valores de todos los grupos
- **B** — los registros que resultan: cada campo se sorteó por su cuenta, así que nada concuerda dentro de una fila
- **C** — una fuente inicia el registro
- **D** — cada campo posterior se sortea de lo que eligió el anterior, así que la fila concuerda consigo misma

## Cómo lo resuelve TDC

Una secuencia puede referirse a una rama del padre. A partir de ahí sortea únicamente
entre los datos disponibles en la rama elegida para la fila actual.

Una vez que a una fila le toca `Female`, TDC no sortea de las listas masculinas para
filtrar el resultado después. Esas listas son inalcanzables desde la rama elegida.

![](../img/intro/dependency-tree.svg)

*Los números son los tamaños de las listas médicas en inglés.*

- **A** — un registro en construcción
- **B** — la rama en la que cae
- **C** — la lista que solo esa rama alcanza: 26 cuadros específicos de mujeres, 20 de hombres
- **D** — la lista que comparten ambas ramas: 78 cuadros que puede tener cualquiera
- **E** — la arista que no puede existir, porque un registro nunca sale de su rama

Todo lo demás en esta documentación se apoya en este mecanismo.

## Esto no es XML

Si lee el siguiente ejemplo antes que esta frase, supondrá que está viendo XML. No lo es.
**TDC es su propio formato.** Toma la forma de las etiquetas entre ángulos porque esa
forma se lee bien para cosas anidadas con nombre, y ahí termina el parecido. Ningún
analizador XML lee un archivo `.tdc`, y ninguna regla de XML se le aplica.

Lo que se espera de XML y **no** hay aquí:

| XML tiene | TDC |
| :--- | :--- |
| entidades — `&lt;` pasa a ser `<` | **nada se expande.** `&lt;` son cuatro caracteres. Escriba `<` |
| espacios de nombres, `xmlns:` | no existe tal concepto |
| un DTD o un XSD contra el que validar | valida el propio motor, con sus reglas |
| `<![CDATA[…]]>` | no hace falta: `<data>` ya guarda texto crudo |
| `<?xml …?>` | se tolera y se ignora |
| `<!DOCTYPE …>` | un error de análisis |
| el valor de un atributo es solo texto | el valor de un atributo es una **expresión TDC**: `if="Age >= 18"` se analiza y se evalúa |

Los `<` y `>` que escriba dentro de `<data>` son caracteres corrientes y así se quedan,
que es justo lo que permite a una configuración emitir JSON, SQL o HTML sin pelear con
una capa de escapado.

> [!NOTE]
> **Por qué los ejemplos dicen `xml`**
>
>
> Los bloques de código de este sitio llevan la etiqueta `xml` para que el navegador
> coloree etiquetas y atributos: es la conjetura de un resaltador de sintaxis, no una
> afirmación sobre el formato.
>
> En su propio editor tiene lo de verdad: una gramática de TDC y un servidor de lenguaje con
> revisión de errores en vivo, autocompletado y navegación. Vea
> [Soporte del editor](getting-started/editor-support.md#top).
>

## Un ejemplo básico

La siguiente configuración genera diez personas con una división por sexo de 60/40. Sus
nombres vienen de listas específicas por sexo y sus edades caen en un rango definido:

```xml title="people.tdc"
<tdc>
    <env count="10" seed="demo">
        <sequence name="Gender">
            <gen type="text" value="Male,Female" percent="60,40"/>
        </sequence>

        <sequence name="MaleName" parent="Gender.Male">
            <gen type="template" value="person.male.firstName"/>
        </sequence>
        <sequence name="FemaleName" parent="Gender.Female">
            <gen type="template" value="person.female.firstName"/>
        </sequence>

        <sequence name="Age">
            <gen type="number" value="18..65"/>
        </sequence>
    </env>

    <block>
        <line>
            <data>${{_count}}. ${{Gender}} — ${{MaleName}}${{FemaleName}}, age ${{Age}}</data>
        </line>
    </block>
</tdc>
```

`./run people.tdc`

```
1. Male — Robert, age 59
2. Female — Mary, age 18
3. Male — James, age 53
4. Male — John, age 24
5. Male — Michael, age 28
6. Male — David, age 34
7. Female — Elizabeth, age 57
8. Female — Jennifer, age 58
9. Female — Patricia, age 52
10. Male — William, age 56
```

Vale la pena señalar tres propiedades de esta salida.

**Reparto exacto.** `percent="60,40"` produce seis hombres y cuatro mujeres. No es una
aproximación basada en sorteos independientes: TDC calcula los tamaños de grupo con el
método de Hamilton.

**Nombres coherentes.** Cada nombre corresponde a su categoría de sexo. Cada secuencia de
nombres apunta a la rama correspondiente de la secuencia de sexo, de modo que una fila
femenina no puede acceder a la lista de nombres masculinos.

**Salida reproducible.** La misma semilla y la misma versión del núcleo producen las
mismas diez personas. Otra semilla produce otras diez, conservando el reparto de seis a
cuatro.

La sección `<block>` controla el formato de salida. `<line>` define una línea y `<data>`
su contenido. Cambiando esta sección, los mismos registros se pueden representar como
[CSV, JSON, SQL u otro formato](guides/output-formats.md#top).

## Las dependencias se pueden anidar

Suponga que la mitad de los hombres no tiene coche, mientras que una cuarta parte de las
mujeres tampoco. Esto requiere dos secuencias adicionales; el resto de la configuración no
cambia:

```xml
<sequence name="MaleCar" parent="Gender.Male">
    <gen type="text" value="has a car,no car" percent="50,50"/>
</sequence>
<sequence name="FemaleCar" parent="Gender.Female">
    <gen type="text" value="has a car,no car" percent="75,25"/>
</sequence>
```

`./run people.tdc`

```
1. Male — Robert — has a car
2. Female — Mary — no car
3. Male — James — no car
4. Male — John — has a car
5. Male — Michael — has a car
6. Male — David — no car
7. Female — Elizabeth — has a car
8. Female — Jennifer — has a car
9. Female — Patricia — has a car
10. Male — William — no car
```

Cada porcentaje se aplica dentro de su grupo padre. En este ejemplo, 3 de los 6 hombres y
1 de las 4 mujeres no tienen coche. Las dependencias se pueden
[anidar a la profundidad](guides/hierarchical-dependencies.md#top) que exija el modelo de
datos.

## Las salidas de ejemplo son ilustrativas

TDC produce una salida determinista para una semilla y una versión del núcleo dadas. Como
el motor sigue evolucionando, los nombres y números que produce la versión actual pueden
diferir de los mostrados aquí.

Lo importante es el comportamiento —en este ejemplo, el reparto exacto de 60/40— y no una
coincidencia byte por byte con la salida de arriba.

## Qué hace TDC

- **Reparto determinista.** [`percent="60,40"`](reference/attributes.md#top) calcula los
  tamaños de grupo en filas enteras con el método de Hamilton, en lugar de depender de
  sorteos independientes.

- **[Dependencias jerárquicas](guides/hierarchical-dependencies.md#top).** Un campo puede
  depender del valor de su padre, con dependencias anidadas a la profundidad que haga
  falta.

- **[Campos relacionados coherentes](guides/coherent-data.md#top).** Valores relacionados
  —como el nombre de un producto, su precio y su categoría— pueden salir de la misma fila
  de origen.

- **[Un reparto que existe antes que las filas](pools/overview.md#top).** Un `<pool>` construye
  un mundo pequeño una sola vez — clínicas, y luego médicos que trabajan en una de ellas — y
  cada fila toma un miembro entero. Así, este médico está en esa clínica en todas las filas
  que lo mencionan. Y `filter=` mantiene unida una fila: la enfermera de este paciente
  trabaja donde trabaja su médico.

- **[Valores únicos](constructs/unique-values.md#top).** Los valores se pueden generar sin
  duplicados dentro de una columna.

- **[Fuentes de datos externas](guides/files-and-csv.md#top).** Valores sueltos o filas
  enlazadas completas se pueden leer de sus propias fuentes.

- **[Una columna que sigue a otra](generators/formula.md#top).** Un peso que sigue a una
  estatura, un total que sigue a un precio y una cantidad, una intensidad guiada por el
  tráfico de al lado. `<gen type="formula" expr="…">` calcula una columna a partir de las
  demás de su fila, y un [parámetro de
  distribución](guides/statistical-distributions.md#un-parámetro-puede-seguir-a-otra-columna)
  también puede ser una expresión. De columnas independientes un modelo no puede aprender
  nada; estas se mueven juntas.

- **[La forma de una muestra real](generators/file.md#readquantile--una-muestra-medida-como-distribución).**
  `read="quantile"` trata su archivo de mediciones como una distribución y no como una
  bolsa de valores, así que mil importes registrados se estiran a un millón de filas sin
  convertirse en un peine de mil repeticiones. `sample="exact"` reproduce la muestra sin
  ruido de muestreo alguno.

- **[Formatos de salida flexibles](guides/output-formats.md#top).** Genere CSV, JSON, SQL,
  YAML o un formato propio.

- **[Conjuntos grandes](guides/large-outputs.md#top).** Transmita millones de filas sin
  mantener todo el conjunto en memoria.

- **[Un valor sin configuración](core-concepts/quick-api.md#top).** `tdc.person.lastName()`:
  el trabajo que hace un faker, respondido desde los mismos paquetes que usa una
  configuración. En las cinco implementaciones, y con la misma semilla cada una devuelve
  el mismo valor.

- **[Paquetes de locale y de país](data-packs/overview.md#top).** Genere datos de personas,
  lugares, registros médicos y documentos en diez idiomas. Los paquetes de país también
  cubren formatos de identificación nacional de más de noventa países, con la regla de
  dígito de control que corresponde a cada formato.

## Dónde se usa TDC

- **Automatización de pruebas.** Generar fixtures coherentes dentro del registro e incluir
  la semilla en un informe de error para reproducir exactamente el conjunto de datos en el
  que falló una prueba. TDC está disponible como [librería](bindings/typescript.md#top) y
  como [herramienta de línea de comandos](reference/cli.md#top), así que las pruebas pueden
  consumir las filas generadas directamente en lugar de depender de archivos de fixtures
  que hay que mantener sincronizados:

```typescript
import { test, expect } from '@playwright/test';
import { TDC } from 'tdcv2';

const users = new TDC({ configFile: 'users.tdc' }).toArray();

for (const user of users) {
  test(`sign up ${String(user.Name)}`, async ({ page }) => {
    await page.goto('/signup');
    await page.fill('#name', String(user.Name));
    await page.fill('#age', String(user.Age));
    await page.click('#submit');
    await expect(page.getByText('Welcome')).toBeVisible();
  });
}
```

- **Pruebas de carga y rendimiento.** La salida se transmite en lugar de mantenerse
  entera en memoria, así que los conjuntos grandes no necesitan caber en la RAM.

- **Desarrollo.** Cree entornos de demostración, entornos de pruebas y scripts de carga
  inicial con datos coherentes que se reproducen exactamente.

- **Investigación y trabajo con datos.** Construya conjuntos sintéticos con proporciones
  controladas sin recurrir a datos de producción.

## Cuándo no usar TDC

- **Los valores sueltos son todo lo que va a necesitar.** TDC también los responde
  —`tdc.person.lastName()`, sin configuración ni archivo, con
  [el API de un valor](core-concepts/quick-api.md#top)—, pero un faker dedicado trae un
  catálogo listo más grande de fábrica, mientras que TDC incluye un juego inicial y
  descarga el resto. TDC se gana su sitio cuando los campos de un registro tienen que
  concordar entre sí.

- **Necesita una copia sintética de una base de producción.** TDC inventa datos
  plausibles; no aprende la distribución conjunta de sus tablas de producción. Ese es otro
  problema.

- **Necesita anonimizar datos de producción.** TDC genera registros nuevos; no enmascara
  ni transforma los existentes.

- **Necesita un fixture fijo de cinco filas.** Para un conjunto de unos pocos registros
  estáticos, escribir los datos directamente en JSON suele ser más simple.

- **Necesita generar carga.** TDC produce los datos de prueba; herramientas como k6,
  JMeter y Locust generan y envían las peticiones.

## Disponibilidad

Las cinco están publicadas. Un mismo número de versión significa el mismo
motor: las cinco están sujetas a un único contrato por un conjunto compartido de
fixtures, así que `0.1.6` desde cualquier registro produce los mismos bytes para la
misma configuración y la misma semilla.

| Implementación                            | Registro      | Instalación                  | Versión |
| :---------------------------------------- | :------------ | :--------------------------- | :------ |
| **[TypeScript](bindings/typescript.md#top)** | npm           | `npm i tdcv2`                | 0.2.2   |
| **[Python](bindings/python.md#top)**         | PyPI          | `pip install tdcv2`          | 0.2.2   |
| **[Rust](bindings/rust.md#top)**             | crates.io     | `cargo add tdcv2`            | 0.2.2   |
| **[C#](bindings/csharp.md#top)**             | NuGet         | `dotnet add package Tdcv2`   | 0.2.2   |
| **[Java](bindings/java.md#top)**             | Maven Central | `io.github.nickliapin:tdcv2` | 0.2.2   |

Cada paquete publicado lleva un juego inicial de paquetes de datos, así que funciona sin
instalar nada más; los otros diez idiomas y noventa y tantos paquetes de país están
[a una descarga](data-packs/installing-packs.md#top).

## Por dónde empezar

- **[Instalación](getting-started/installation.md#top)** — requisitos y cómo ejecutar una configuración.
- **[Su primer conjunto de datos](getting-started/first-data.md#top)** — un recorrido breve.

> [!NOTE]
> Esta documentación describe lo que está implementado en la versión actual. Lo que sigue en
> desarrollo se señala allí donde aparece.

---

**[Contenido](./README.md#top)** · Siguiente: [Instalación](./getting-started/installation.md#top) →

📖 **[Abrir en el sitio de documentación →](https://nickliapin.github.io/tdcv2/es/docs/intro)**
