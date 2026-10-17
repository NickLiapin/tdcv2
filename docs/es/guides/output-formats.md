<a name="top"></a>

[English](../../guides/output-formats.md#top) · [Русский](../../ru/guides/output-formats.md#top) · **Español**

📖 **[Abrir en el sitio de documentación →](https://nickliapin.github.io/tdcv2/es/docs/guides/output-formats)**

← Anterior: [Leer archivos y CSV](./files-and-csv.md#top) · **[Contenido](../README.md#top)** · Siguiente: [Máscaras y mayúsculas](./masks-and-case.md#top) →

---

# Formatos de salida (CSV, JSON, SQL…)

TDC no tiene una lista fija de exportadores, y eso es deliberado. El
[bloque de salida](../core-concepts/output-formatting.md#top) arma **texto** —
[`<before>`](../core-concepts/output-formatting.md#top) / [`<after>`](../core-concepts/output-formatting.md#top)
envuelven la corrida entera, [`<block>`](../core-concepts/output-formatting.md#top) es un registro y
[`<data>`](../core-concepts/output-formatting.md#top) es el texto crudo — así que el mismo motor
produce CSV, JSON, SQL, YAML, NDJSON o cualquier otra cosa hecha de caracteres.

El precio de esa libertad es que **usted** se hace cargo de las reglas de sintaxis del
formato. TDC no sabe que está construyendo JSON, así que no va a agregar una coma, una
comilla ni un `null` por su cuenta — y tampoco los va a agregar donde no los quiere. Esta
guía recorre los tres formatos más comunes y los puntos exactos en que cada uno se rompe,
y luego muestra cómo construir cualquier otra forma.

> [!NOTE]
> Las salidas de ejemplo de abajo son ilustrativas — los valores exactos pueden variar
> según la versión del core y la semilla. Lo que importa es la **forma** de cada formato, no
> los nombres o números concretos. Verifique un archivo generado con un parser de verdad
> (`python -m json.tool`, `sqlite3`, un lector de CSV), nunca a ojo — cada ruptura de las
> que siguen se ve bien a primera vista.

## CSV

CSV es el destino más amable: un encabezado una vez y luego una fila por registro. Dos
cosas muerden: dónde va el encabezado y cualquier valor que contenga el delimitador o una
comilla.

### El encabezado — una sola vez, con `<before>`

Un encabezado pertenece a [`<before>`](../core-concepts/output-formatting.md#top): se imprime
exactamente una vez, arriba de todos los registros, sin importar si `count` es 3 o 3
millones.

```xml
<tdc>
    <env count="3" seed="demo">
        <before><line><data>id,name,category</data></line></before>
        <sequence name="Id"><gen type="increment" value="1"/></sequence>
        <sequence name="Name"><gen type="text" value="Bolígrafo,Taza,Cuaderno"/></sequence>
        <sequence name="Cat"><gen type="text" value="Oficina,Cocina,Oficina"/></sequence>
    </env>
    <block>
        <line><data>${{Id}},${{Name}},${{Cat}}</data></line>
    </block>
</tdc>
```

`./run out.tdc -o out.csv`

```
id,name,category
1,Cuaderno,Oficina
2,Taza,Oficina
3,Bolígrafo,Cocina
```

Poner el encabezado en `<block>` lo repetiría en cada fila; ponerlo en `<before>` lo
imprime una vez. Use `<after>` de la misma forma para una línea de resumen al final o un
marcador de cierre.

### `csv` — un valor con una coma o una comilla

**Problema.** Un nombre de producto como `Juego de cuchillos, 3 pzas` contiene el separador de
campos. Escrito tal cual, esa coma se vuelve un **corte de columna**: la fila gana un
campo extra, las categorías se deslizan hacia los precios y — lo peor de todo — el
archivo igual se abre sin error. El daño solo aparece cuando un programa lo vuelve a
leer.

```xml
<block>
    <line><data>${{Id}},${{Name}},${{Cat}},${{Price}}</data></line>
</block>
```

`./run out.tdc (una coma dentro de un valor)`

```
# a la vista se ve bien:
7,Juego de cuchillos, 3 pzas,Cocina,32.00

# lo que en realidad ve un lector de CSV — 5 campos, no 4:

7 | Juego de cuchillos | 3 pzas | Cocina | 32.00
```

**Herramienta.** El filtro [`csv`](masks-and-case.md#top) envuelve un campo entre comillas
cuando las necesita y duplica cualquier comilla interna — exactamente lo que pide el RFC 4180. Póngalo en **cada** campo de texto que venga de fuera de su configuración:

```xml
<block>
    <line><data>${{Id}},${{Name | csv}},${{Cat}},${{Price}}</data></line>
</block>
```

`./run out.tdc -o out.csv`

```
id,name,category,price
7,"Juego de cuchillos, 3 pzas",Cocina,32.00
8,"Café ""Arábica"" 250 g",Alimentación,5.40
9,"Taza",Cocina,4.10
```

Ahora las comas y las comillas viven a salvo dentro de campos entrecomillados; un lector
obtiene cuatro columnas en cada fila. **Conviene usarlo cuando** cualquier valor pudiera
llevar una coma, una comilla o un salto de línea — lo cual es casi siempre cierto para
nombres, títulos y direcciones sacados de un
[archivo de datos](files-and-csv.md#top) real.

### Un delimitador distinto

El separador es apenas un carácter que usted escribe. ¿Quiere punto y coma (algo común
cuando un valor ya trae comas) o tabuladores? Cambie el texto literal en `<data>` y en el
encabezado para que coincidan — no hay ningún modo que activar.

<!-- doc-check: skip the config is abbreviated — the comment stands in for sequences declared earlier on this page -->

```xml
<env count="3" seed="demo">
    <before><line><data>id;name;category</data></line></before>
    <!-- las secuencias Id / Name / Cat, sin cambios -->
</env>
<block><line><data>${{Id}};${{Name}};${{Cat}}</data></line></block>
```

`./run out.tdc -o out.csv (delimitado con punto y coma)`

```
id;name;category
1;Cuaderno;Oficina
2;Taza;Oficina
3;Bolígrafo;Cocina
```

(El atributo [`delimiter`](files-and-csv.md#top) es otra cosa — le dice al generador
[`file`](../generators/file.md#top) cómo **leer** un CSV de entrada. Del lado de la salida
uno simplemente escribe el carácter que quiere.)

## JSON

JSON tampoco tiene un «modo» en TDC — es texto, igual que el CSV. Pero tiene cuatro reglas
de sintaxis que un ensamblador de texto plano violará con toda tranquilidad. Aquí están
las cuatro, y el arreglo de cada una.

### Un arreglo sin coma final

**Problema.** Tres objetos no son JSON hasta que algo los une en un arreglo. El
movimiento obvio — una coma al final de cada objeto — pone una coma **también después del
último**, y todo parser lo rechaza:

`python -m json.tool users.json`

```
  "age": 21
},
]
JSONDecodeError: Expecting value: line 17 column 1
```

**Dos arreglos limpios.**

El primero usa una pieza condicional. Un segundo
[`<data if="!_last">`](../core-concepts/output-formatting.md#top) imprime una coma en cada
registro **menos** en el último — `_last` es la bandera integrada de «registro final» —
así que el JSON cierra bien:

```xml
<tdc>
    <env count="3" seed="demo" local="es">
        <before><line><data>[</data></line></before>
        <after><line><data>]</data></line></after>
        <sequence name="Id"><gen type="increment" value="1"/></sequence>
        <sequence name="Name"><gen type="template" value="person.male.firstName"/></sequence>
    </env>
    <block>
        <line><data>  {"id": ${{Id}}, "name": "${{Name}}"}</data><data if="!_last">,</data></line>
    </block>
</tdc>
```

`./run out.tdc -o out.json`

```
[
  {"id": 1, "name": "Amadeo"},
  {"id": 2, "name": "Vidal"},
  {"id": 3, "name": "Casimiro"}
]
```

El segundo es una fixture dedicada. [`<delimiter_block>`](../core-concepts/output-formatting.md#top)
imprime su texto **entre** registros — `count - 1` veces, nunca después del último — que
es precisamente «una coma entre elementos de un arreglo»:

```xml
<env count="3" seed="demo" local="es">
    <before><line><data>[</data></line></before>
    <delimiter_block><line><data>,</data></line></delimiter_block>
    <after><line><data>]</data></line></after>
    ...
</env>
```

Use `if="!_last"` cuando la coma viaja en la misma línea que el objeto; eche mano de
`<delimiter_block>` cuando un registro abarca varias líneas y el separador quiere su
propia línea. Una coma sola en una línea se ve rara pero es JSON válido — los saltos de
línea entre elementos de un arreglo no significan nada. Pase el archivo por `jq .` si lo
quiere bonito.

### Las comillas las pone usted

Note las comillas de arriba: `"${{Name}}"` las tiene, `${{Id}}` no. TDC no sabe nada de
los tipos de JSON — usted coloca las comillas, y eso es justamente lo que mantiene un
número como número y una cadena como cadena.

```xml
<line><data>  "id": ${{Id}}, "zip": "${{Zip}}", "age": ${{Age}}</data></line>
```

`./run out.tdc`

```
  "id": 1, "zip": "06370", "age": 79
```

`zip` va entrecomillado a propósito: un código postal no es un número (nunca se hace
aritmética con él, y un cero inicial desaparecería). `id` y `age` quedan sin comillas para
que se lean como enteros.

### Anidar es solo poner más líneas

Un objeto anidado no necesita sintaxis especial — son unas cuantas líneas `<data>` más,
con las llaves y la sangría correctas:

```xml
<line><data>  "address": {</data></line>
<line><data>    "city": "${{City}}",</data></line>
<line><data>    "zip": "${{Zip}}"</data></line>
<line><data>  },</data></line>
```

`./run out.tdc`

```
  "address": {
    "city": "Cuauhtémoc",
    "zip": "06370"
  },
```

### Un arreglo dentro de un objeto

Varios valores en un mismo campo vienen de [`repeat`](../reference/attributes.md#top), que los une
en una sola celda con su [`separator`](../reference/attributes.md#top). El filtro
[`json`](masks-and-case.md#json--un-valor-json-completo), con ese separador, vuelve a
cortar la celda y escribe un arreglo JSON, con comillas y corchetes incluidos:

```xml
<sequence name="Tags">
    <gen type="text" value="oferta,nuevo,regalo,vip" repeat="0..3" separator=";"/>
</sequence>
```

```xml
<line><data>  "tags": ${{Tags | json:;}},</data></line>
```

`./run out.tdc`

```
  "tags": ["regalo", "vip"],
  "tags": [],
  "tags": ["oferta"],
```

Un registro sin etiquetas recibe `[]`, no `[""]`. Escriba el separador con el que se unió la
columna: `${{Tags | json}}` sin él imprime la lista entera como una sola cadena, y `check`
lo advierte ([TDC312](../reference/errors.md#top)). Para un arreglo de **números** el filtro no
hace falta — los números no llevan comillas, así que basta con `separator=","` y
`[${{Scores}}]`. Y note que [`repeat`](../reference/attributes.md#top) saca cada valor de forma
independiente, así que una etiqueta puede aparecer dos veces en una fila; si no lo quiere,
agregue `distinct="true"` al `<gen>`.

### `null` es una palabra, no un vacío

**Problema.** Para un campo opcional, [`missing`](../reference/attributes.md#top) es lo
natural a lo que uno echa mano — pero `missing` produce un valor **vacío**, y en JSON no
existe tal cosa como el vacío:

```xml
<gen type="number" value="1..100" missing="0.5"/>
```

`python -m json.tool users.json`

```
{"id": 1, "score": }
JSONDecodeError: Expecting value: line 1 column 20
```

(En CSV ese mismo vacío es lo correcto — una celda vacía significa «sin valor». Los
formatos difieren.)

**Herramienta.** Escriba la palabra literal `null` como una rama de un
[`<mix>`](../reference/tags.md#top), lo cual además hace que la proporción sea **exacta** —
en 50 000 filas se obtienen precisamente 10 000 nulls, no «como un 20 %»:

```xml
<mix name="Score" percent="80,20">
    <case><gen type="number" value="1..100"/></case>
    <case><data>null</data></case>
</mix>
```

`./run out.tdc`

```
{"id": 1, "score": 56}
{"id": 2, "score": null}
{"id": 3, "score": 12}
```

Para un campo de **cadena**, el filtro
[`json`](masks-and-case.md#json--un-valor-json-completo) ya escribe `null` en lugar de un
valor vacío, así que `missing` funciona tal cual:

```xml
<sequence name="Note"><gen type="text" value="fragile,urgent" missing="0.5"/></sequence>
...
<line><data>{"id": ${{Id}}, "note": ${{Note | json}}}</data></line>
```

`./run out.tdc`

```
{"id": 1, "note": "fragile"}
{"id": 2, "note": null}
{"id": 3, "note": "urgent"}
```

### Una comilla que viene de datos externos

La última ruptura viene de valores que usted no controla — un nombre sacado de un
[archivo](files-and-csv.md#top). Un producto llamado `Café "Arábica" 250 g` cae en la cadena
tal cual, y la segunda comilla la cierra antes de tiempo:

`python -m json.tool products.json`

```
{"name": "Café "Arábica" 250 g"}
JSONDecodeError: Expecting ',' delimiter
```

El filtro [`json`](masks-and-case.md#json--un-valor-json-completo) escribe el valor como
una cadena JSON: pone las comillas y escapa lo que JSON exige — una comilla interna, una
barra invertida, un tabulador o un salto de línea:

```xml
<data>{"name": ${{Name | json}}}</data>
```

`./run out.tdc`

```
{"name": "Café \"Arábica\" 250 g"}
{"name": "Café \"Robusta\" 250 g"}
```

Eso se vuelve a parsear como la cadena original, con las comillas intactas. Note que la
configuración no pone comillas alrededor de `${{Name | json}}`: el filtro trae las suyas.

### Muchos registros: NDJSON

Un arreglo tiene un techo: para leer un objeto, un parser tiene que cargar el **archivo
entero**, así que un millón de registros significa gigabytes en memoria. La respuesta de
la industria es **NDJSON** — un objeto por línea, sin envoltorio y sin comas. pandas,
ClickHouse, BigQuery y `jq` lo leen todos.

Basta con quitar las tres fixtures y doblar cada registro en una sola línea:

```xml
<block><line>
    <data>{"id": ${{Id}}, "name": "${{Name}}", "city": "${{City}}", "score": ${{Score}}}</data>
</line></block>
```

`./run out.tdc -o out.ndjson`

```
{"id": 1, "name": "Raimundo", "city": "Zacatepec", "score": 74}
{"id": 2, "name": "Marcial", "city": "Ixtapaluca", "score": null}
{"id": 3, "name": "Aurelio", "city": "Linares", "score": 2}
```

Un consumidor lo lee línea por línea, necesitando memoria para un solo registro en vez de
para el archivo completo — el formato de elección pasados unos cientos de miles de filas.
Vea [Salidas grandes y streaming](large-outputs.md#top) para saber cómo TDC las produce en
disco sin mantener el archivo en memoria.

### Una lista anidada dentro de un registro

Un registro que lleva su propia lista — un pedido y sus líneas, un paciente y sus visitas — la
imprime con [`each`](../constructs/relational-tables.md#top), una línea por elemento. La coma va
en cada elemento menos el último, y la propia lista recorrida dice cuál es: `Sku._last`.

```xml
<tdc>
  <env count="2" seed="orders" local="en">
    <sequence name="OrderId"><gen type="increment" value="5001"/></sequence>
    <sequence name="Sku"><gen type="regex" value="SKU-[0-9]{4}" repeat="1..3" separator="|"/></sequence>
    <before><line><data>[</data></line></before>
    <after><line><data>]</data></line></after>
    <before_block><line><data>  { "order": ${{OrderId}}, "lines": [</data></line></before_block>
    <after_block><line><data>  ] }</data></line></after_block>
    <delimiter_block><line><data>  ,</data></line></delimiter_block>
  </env>
  <block>
    <line each="Sku"><data>    { "sku": ${{Sku | json}}, "qty": ${{Sku._item}} }</data><data if="!Sku._last">,</data></line>
  </block>
</tdc>
```

`./run orders.tdc`

```
[
  { "order": 5001, "lines": [
    { "sku": "SKU-3547", "qty": 1 },
    { "sku": "SKU-8121", "qty": 2 },
    { "sku": "SKU-7610", "qty": 3 }
  ] }
  ,
  { "order": 5002, "lines": [
    { "sku": "SKU-4917", "qty": 1 },
    { "sku": "SKU-8482", "qty": 2 }
  ] }
]
```

`repeat="1..3"` da a cada registro un número distinto de elementos, y las comas lo siguen: una
menos que líneas, siempre, incluido el registro que solo tiene una. En una línea con `each`,
`${{Sku}}` es el elemento actual, así que `| json` lo toma sin separador. Para poner la coma en
una línea propia, use [`<delimiter_line>`](../core-concepts/output-formatting.md#top): se imprime
entre las líneas que produce un `each`.

> [!NOTE]
> **El envoltorio lee la fila**
>
> Un `${{Name}}` en una fixture SÍ se expande y lee la fila junto a la que está, así que los campos
> propios del registro van en `<before_block>`, justo al lado del corchete de apertura, y los
> elementos del array en el `<block>`. Lo que una fixture **no** puede llevar es un `<gen>`
> (`TDC131`): un generador ahí emitiría una constante con aspecto de valor sorteado.

### Dos tablas en un solo documento

Un documento JSON que guarda tablas de consulta — departamentos y los médicos que trabajan en
ellos — se arma con [pools](../pools/overview.md#top). `<line each="Depts">` imprime el pool
registro por registro, un campo se lee como `${{Depts.name}}`, y un campo sorteado de otro pool
se lee un nivel más abajo: `${{Doctors.dept.id}}`.

```xml
<tdc>
  <env count="1" seed="clinic" local="en">
    <pool name="Depts" count="2">
      <sequence name="id"><gen type="increment" value="1"/></sequence>
      <sequence name="name"><gen type="text" value="Cardiology,Neurology" order="sequential"/></sequence>
    </pool>
    <pool name="Doctors" count="3">
      <sequence name="id"><gen type="increment" value="1"/></sequence>
      <sequence name="last"><gen type="template" value="person.lastName"/></sequence>
      <sequence name="dept"><gen type="pool" value="Depts"/></sequence>
      <sequence name="languages"><gen type="text" value="English,Spanish,Polish" repeat="1..2" separator=";" distinct="true"/></sequence>
    </pool>
  </env>
  <block>
    <line><data>{</data></line>
    <line><data>  "departments": [</data></line>
    <line each="Depts"><data>    {"id": ${{Depts.id}}, "name": ${{Depts.name | json}}}</data><data if="!Depts._last">,</data></line>
    <line><data>  ],</data></line>
    <line><data>  "doctors": [</data></line>
    <line each="Doctors"><data>    {"id": ${{Doctors.id}}, "name": ${{Doctors.last | json}}, "dept": ${{Doctors.dept.id}}, "languages": ${{Doctors.languages | json:;}}}</data><data if="!Doctors._last">,</data></line>
    <line><data>  ]</data></line>
    <line><data>}</data></line>
  </block>
</tdc>
```

`./run clinic.tdc`

```
{
  "departments": [
    {"id": 1, "name": "Cardiology"},
    {"id": 2, "name": "Neurology"}
  ],
  "doctors": [
    {"id": 1, "name": "Smith", "dept": 2, "languages": ["English"]},
    {"id": 2, "name": "Johnson", "dept": 2, "languages": ["English"]},
    {"id": 3, "name": "Williams", "dept": 1, "languages": ["English", "Polish"]}
  ]
}
```

Cada `dept` apunta a un departamento que existe, porque los médicos lo sortean del mismo pool
que imprime el documento. `count="1"` imprime el documento una vez; un pool es el mismo en
todas las filas, así que con más filas las mismas tablas se repetirían. Veinte tablas son
veinte pools y veinte líneas con `each`; no hace falta ninguna otra construcción.

### Registros dentro de registros

Cuando cada registro guarda una lista de registros propios — un departamento y sus médicos —,
imprímalo con [`<group each="…">`](../constructs/relational-tables.md#varias-líneas-por-elemento-group):
el grupo repite varias líneas por departamento, y un grupo dentro de él recorre los médicos y se
queda con los del departamento que se está imprimiendo.

```xml
<block>
    <line><data>[</data></line>
    <group each="Depts">
        <line><data>  {"name": ${{Depts.name | json}}, "doctors": [</data></line>
        <group each="Doctors" if="Doctors.dept.id == Depts.id">
            <line><data>    {"name": ${{Doctors.last | json}},</data></line>
            <line><data>     "languages": ${{Doctors.languages | json:;}}}</data><data if="!Doctors._last">,</data></line>
        </group>
        <line><data>  ]}</data><data if="!Depts._last">,</data></line>
    </group>
    <line><data>]</data></line>
</block>
```

`./run nested.tdc`

```
[
  {"name": "Cardiology", "doctors": [
    {"name": "Williams",
     "languages": ["English", "Polish"]}
  ]},
  {"name": "Neurology", "doctors": [
    {"name": "Smith",
     "languages": ["English"]},
    {"name": "Johnson",
     "languages": ["English"]}
  ]}
]
```

`Doctors._last` cuenta los médicos de un departamento y vuelve a empezar en el siguiente, así que
cada arreglo interior se cierra sin una coma colgando, y `Depts._last` hace lo mismo con el
exterior.

## SQL

Para SQL uno emite sentencias que una base de datos ejecuta directamente — TDC no se
conecta a nada, escribe un **archivo de comandos** que se carga con `sqlite3`, `psql` o
una migración. Dos preocupaciones de formato: escapar los apóstrofos y envolver la corrida
en el esquema y una transacción.

### `sql` — un apóstrofo en un valor

**Problema.** En SQL un literal de cadena va delimitado por comillas simples, así que un
apellido como `O'Brien` cierra la cadena antes de tiempo y la sentencia no corre:

`sqlite3 shop.db < out.sql`

```
INSERT INTO users (id, last) VALUES (2, 'O'Brien');
Error: near "Brien": syntax error
```

**Herramienta.** El filtro [`sql`](masks-and-case.md#top) duplica el apóstrofo, que es como
SQL lo escapa dentro de un literal:

```xml
<tdc>
    <env count="3" seed="demo">
        <sequence name="Id"><gen type="increment" value="1"/></sequence>
        <sequence name="Last"><gen type="text" value="Sarmiento,O'Brien,Valdés" order="sequential"/></sequence>
    </env>
    <block>
        <line><data>INSERT INTO users (id, last) VALUES (${{Id}}, '${{Last | sql}}');</data></line>
    </block>
</tdc>
```

`./run out.tdc -o out.sql`

```
INSERT INTO users (id, last) VALUES (1, 'Sarmiento');
INSERT INTO users (id, last) VALUES (2, 'O''Brien');
INSERT INTO users (id, last) VALUES (3, 'Valdés');
```

`'O''Brien'` se carga de vuelta como `O'Brien`. Da la casualidad de que los packs de datos
de fábrica no traen apóstrofos, pero en cuanto se conecta la lista de nombres **propia**
aparecen — los nombres irlandeses e italianos están llenos de ellos — así que ponga `sql`
en cada campo de texto que vaya rumbo a una sentencia. No cuesta nada y evita una
importación fallida más adelante.

### Primero el esquema, después los datos — `<before>` / `<after>`

El `CREATE TABLE` se ejecuta una sola vez, así que pertenece a
[`<before>`](../core-concepts/output-formatting.md#top), que se imprime antes de todas las
filas:

```xml
<env count="3" seed="shop" local="es">
    <before>
        <line><data>CREATE TABLE customers (</data></line>
        <line><data>  id    INTEGER PRIMARY KEY,</data></line>
        <line><data>  name  TEXT NOT NULL,</data></line>
        <line><data>  city  TEXT NOT NULL</data></line>
        <line><data>);</data></line>
    </before>
    <sequence name="Id"><gen type="increment" value="1"/></sequence>
    <sequence name="First"><gen type="template" value="person.male.firstName"/></sequence>
    <sequence name="Last"><gen type="template" value="person.lastName"/></sequence>
    <sequence name="City"><gen type="text" value="Guadalajara,Monterrey,Mérida" percent="50,30,20"/></sequence>
</env>
<block><line>
    <data>INSERT INTO customers VALUES (${{Id}}, '${{First}} ${{Last | sql}}', '${{City}}');</data>
</line></block>
```

`./run out.tdc -o shop.sql`

```
CREATE TABLE customers (
  id    INTEGER PRIMARY KEY,
  name  TEXT NOT NULL,
  city  TEXT NOT NULL
);
INSERT INTO customers VALUES (1, 'Salvador Oviedo', 'Mérida');
INSERT INTO customers VALUES (2, 'Justino Salvador', 'Monterrey');
INSERT INTO customers VALUES (3, 'Celso Medrano', 'Guadalajara');
```

### Envuélvalo en una sola transacción

Mil `INSERT` pelados son mil transacciones — lento. Envuelva la corrida en
`BEGIN` / `COMMIT` para que cargue como una sola, agregando una línea a cada fixture:

<!-- doc-check: skip the config is abbreviated — the comment stands in for sequences declared earlier on this page -->

```xml
<env count="3" seed="demo">
    <before>… esquema …<line><data>BEGIN;</data></line></before>
    <after><line><data>COMMIT;</data></line></after>
    <!-- las secuencias, sin cambios -->
</env>
```

Y luego se carga:

`sqlite3 shop.db < shop.sql`

```
# SQLite
sqlite3 shop.db < shop.sql

# PostgreSQL — el mismo archivo

psql -f shop.sql
```

Para tablas relacionadas — pedidos que referencian clientes existentes, con la llave
foránea siempre válida — genere una línea por elemento de la lista con
[`each`](../reference/attributes.md#top); vea
[Datos coherentes y relacionales](coherent-data.md#top) para el patrón completo.

## Cualquier otra cosa

Las mismas tres piezas construyen cualquier forma de texto — usted controla cada carácter:

- **YAML** — un `- ` antes de cada elemento de lista, sangría de dos espacios para anidar.
- **Una tabla de Markdown** — un encabezado delimitado por `|` más una regla `|---|` en
  `<before>`, y filas con `|` en `<block>`.
- **Un reporte de ancho fijo** — rellene los campos hasta un ancho fijo con los filtros
  [`mask`](masks-and-case.md#top) / slice y alinee las columnas.

<!-- doc-check: skip the config is abbreviated — the comment stands in for sequences declared earlier on this page -->

```xml
<env count="3" seed="demo">
    <before>
        <line><data>| id | name  | city    |</data></line>
        <line><data>|----|-------|---------|</data></line>
    </before>
    <!-- las secuencias, sin cambios -->
</env>
<block><line><data>| ${{Id}} | ${{Name}} | ${{City}} |</data></line></block>
```

`./run out.tdc (tabla de Markdown)`

```
| id | name  | city    |
|----|-------|---------|
| 1 | Raimundo | Monterrey |
| 2 | Marcial | Mérida |
```

TDC solo rellena los valores — el formato es el que usted haya escrito.

## Vea también

- **[Salida y formato](../core-concepts/output-formatting.md#top)** — `<block>`, `<line>`,
  `<data>`, las fixtures y la condición `if`.
- **[Máscaras y mayúsculas](masks-and-case.md#top)** — los filtros de escape `csv` / `sql` /
  `replace` completos.
- **[Leer archivos y CSV](files-and-csv.md#top)** — cómo traer sus propios valores desde un
  archivo con el generador [`file`](../generators/file.md#top).
- **[Datos coherentes y relacionales](coherent-data.md#top)** — tablas relacionadas, llaves
  foráneas y los atributos `each` / `weight` / `row`.
- **[Salidas grandes y streaming](large-outputs.md#top)** — millones de filas y NDJSON en disco.

---

← Anterior: [Leer archivos y CSV](./files-and-csv.md#top) · **[Contenido](../README.md#top)** · Siguiente: [Máscaras y mayúsculas](./masks-and-case.md#top) →

📖 **[Abrir en el sitio de documentación →](https://nickliapin.github.io/tdcv2/es/docs/guides/output-formats)**
