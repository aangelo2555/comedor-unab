# Simulación de 50 reservas con identidades independientes

Informe inicial. El refuerzo posterior y las pruebas de una ventana de 3,5 segundos
están en [el informe de apertura](opening-window.md).

Se ejecutó el backend real con PostgreSQL aislado y un servidor institucional
simulado por HTTP local. Cada uno de los 50 alumnos ficticios tenía su propio JWT
firmado, salvo las tres cuentas deliberadamente sin credenciales del caso de fallos.
Diez alumnos tenían Premium. No se contactó a UNAB ni se emplearon tokens reales.

El servidor simulado validó firma, vencimiento e identidad de cada token, cookie y
bearer, y propiedad de cada ticket. La programación se publicó al abrir el servicio;
el motor real realizó preparación, detección, envío y recuperación con Centinela.
El límite ordinario fue 2 solicitudes concurrentes y 500 ms entre inicios; la apertura
permitió hasta 50 POST concurrentes. La espera normal de respuesta fue 200–350 ms.

## Resultados iniciales

| Escenario | Confirmadas | Pendientes | Ventana de inicio de los POST | Última confirmación desde apertura |
|---|---:|---:|---:|---:|
| Sin fallos; 50 cupos | 50 | 0 | 20.67 ms | 0.527 s |
| Sesiones vencidas, revocación, cortes y saturación | 47 | 3 | 19.24 ms | 24.558 s |
| Solo 30 cupos | 30 | 20 | 20.00 ms | 0.511 s |
| Servidor admite solo 12 solicitudes simultáneas | 50 | 0 | 23.21 ms | 58.359 s |

La ventana mide el tiempo entre iniciar el primer y último POST en el cliente.
No mide el momento en que UNAB recibiría o confirmaría las solicitudes.
En capacidad limitada, la última confirmación corresponde a las 30 conseguidas;
no implica que las otras 20 hayan terminado. Se conservan en cola.
Todos los escenarios cumplieron los conteos previstos: cero cruces de identidad y
cero POST repetidos para tickets que el servidor ya había emitido.

En el escenario mixto se recuperaron seis sesiones (cinco vencidas antes de la apertura
y una revocada al enviar), dos respuestas perdidas después de crear el ticket, dos
respuestas lentas y tres rechazos por saturación. Las tres cuentas sin credenciales
permanecieron pendientes: no se puede renovar una sesión sin datos válidos de acceso.
Hubo 51 POST para 47 alumnos con credenciales: los reintentos correspondieron a rechazos,
no a tickets ya creados. El escenario con límite de concurrencia produjo 38 rechazos
iniciales y 88 POST totales, con recuperación gradual hasta completar las 50 reservas.

## Corrección encontrada durante la prueba

Con `ADMIN_PASSWORD` configurada, la aplicación conservaba la contraseña administrativa
sin hash en memoria y ejecutaba `scryptSync` de nuevo al serializar cada guardado.
Ese cálculo síncrono bloquea el event loop. Se cambió para calcular el hash al cargar,
crear o modificar la contraseña; los guardados reutilizan el hash. Se conservan el
algoritmo, su coste, la sal aleatoria y la comprobación de contraseñas.

Al repetir el escenario sano sin otras pruebas ejecutándose, hubo **50/50 confirmadas**,
el primer POST empezó **11 ms después de detectar la publicación**,
y los 50 comenzaron en una ventana de **19.36 ms**.
La última confirmación llegó a **419 ms desde la apertura local**.
Los cálculos de contraseña bajaron de 13 a 1; el tiempo de CPU
acumulado en ellos bajó de 430 a 43 ms. El primer POST había
empezado a los 48 ms de la detección en la ejecución inicial. Son ejecuciones individuales,
no un benchmark estadístico ni una garantía de latencia en producción.

La prueba de regresión comprueba que guardar estado repetidamente no vuelve a calcular
el hash, que cambiar contraseñas sí lo hace y que la autenticación sigue funcionando.
La suite completa terminó con **88 pruebas aprobadas**, incluida la integración con
PostgreSQL y la nueva regresión de contraseñas. Los escenarios de fallos se midieron antes de esta optimización; el escenario sano
se repitió después. El archivo JSON optimizado identifica el commit base; incluye
la modificación local de `db.js` descrita aquí, todavía sin desplegar.

## Qué puede fallar y qué conviene mejorar

- **Límite compartido:** tokens distintos identifican alumnos distintos; el servidor
  aún puede limitar por IP, conexiones o carga global. Iniciar 50 solicitudes juntas
  no obliga a la institución a aceptar 50 simultáneamente.
- **Recuperación:** los reintentos respetan pausas y el límite ordinario. La saturación
  simulada tardó unos 58 segundos en resolverse. Conviene medir rechazos y latencias
  reales antes de ajustar la concurrencia; subirla sin datos puede causar más rechazos.
- **Preparación:** las cuentas sin credenciales válidas no están listas, aunque tengan
  una solicitud en cola. Deben aparecer separadas de las sesiones preparadas. Conservar
  la clave de cifrado y completar el ingreso inicial permite la recuperación automática.
- **Cupos:** 50 alumnos preparados no garantizan 50 reservas si otros usuarios compiten
  o el proveedor ofrece menos cupos. No deben declararse exitosas las pendientes.
- **Observabilidad:** distinguir detección, primer/último envío, aceptación, confirmación,
  rechazos y reintentos. La mejora local no elimina latencia de red ni del proveedor.

El resultado confirma que el backend puede iniciar el lote sin esperar la respuesta
de cada alumno. El proveedor simulado acepta la asignación de cupo de forma atómica;
esto no demuestra las reglas transaccionales del servidor de UNAB. No se midieron TLS,
latencia WAN, WAF, restricciones reales por IP ni 50 navegadores. La simulación se centró
en una apertura de cena; no constituye tres mediciones independientes de desayuno,
almuerzo y cena, que pueden tener afluencias distintas.

## Archivos reproducibles

- [Simulador e instrucciones](../simulation/README.md)
- [Resultados iniciales](simulation-50-baseline.json)
- [Resultados tras la corrección](simulation-50-optimized.json)
