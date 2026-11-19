# 🍽️ Comedor UNAB · Sistema de Reservas & Francotirador (SaaS)

Sistema web con arquitectura **Frontend + Backend** listo para despliegue en **Railway (railway.app)**, diseñado con un estilo **minimalista profesional (sin efectos neón)**, control de usuarios con roles (**SuperAdmin** y **Estudiante**), generación de **código QR oficial** y motor automatizado de reservas a las **17:00:00 (5:00 PM)** con consumo ultra-bajo de memoria RAM (< 50 MB).

---

## 🚀 Despliegue en Railway (3 Pasos)

El proyecto incluye todos los archivos de configuración requeridos por Railway (`Dockerfile`, `package.json`, `railway.json`):

### Opción A: Despliegue vía GitHub (Recomendado)
1. Sube esta carpeta a tu repositorio de GitHub (ejemplo: `mi-comedor-unab`).
2. En tu cuenta de [Railway.app](https://railway.app), haz clic en **"New Project"** -> **"Deploy from GitHub repo"**.
3. Selecciona tu repositorio. Railway detectará automáticamente el `Dockerfile` optimizado y levantará la aplicación.

### Opción B: Despliegue vía Railway CLI
```bash
railway login
railway init
railway up
```

---

## 💻 Ejecución Local en Windows

Haz doble clic en:
👉 **[`iniciar_portal.bat`](file:///c:/Users/aange/OneDrive/Escritorio/comedor%20unab%20almuero/iniciar_portal.bat)**

El navegador se abrirá automáticamente en:
👉 **`http://localhost:3000`**

---

## 🔑 Credenciales Iniciales

### 1. Panel de SuperAdministrador:
* **Usuario:** `admin`
* **Contraseña:** `admin12345`

### 2. Panel de Alumno (Angelo):
* **Usuario:** `222.0113.028`
* **Contraseña:** `Dotamipasion12345`
* **Alumno:** `SERNA SIMEON, ANGELO THOMAS` (DNI: `76448557`)

*(En la pantalla de inicio de sesión hay dos botones de acceso rápido para ingresar con 1 clic a cualquiera de los dos roles).*

---

## 🌟 Funcionalidades por Rol

### 🛡️ Panel de SuperAdmin
1. **Gestión de Alumnos / Usuarios:**
   - Alta de nuevos alumnos con su código UNAB, contraseña, DNI y sede.
   - Activación o desactivación de cuentas.
   - Interruptor individual de auto-reserva (Francotirador 17:00).
   - Eliminación de usuarios.
2. **Francotirador Centralizado Masivo:**
   - Cuenta regresiva a las 17:00:00 sincronizada con hora de Lima.
   - Disparo masivo automático o forzado que reserva almuerzos para todos los alumnos activos en paralelo.
   - Terminal de registro de solicitudes en tiempo real.
3. **Auditoría Global de Reservas:**
   - Registro de todos los tickets generados por cualquier estudiante, con ID de reserva y fecha.
4. **Métricas del Servidor & Memoria RAM:**
   - Visualización del uso de RAM (RSS ~45MB, Heap ~8MB).
   - Monitoreo del contenedor en Railway y sesiones activas.

### 👤 Panel de Alumno
1. **Auto-Reserva 17:00:00 (Francotirador Personal):**
   - Configuración de comida preferida (`ALMUERZO`, `CENA`, `DESAYUNO`).
   - Cuenta regresiva milisegundo a milisegundo hasta las 17:00:00.
2. **Menú & Disponibilidad en Tiempo Real:**
   - Consulta de cupos libres y becarios.
   - Indicador visual claro cuando un plato está agotado (**"SIN PLATOS DISPONIBLES"**).
   - Reserva manual en 1 clic.
3. **Mis Reservas & Código QR Oficial (Imagen 3):**
   - Muestra los tickets activos con el **Código QR oficial** renderizado con alto contraste y color institucional (`#07406b`).
   - **Pase Digital en Pantalla Completa:** Tarjeta lista para mostrar al lector del comedor o ventanilla de atención.
   - Opción para anular la reserva y liberar el cupo.
4. **Ficha de Asistencias:**
   - Contador de inasistencias (0 / 3) y estado de habilitación de matrícula.

---

## ⚡ Rendimiento y Consumo de Memoria

* **Consumo de RAM en reposo:** ~38 MB - 50 MB (ideal para el plan gratuito de Railway con 512 MB).
* **Dependencias:** APIs nativas de Node.js y el controlador `pg` para PostgreSQL.
* **Estilo Visual:** Limpio, minimalista, paleta corporativa universitaria (blanco, gris pizarra, azul marino `#07406b`), **completamente libre de neón**.

## Desarrollo y pruebas de concurrencia

Ejecuta `node --test tests/*.test.js` desde la raíz del proyecto. Las pruebas simulan UNAB e incluyen 100 alumnos en los tres servicios durante dos fechas, saturación, autenticaciones fallidas, pérdida de respuestas, cancelación y conservación de solicitudes activas.

El servidor comparte un presupuesto de peticiones para autenticación, consultas y reservas. Estos valores iniciales son configurables mediante variables de entorno.

| Variable | Valor inicial | Función |
| --- | --- | --- |
| `UNAB_MAX_CONCURRENCY` | `2` | Máximo de peticiones simultáneas a UNAB por proceso |
| `UNAB_REQUEST_INTERVAL_MS` | `500` | Separación mínima entre inicios de peticiones |

Se respeta `Retry-After` ante saturación. Sin esa cabecera, los fallos temporales generan esperas crecientes. Una respuesta 403 pausa las peticiones durante un minuto. Las reservas consultan los tickets existentes antes de enviarse y después de una respuesta incierta.

El control de concurrencia y la exclusión de reservas compartidas funcionan dentro de un proceso. La caché de trabajo y estos bloqueos requieren una sola instancia de `node server.js`. Varias réplicas requieren almacenamiento y coordinación compartidos. Los valores iniciales son una decisión local y deben ajustarse a los límites autorizados por UNAB.

La simulación acelera la separación entre peticiones. Su duración mide la prueba local. La capacidad y los tiempos reales dependen de UNAB, y una respuesta perdida puede requerir reconciliación posterior.

## Premium por ciclo

El alumno selecciona sus comidas en el modal y pasa a la hoja final de pago. El servicio cuesta S/ 9 por ciclo, mediante Yape al 923887478. El número de operación y la selección quedan pendientes de revisión. En Gestión de Alumnos, el administrador verifica el abono, confirma el pago y fija el último día del ciclo antes de activar Premium. La tarea de mantenimiento genera solicitudes para el día actual de Lima y las renueva al comenzar cada día hasta la fecha inclusiva del ciclo. Una cita anulada o pausada se conserva para evitar recrearla ese mismo día.

La cola procesa primero a los alumnos Premium y mantiene el orden original de registro dentro de cada grupo. Un fallo de autenticación conserva la solicitud y registra un aviso periódico con el estado de UNAB.

Antes del cierre se comprueba nuevamente el estado remoto del ticket. Solo los tickets que UNAB devuelve como `ACTIVA` son candidatos a anulación. Las operaciones de comprobación y cancelación tienen prioridad en el presupuesto de peticiones. El margen inicial es de 40 segundos, ampliado según la cantidad de tickets y el intervalo configurado. Con 100 tickets y el intervalo inicial, el proceso comienza cuatro minutos antes del cierre. La anulación requiere confirmación remota. Interrupciones de UNAB o una máquina detenida pueden impedir completarla a tiempo.

Las preferencias y las solicitudes sobreviven al reinicio en PostgreSQL cuando está configurado. El proceso debe mantenerse ejecutándose para generar las solicitudes y cancelar tickets. El modal informa al alumno de la cancelación preventiva y permite quitar servicios futuros.

## PostgreSQL y contenedores

Instala las dependencias con `npm ci`. Configura `DATABASE_URL` con la conexión PostgreSQL o las variables estándar `PGHOST`, `PGPORT`, `PGDATABASE`, `PGUSER` y `PGPASSWORD`. El arranque crea la tabla `comedor_state` y guarda el estado de aplicación en JSONB, incluidos alumnos, tickets, solicitudes, pagos, preferencias, auditoría y sesiones. Los tokens de sesión se guardan como hashes SHA-256.

Cuando la tabla está vacía, se importa el archivo `database.json` existente en `DATA_DIR`, cuyo valor inicial es `data/`. Cuando PostgreSQL ya contiene datos, conserva ese estado al desplegar una imagen nueva. Las respuestas de escritura esperan confirmación del guardado. La revisión del registro impide que otra instancia sobrescriba silenciosamente un estado más reciente. Configura una sola réplica.

La aplicación exige PostgreSQL en producción. El desarrollo local mantiene la compatibilidad con JSON si no se configura una conexión. Los datos que se perdieron en contenedores anteriores requieren un respaldo para recuperarse. La pantalla de respaldo de administración permite exportar y restaurar JSON.

### Docker Compose

Configura `POSTGRES_PASSWORD`, `ADMIN_EMAIL` y `ADMIN_PASSWORD` como variables seguras de tu terminal o en un archivo de entorno privado. Ejecuta `docker compose up --build -d`. Se crean PostgreSQL, su volumen persistente y la aplicación, que espera la disponibilidad de la base. El servicio responde en el puerto 3000. `APP_PORT` permite cambiar el puerto local.

`docker compose down` conserva el volumen. La opción `--volumes` elimina sus datos y debe reservarse para entornos descartables.

### Railway

Crea un servicio PostgreSQL dentro del mismo proyecto y enlaza su variable `DATABASE_URL` con la aplicación mediante una referencia de Railway. El servicio PostgreSQL requiere su volumen persistente. El Dockerfile construye la aplicación y Railway administra el servicio de base de datos por separado. La configuración del repositorio establece una réplica y la comprobación `/healthz`.

Conserva un respaldo del despliegue actual antes de reemplazarlo. El archivo de un contenedor efímero pertenece a ese contenedor. La importación automática solo puede usar archivos que estén disponibles al iniciar la aplicación nueva. Para restaurar un respaldo en PostgreSQL, utiliza la función de restauración de administración después de enlazar la conexión.

### Pruebas de persistencia

Ejecuta `node --test tests/*.test.js` para las pruebas generales. Para la integración real de PostgreSQL, define `PG_TEST_CONFIG` con la ruta a un archivo JSON privado con las variables `PGHOST`, `PGPORT`, `PGDATABASE`, `PGUSER` y `PGPASSWORD` de una instancia de prueba. Ejecuta `node --test tests/postgres.test.js`. La prueba crea y elimina una base aislada y necesita permiso para esas operaciones. Comprueba migración, sesiones, solicitudes y pagos después de interrupciones abruptas del proceso.
