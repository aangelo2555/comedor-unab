# Simulación de apertura para 50 alumnos

Ejecuta el servidor de la aplicación en un proceso aislado, con 50 cuentas ficticias
y JWT firmados distintos, frente a una institución simulada por HTTP local.
El wrapper de `fetch` impide contactar a UNAB u otros destinos externos.
No usa cuentas ni credenciales reales ni modifica la base de producción.

```sh
node simulation/opening-50.js --output /tmp/simulation-50.json
```

Para usar PostgreSQL local aislado, crea un archivo privado de configuración con
`PGHOST`, `PGPORT`, `PGUSER`, `PGPASSWORD`, `PGDATABASE`; el usuario debe poder crear
y borrar bases de datos de prueba. El simulador crea una base distinta por escenario
y la elimina al terminar. No uses una conexión de producción.

```sh
node simulation/opening-50.js --postgres-config /ruta/privada/config.json --output /tmp/simulation-50.json
```

Escenarios: `--scenario healthy`, `mixed`, `capacity`, `throttled` o `all` (predeterminado).
La apertura ocurre a los 35 segundos; la recuperación se observa hasta 120 segundos
después de ella. Se conservan los límites ordinarios de 2 solicitudes concurrentes
y 500 ms entre inicios, y el permiso especial de apertura de hasta 50 POST.
`--quick` reduce los tiempos y la limitación ordinaria; sirve para comprobar el
simulador, **no para comparar rendimiento con producción**.

La suite `--scenario window-suite` comprueba una ventana de cupos de solo **3500 ms**:

- `window`: 50 alumnos con sesiones válidas.
- `window-stress`: 50 alumnos, cinco tokens vencidos, consultas previas de tickets
  de 2800 ms, publicación de 1000 ms y confirmaciones de 2000 ms. Comienza 95 s antes.
- `window-probe-slow`: la consulta que detecta la publicación tarda 2800 ms.
- `window-missing`: la primera cuenta no tiene credenciales; las otras 49 deben
  poder reservar sin esperar a que esa cuenta se autentique.

Estos escenarios rechazan los POST recibidos después de la ventana, aunque todavía
queden cupos en el modelo. Se observan durante un máximo de 20 s desde la apertura.
`--lead-seconds N` permite cambiar la anticipación para una prueba específica.
El informe distingue los inicios de envío en el cliente de las llegadas al proveedor
y de las confirmaciones. Una confirmación posterior al cierre puede corresponder a
un POST aceptado antes del cierre.

Se comprueba la firma y caducidad del JWT, su identidad, la coincidencia de cookie
y bearer, la propiedad de los tickets, la ausencia de POST repetidos para tickets
ya emitidos y la conservación de solicitudes pendientes. El informe no guarda
contraseñas, claves de firma ni JWT completos.

El reloj lógico se desplaza a una apertura de cena. Los temporizadores y sockets
son reales. El simulador observa módulos del servidor dentro del proceso de prueba;
no cambia los archivos de producción para exponer endpoints de diagnóstico.
No reproduce navegadores, TLS, distancia a UNAB, WAF, restricciones por IP ni las
reglas internas desconocidas del servidor institucional. Los resultados representan
los escenarios declarados, no la capacidad real de UNAB ni una garantía de reservas.


El caso complementario `--scenario window-revoked-probe` revoca el token del primer
alumno justo al consultar la publicación. Debe cambiarse de cuenta para detectar la
apertura y recuperarse la cuenta afectada sin retener los otros 49 primeros envíos.
