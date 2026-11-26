# Refuerzo de la ventana de apertura

El objetivo es que los primeros POST de los alumnos preparados lleguen durante los
3–4 segundos en que puede haber cupos. Se ejecutó el backend real, PostgreSQL aislado
y un proveedor ficticio por HTTP local, con 50 alumnos, tokens JWT firmados distintos
y diez cuentas Premium. Ninguna petición se envió a UNAB.

El modelo dispone de 50 cupos y rechaza todos los POST que lleguen desde los **3500 ms**
posteriores a la apertura. Es una forma controlada de representar el agotamiento
rápido; no reproduce 300 cupos ni cientos de competidores reales. Los temporizadores,
el motor de preparación, las colas, los sockets y la persistencia son reales.

## Fallo reproducido antes del refuerzo

Con consultas previas de tickets de 2800 ms, cinco tokens vencidos, consulta de
publicación de 1000 ms y confirmaciones de 2000 ms, la versión anterior confirmó
**2 de 50**. Conservó 48 solicitudes pendientes. La detección se produjo a los
2663 ms; las comprobaciones pendientes y la caducidad de la preparación retrasaron
los demás POST hasta después del cierre simulado. Las dos confirmaciones terminaron
a los 5219 ms, aunque sus solicitudes habían llegado dentro de la ventana.

La medición previa ya incluía la optimización local de contraseñas de `db.js`.
Su JSON conserva el fallo de las aserciones de resultado ideal; 2 confirmadas más
48 pendientes suman los 50 alumnos: no se perdieron solicitudes.

## Cambios aplicados

- Calentamiento remoto a cinco minutos de la apertura; preparación final normalmente
  a 90 segundos, con tokens que cubran la apertura y dos minutos adicionales.
- Pasadas adicionales cada diez segundos tras finalizar la anterior. Se reutilizan
  comprobaciones válidas y se incluyen nuevas cuentas o tokens renovados. Premium
  tiene prioridad también durante la preparación, seguida del orden de registro.
- La preparación deja de iniciar trabajo cinco segundos antes de abrir; las consultas
  previas tienen un límite de cinco segundos por intento. El trabajo cancelado se
  retira antes de consumir un turno de red.
- Ante un reinicio próximo a la apertura se prioriza la preparación de tickets para
  evitar que otra pasada remota la retrase.
- Una comprobación negativa de tickets puede tener hasta 120 segundos y usarse durante
  los primeros cuatro segundos de apertura, ligada a alumno, token, fecha y servicio.
  Si caduca o se invalida, se consulta de nuevo antes de escribir.
- La detección usa primero un alumno con token vigente y tiene prioridad sobre las
  consultas ordinarias pendientes. Cada intento de programación tiene un límite de
  tres segundos. Un rechazo 401 rota la consulta a otra cuenta sin esperar el login
  de la afectada; su recuperación continúa por el flujo habitual.
- Los POST preparados se inician en paralelo, con un máximo de 50 inicios especiales.
  Se mantienen las pausas del proveedor, `Retry-After`, la deduplicación y las
  verificaciones de cancelación. Las respuestas perdidas se reconcilian antes de
  repetir una escritura. La optimización anterior de contraseñas evita recalcular
  `scryptSync` en cada guardado de auditoría o estado.

## Resultados

Los tiempos se miden desde la apertura del proveedor simulado. La llegada de un POST
es distinta de su confirmación: el modelo asigna el cupo al aceptar la solicitud y
puede tardar más en responder.

| Escenario | Confirmadas | Pendientes | Alumnos con POST recibido antes de 3,5 s | Última primera llegada | Última confirmación |
|---|---:|---:|---:|---:|---:|
| Sesiones preparadas | 50 | 0 | 50 | 0.075 s | 0.426 s |
| Consultas previas lentas y cinco sesiones vencidas | 50 | 0 | 50 | 1.080 s | 3.108 s |
| Primera cuenta sin credenciales | 49 | 1 | 49 | 0.068 s | 0.418 s |
| Publicación tarda 2,8 s | 50 | 0 | 50 | 2.879 s | 3.231 s |
| Token de consulta revocado al abrir | 50 | 0 | 50 | 1.546 s | 1.748 s |

En el caso exigente, que antes consiguió 2 reservas, ahora llegaron las 50 antes del
cierre simulado y las 50 quedaron confirmadas. En el caso sin credenciales, las otras
49 reservaron; la cuenta afectada conservó su solicitud pendiente. En el caso revocado
se renovó automáticamente una sesión y se completaron las 50 sin retener el primer
lote de 49. En las cinco ejecuciones no se observaron cruces de identidad ni POST
repetidos para tickets que el proveedor ya había emitido.

## Verificación y límites

La suite final terminó con **94 pruebas aprobadas, cero fallos y cero omitidas**,
incluida la integración de PostgreSQL, recuperación de sesiones, prioridad, cancelación,
deduplicación y rechazo de comprobaciones caducadas o invalidadas.

La suite de cuatro escenarios se midió antes del último ajuste de rotación ante 401.
El caso complementario de token revocado y las 94 pruebas se ejecutaron con ese ajuste.
Los JSON incluyen los hashes de las fuentes realmente ejecutadas para distinguir
esas revisiones; todos parten del commit base indicado y sus modificaciones locales.

Para obtener este beneficio hay que tener la cola preparada con anticipación.
Una incorporación a última hora o credenciales inexistentes no permiten adelantar
las comprobaciones necesarias. La cola no equivale a un ticket institucional.

Estos resultados prueban el comportamiento del motor en los escenarios descritos.
No miden TLS, latencia entre Railway y UNAB, restricciones por IP, WAF, competidores
ni las transacciones internas de la institución. No garantizan 50 reservas reales
antes de tres segundos si la institución tarda más, rechaza las peticiones o agota
los cupos antes de recibirlas. Los límites 429/403 y las pausas institucionales siguen
vigentes. La prueba representa una apertura de cena; la carga real de cada servicio
requiere observar sus propios registros de envío y confirmación.

## Reproducción y evidencia

```sh
node simulation/opening-50.js --scenario window-suite --postgres-config /ruta/privada/config.json --output /tmp/window-after.json
node simulation/opening-50.js --scenario window-revoked-probe --postgres-config /ruta/privada/config.json --output /tmp/window-revoked-probe.json
```

Usar exclusivamente PostgreSQL de pruebas, nunca una conexión de producción.
El simulador crea y elimina una base aislada por caso.

- [Instrucciones](../simulation/README.md)
- [Medición previa que reproduce el fallo](window-before.json)
- [Cuatro escenarios tras el refuerzo](window-after.json)
- [Contingencia de token revocado](window-revoked-probe.json)
- [Simulación inicial de saturación y capacidad](simulation-50.md)
